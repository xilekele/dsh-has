/**
 * Minimal TrueType font reader: just enough metrics and character mapping to
 * embed a CJK font into a generated PDF.
 *
 * Only the tables a PDF FontFile2 embedding needs are parsed: `head` (units,
 * bounding box), `hhea`/`hmtx` (advance widths), `maxp` (glyph count) and
 * `cmap` (Unicode code point to glyph id). The font program itself is copied
 * byte for byte.
 */

import fs from 'node:fs/promises';

const HEAD = 18; // unitsPerEm byte offset inside head

/** Read every table record from the sfnt offset table. */
function readTableDirectory(buffer) {
  const sfnt = buffer.readUInt32BE(0);
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565 && sfnt !== 0x4f54544f) {
    throw new Error(`Unsupported font format (sfnt tag 0x${sfnt.toString(16)})`);
  }
  const numTables = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const base = 12 + index * 16;
    const tag = buffer.toString('latin1', base, base + 4);
    const offset = buffer.readUInt32BE(base + 8);
    const length = buffer.readUInt32BE(base + 12);
    tables.set(tag, { offset, length });
  }
  return tables;
}

/** Parse a format 4 cmap subtable into a code point to glyph id map. */
function parseCmapFormat4(buffer, offset, map) {
  const segCount = buffer.readUInt16BE(offset + 6) / 2;
  const endBase = offset + 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  for (let segment = 0; segment < segCount; segment += 1) {
    const end = buffer.readUInt16BE(endBase + segment * 2);
    const start = buffer.readUInt16BE(startBase + segment * 2);
    if (start === 0xffff && end === 0xffff) continue;
    const delta = buffer.readInt16BE(deltaBase + segment * 2);
    const rangeOffset = buffer.readUInt16BE(rangeBase + segment * 2);
    for (let code = start; code <= end && code !== 0x10000; code += 1) {
      let glyphId;
      if (rangeOffset === 0) {
        glyphId = (code + delta) & 0xffff;
      } else {
        const glyphOffset = rangeBase + segment * 2 + rangeOffset + (code - start) * 2;
        if (glyphOffset + 2 > buffer.length) continue;
        glyphId = buffer.readUInt16BE(glyphOffset);
        if (glyphId !== 0) glyphId = (glyphId + delta) & 0xffff;
      }
      if (glyphId) map.set(code, glyphId);
    }
  }
}

/** Parse a format 12 cmap subtable (full Unicode range) into the shared map. */
function parseCmapFormat12(buffer, offset, map) {
  const groups = buffer.readUInt32BE(offset + 12);
  for (let group = 0; group < groups; group += 1) {
    const base = offset + 16 + group * 12;
    const start = buffer.readUInt32BE(base);
    const end = buffer.readUInt32BE(base + 4);
    const startGlyph = buffer.readUInt32BE(base + 8);
    for (let code = start; code <= end && code <= 0x10ffff; code += 1) {
      map.set(code, startGlyph + (code - start));
    }
  }
}

/** Build the Unicode to glyph map, preferring a full-Unicode subtable. */
function readCmap(buffer, tables) {
  const entry = tables.get('cmap');
  if (!entry) throw new Error('Font has no cmap table');
  const count = buffer.readUInt16BE(entry.offset + 2);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const base = entry.offset + 4 + index * 8;
    const platform = buffer.readUInt16BE(base);
    const encoding = buffer.readUInt16BE(base + 2);
    const subtable = entry.offset + buffer.readUInt32BE(base + 4);
    const format = buffer.readUInt16BE(subtable);
    if (format !== 4 && format !== 12) continue;
    const rank = format === 12 ? 0 : platform === 3 ? 1 : 2;
    candidates.push({ format, subtable, rank, platform, encoding });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  const map = new Map();
  for (const candidate of candidates) {
    if (candidate.format === 4) parseCmapFormat4(buffer, candidate.subtable, map);
    else parseCmapFormat12(buffer, candidate.subtable, map);
    if (map.size > 0) return map;
  }
  return map;
}

/**
 * Load a TrueType font from disk (or from an in-memory buffer) and expose the
 * metrics needed to embed it: glyph lookup, advance widths and the raw bytes.
 */
export async function loadFont(source) {
  const buffer = Buffer.isBuffer(source) ? source : await fs.readFile(source);
  const tables = readTableDirectory(buffer);

  const head = tables.get('head');
  if (!head) throw new Error('Font has no head table');
  const unitsPerEm = buffer.readUInt16BE(head.offset + HEAD) || 1000;
  const bbox = [
    buffer.readInt16BE(head.offset + 36),
    buffer.readInt16BE(head.offset + 38),
    buffer.readInt16BE(head.offset + 40),
    buffer.readInt16BE(head.offset + 42),
  ];

  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  if (!hhea || !hmtx) throw new Error('Font has no horizontal metrics');
  const numberOfHMetrics = buffer.readUInt16BE(hhea.offset + 34);

  const maxp = tables.get('maxp');
  const numGlyphs = maxp ? buffer.readUInt16BE(maxp.offset + 4) : numberOfHMetrics;

  const cmap = readCmap(buffer, tables);

  /** Advance width of a glyph in font units. */
  function advanceWidth(glyphId) {
    const index = Math.min(glyphId, numberOfHMetrics - 1);
    return buffer.readUInt16BE(hmtx.offset + index * 4);
  }

  /** Glyph id for a Unicode code point, or 0 when the font lacks it. */
  function glyphForChar(codePoint) {
    return cmap.get(codePoint) ?? 0;
  }

  return {
    buffer,
    unitsPerEm,
    bbox,
    numGlyphs,
    advanceWidth,
    glyphForChar,
    hasChar: (codePoint) => cmap.has(codePoint),
  };
}

/**
 * Find a usable CJK-capable font on this machine. TTC collections are skipped
 * because they cannot be embedded without extracting a sub-font.
 */
export async function findCjkFont(candidates) {
  for (const candidate of candidates) {
    try {
      const font = await loadFont(candidate);
      if (font.glyphForChar(0x4e2d)) return { font, path: candidate };
    } catch {
      // Try the next candidate; a broken font file is not fatal.
    }
  }
  return null;
}

export const CJK_FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\Deng.ttf',
  'C:\\Windows\\Fonts\\simkai.ttf',
  'C:\\Windows\\Fonts\\simfang.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/PingFang.ttc',
];
