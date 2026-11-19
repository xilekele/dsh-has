/**
 * Small PDF writer used to rebuild anonymized / restored documents.
 *
 * It draws plain text only: one font (an embedded TrueType CJK face), no
 * graphics, no images. That is enough for documents whose value is their text
 * — the source layout is approximated by re-wrapping the anonymized text with
 * the same page geometry.
 */

import zlib from 'node:zlib';

function hex4(value) {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** Unicode code point as UTF-16BE hex, the form PDF ToUnicode expects. */
function utf16Hex(codePoint) {
  if (codePoint <= 0xffff) return hex4(codePoint);
  const offset = codePoint - 0x10000;
  return hex4(0xd800 + (offset >> 10)) + hex4(0xdc00 + (offset & 0x3ff));
}

/** Width of `text` in points for the given font and size. */
export function measureText(font, size, text) {
  let width = 0;
  for (const char of text) {
    const glyph = font.glyphForChar(char.codePointAt(0));
    width += (font.advanceWidth(glyph) / font.unitsPerEm) * size;
  }
  return width;
}

const NO_LINE_START = new Set('，。、；：？！）》」』】,.;:?!)]}');

/**
 * Greedy wrap that keeps punctuation off line starts and never splits an entity
 * tag: a tag such as `<人名[1].姓名.全名>` is one unit, because a tag broken
 * across lines would no longer match its mapping key when restoring.
 */
export function wrapLine(font, size, text, maxWidth) {
  const units = text.match(/<[^<>]*>|[\s\S]/gu) ?? [];
  const advanceOf = (unit) => {
    let width = 0;
    for (const char of unit) {
      const glyph = font.glyphForChar(char.codePointAt(0));
      width += (font.advanceWidth(glyph) / font.unitsPerEm) * size;
    }
    return width;
  };

  const lines = [];
  let current = '';
  let width = 0;
  for (const unit of units) {
    const advance = advanceOf(unit);
    if (current && width + advance > maxWidth) {
      const isTag = unit.startsWith('<') && unit.endsWith('>');
      if (!isTag && NO_LINE_START.has(unit) && current.length > 1) {
        // Pull the last character down so punctuation does not start a line.
        const last = [...current].pop();
        const lastAdvance = advanceOf(last);
        current = current.slice(0, -last.length);
        lines.push(current);
        current = last + unit;
        width = lastAdvance + advance;
        continue;
      }
      lines.push(current);
      current = unit;
      width = advance;
      continue;
    }
    current += unit;
    width += advance;
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Lay plain text out on pages of the given geometry.
 * Text is split into paragraphs on newlines, then wrapped to the text width.
 */
export function layoutText(font, text, { width = 595.32, height = 841.92, fontSize = 15, margin = 72, leading } = {}) {
  const lineHeight = leading ?? Math.round(fontSize * 1.6);
  const maxWidth = width - margin * 2;
  const pages = [];
  let page = { width, height, lines: [] };
  pages.push(page);
  let y = height - margin;

  const paragraphs = text.replace(/\r\n/g, '\n').split('\n');
  for (const paragraph of paragraphs) {
    const wrapped = paragraph ? wrapLine(font, fontSize, paragraph, maxWidth) : [''];
    for (const line of wrapped) {
      if (y < margin) {
        page = { width, height, lines: [] };
        pages.push(page);
        y = height - margin;
      }
      page.lines.push({ x: margin, y, size: fontSize, text: line });
      y -= lineHeight;
    }
  }
  return pages;
}

/** Serialize a document described by `pages` and an embedded font. */
export function buildPdf({ pages, font, title = 'dsh-has' }) {
  const usedGlyphs = new Map(); // glyph id -> code point
  const usedCodes = new Set();

  for (const page of pages) {
    for (const line of page.lines) {
      for (const char of line.text) {
        const codePoint = char.codePointAt(0);
        const glyph = font.glyphForChar(codePoint);
        usedCodes.add(codePoint);
        if (!usedGlyphs.has(glyph)) usedGlyphs.set(glyph, codePoint);
      }
    }
  }

  const glyphIds = [...usedGlyphs.keys()].sort((a, b) => a - b);
  const widths = glyphIds
    .map((glyph) => `${glyph} [${Math.round((font.advanceWidth(glyph) / font.unitsPerEm) * 1000)}]`)
    .join(' ');

  const bfchar = glyphIds.map((glyph) => `<${hex4(glyph)}> <${utf16Hex(usedGlyphs.get(glyph))}>`);
  const cmapChunks = [];
  for (let index = 0; index < bfchar.length; index += 100) {
    cmapChunks.push(bfchar.slice(index, index + 100));
  }
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...cmapChunks.map((chunk) => [`${chunk.length} beginbfchar`, ...chunk, 'endbfchar'].join('\n')),
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');

  const contentStreams = pages.map((page) => {
    const parts = [];
    for (const line of page.lines) {
      let hex = '';
      for (const char of line.text) {
        hex += hex4(font.glyphForChar(char.codePointAt(0)));
      }
      parts.push(`BT\n/Fc ${line.size} Tf\n1 0 0 1 ${line.x.toFixed(2)} ${line.y.toFixed(2)} Tm\n<${hex}> Tj\nET`);
    }
    return Buffer.from(parts.join('\n'), 'latin1');
  });

  const fontProgram = zlib.deflateSync(font.buffer);

  // Object numbering: 1 catalog, 2 pages, 3 font, 4 descendant, 5 descriptor,
  // 6 font file, 7 ToUnicode, then [page, content] pairs.
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    chunks.push(buffer);
    length += buffer.length;
  };
  // Every PDF must start with the header; viewers refuse the file without it.
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const beginObj = (id) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
  };
  const endObj = () => push('endobj\n');
  const stream = (id, dict, data) => {
    beginObj(id);
    push(`<< ${dict} /Length ${data.length} >>\nstream\n`);
    push(data);
    push('\nendstream\n');
    endObj();
  };

  const firstPage = 8;
  const pageIds = pages.map((_, index) => firstPage + index * 2);
  const totalObjects = firstPage + pages.length * 2 - 1;

  beginObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();

  beginObj(2);
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>\n`);
  endObj();

  beginObj(3);
  push('<< /Type /Font /Subtype /Type0 /BaseFont /HaSFont /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 7 0 R >>\n');
  endObj();

  beginObj(4);
  push(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /HaSFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>\n`,
  );
  endObj();

  beginObj(5);
  push(
    `<< /Type /FontDescriptor /FontName /HaSFont /Flags 4 /FontBBox [${font.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${font.bbox[3]} /Descent ${font.bbox[1]} /CapHeight ${font.bbox[3]} /StemV 80 /FontFile2 6 0 R >>\n`,
  );
  endObj();

  stream(6, `/Length1 ${font.buffer.length} /Filter /FlateDecode`, fontProgram);
  stream(7, '', Buffer.from(toUnicode, 'latin1'));

  pages.forEach((page, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    beginObj(pageId);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}] /Resources << /Font << /Fc 3 0 R >> /ProcSet [/PDF /Text] >> /Contents ${contentId} 0 R >>\n`,
    );
    endObj();
    stream(contentId, '', contentStreams[index]);
  });

  const infoId = totalObjects + 1;
  const infoTitle = title.replace(/[()\\]/g, '');
  beginObj(infoId);
  push(`<< /Title (${infoTitle}) /Producer (dsh-has) >>\n`);
  endObj();

  const size = infoId + 1;
  const xrefOffset = length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id += 1) {
    push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}
