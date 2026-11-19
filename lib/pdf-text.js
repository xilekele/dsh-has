/**
 * Text extraction for `PdfDocument`: walks page content streams, tracks the
 * text matrix, and returns positioned text runs grouped into lines.
 */

import { PdfDocument } from './pdf-parse.js';

const isName = (value) => value && typeof value === 'object' && 'value' in value && !(value instanceof Map);

function rawName(value) {
  return value && typeof value === 'object' && 'value' in value && !(value instanceof Map) ? value.value : value;
}

/** Split a shown string into character codes for the given font. */
function decodeCodes(bytes, font) {
  const codes = [];
  if (font.twoByte) {
    for (let index = 0; index + 1 < bytes.length; index += 2) codes.push(bytes.readUInt16BE(index));
  } else {
    for (let index = 0; index < bytes.length; index += 1) codes.push(bytes[index]);
  }
  return codes;
}

function buildWidthLookup(doc, fontDict) {
  const subtype = String(rawName(doc.resolve(fontDict.get('Subtype')) ?? ''));
  if (subtype === 'Type0') {
    const descendants = doc.resolve(fontDict.get('DescendantFonts'));
    const descendant = Array.isArray(descendants) ? doc.resolve(descendants[0]) : null;
    const widths = new Map();
    const w = descendant && descendant instanceof Map ? doc.resolve(descendant.get('W')) : null;
    if (Array.isArray(w)) {
      for (let index = 0; index < w.length; ) {
        const first = doc.resolve(w[index]);
        const second = doc.resolve(w[index + 1]);
        if (Array.isArray(second)) {
          second.forEach((width, offset) => widths.set(Number(first) + offset, Number(doc.resolve(width))));
          index += 2;
        } else {
          const last = Number(second);
          const width = Number(doc.resolve(w[index + 2]));
          for (let code = Number(first); code <= last && code - Number(first) < 65536; code += 1) widths.set(code, width);
          index += 3;
        }
      }
    }
    const dw = descendant && descendant instanceof Map ? doc.resolve(descendant.get('DW')) : null;
    return { widths, defaultWidth: typeof dw === 'number' ? dw : 1000, twoByte: true };
  }
  const widths = new Map();
  const firstChar = doc.resolve(fontDict.get('FirstChar'));
  const w = doc.resolve(fontDict.get('Widths'));
  if (Array.isArray(w)) w.forEach((width, offset) => widths.set(Number(firstChar ?? 0) + offset, Number(doc.resolve(width))));
  const descriptor = doc.resolve(fontDict.get('FontDescriptor'));
  const missing = descriptor instanceof Map ? doc.resolve(descriptor.get('MissingWidth')) : null;
  return { widths, defaultWidth: typeof missing === 'number' && missing > 0 ? missing : 500, twoByte: false };
}

function buildFont(doc, fontRef, cache) {
  const key = fontRef && fontRef.num !== undefined ? fontRef.num : null;
  if (key !== null && cache.has(key)) return cache.get(key);
  const fontDict = doc.resolve(fontRef);
  if (!(fontDict instanceof Map)) return null;
  const toUnicodeRef = fontDict.get('ToUnicode');
  const toUnicode = toUnicodeRef ? parseCmap(doc.streamOf(toUnicodeRef)) : null;
  const metrics = buildWidthLookup(doc, fontDict);
  const font = {
    toUnicode,
    widths: metrics.widths,
    defaultWidth: metrics.defaultWidth,
    twoByte: metrics.twoByte,
    baseFont: String(rawName(doc.resolve(fontDict.get('BaseFont')) ?? '')),
  };
  if (key !== null) cache.set(key, font);
  return font;
}

function parseCmap(data) {
  if (!data) return null;
  const text = data.toString('latin1');
  const map = new Map();
  const hexToText = (hex) => {
    const clean = hex.length % 2 ? hex + '0' : hex;
    const buffer = Buffer.from(clean, 'hex');
    let out = '';
    for (let index = 0; index + 1 < buffer.length; index += 2) out += String.fromCharCode(buffer.readUInt16BE(index));
    return out || String.fromCharCode(buffer[0] ?? 0);
  };

  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const pair of block.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) ?? []) {
      const [, src, dst] = pair.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      map.set(parseInt(src, 16), hexToText(dst));
    }
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const lineRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    let line;
    while ((line = lineRe.exec(block))) {
      const start = parseInt(line[1], 16);
      const end = parseInt(line[2], 16);
      if (line[3]) {
        const base = parseInt(line[3], 16);
        for (let code = start; code <= end && code - start < 65536; code += 1) {
          map.set(code, hexToText((base + (code - start)).toString(16)));
        }
      } else if (line[4]) {
        const items = [...line[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((item) => hexToText(item[1]));
        items.forEach((item, index) => map.set(start + index, item));
      }
    }
  }
  return map;
}

/* --------------------------------------------------------- content walking */

function tokenizeContent(content) {
  const tokens = [];
  let index = 0;
  while (index < content.length) {
    const ch = content[index];
    if (ch === '%') {
      while (index < content.length && content[index] !== '\n') index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === '(') {
      const lexer = new ContentLexer(content, index);
      tokens.push({ type: 'string', value: lexer.readLiteralString() });
      index = lexer.pos;
      continue;
    }
    if (ch === '<' && content[index + 1] !== '<') {
      const lexer = new ContentLexer(content, index);
      tokens.push({ type: 'string', value: lexer.readHexString() });
      index = lexer.pos;
      continue;
    }
    if (ch === '<' && content[index + 1] === '<') {
      // Inline dict (e.g. BDC properties): skip to matching ">>".
      let depth = 0;
      let cursor = index;
      while (cursor < content.length) {
        if (content.startsWith('<<', cursor)) {
          depth += 1;
          cursor += 2;
        } else if (content.startsWith('>>', cursor)) {
          depth -= 1;
          cursor += 2;
          if (depth === 0) break;
        } else cursor += 1;
      }
      index = cursor;
      continue;
    }
    if (ch === '[' || ch === ']') {
      tokens.push({ type: ch === '[' ? 'arrayStart' : 'arrayEnd' });
      index += 1;
      continue;
    }
    if (ch === '/') {
      let end = index + 1;
      while (end < content.length) {
        const c = content[end];
        if (/[\s()<>\[\]{}\/%]/.test(c)) break;
        end += 1;
      }
      tokens.push({ type: 'name', value: content.slice(index + 1, end) });
      index = end;
      continue;
    }
    const match = /^[^\s()<>\[\]{}\/%]+/.exec(content.slice(index));
    if (!match) {
      index += 1;
      continue;
    }
    const word = match[0];
    index += word.length;
    if (word === 'ID') {
      // Inline image: skip binary data up to EI.
      const end = content.indexOf('EI', index);
      index = end < 0 ? content.length : end + 2;
      continue;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ type: 'number', value: Number(word) });
    else if (word.startsWith('/')) tokens.push({ type: 'name', value: word.slice(1) });
    else tokens.push({ type: 'operator', value: word });
  }
  return tokens;
}

class ContentLexer {
  constructor(text, pos) {
    this.text = text;
    this.pos = pos;
  }

  readLiteralString() {
    let depth = 0;
    this.pos += 1;
    const bytes = [];
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '\\') {
        const next = this.text[this.pos + 1];
        this.pos += 2;
        if (next === 'n') bytes.push(0x0a);
        else if (next === 'r') bytes.push(0x0d);
        else if (next === 't') bytes.push(0x09);
        else if (next === 'b') bytes.push(0x08);
        else if (next === 'f') bytes.push(0x0c);
        else if (next === '\r') {
          if (this.text[this.pos] === '\n') this.pos += 1;
        } else if (next === '\n') {
          /* line continuation */
        } else if (next >= '0' && next <= '7') {
          let octal = next;
          while (octal.length < 3 && this.text[this.pos] >= '0' && this.text[this.pos] <= '7') {
            octal += this.text[this.pos];
            this.pos += 1;
          }
          bytes.push(parseInt(octal, 8) & 0xff);
        } else if (next !== undefined) bytes.push(next.charCodeAt(0) & 0xff);
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') {
        if (depth === 0) {
          this.pos += 1;
          break;
        }
        depth -= 1;
      }
      bytes.push(ch.charCodeAt(0) & 0xff);
      this.pos += 1;
    }
    return Buffer.from(bytes);
  }

  readHexString() {
    this.pos += 1;
    let hex = '';
    while (this.pos < this.text.length && this.text[this.pos] !== '>') {
      const ch = this.text[this.pos];
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
      this.pos += 1;
    }
    this.pos += 1;
    if (hex.length % 2) hex += '0';
    return Buffer.from(hex, 'hex');
  }
}

/* -------------------------------------------------------------- extraction */



export function extractDocument(buffer) {
  const doc = new PdfDocument(buffer);
  const fontCache = new Map();
  const pages = [];

  for (const page of doc.pages()) {
    const mediaBox = doc.inherited(page.dict, 'MediaBox') ?? [0, 0, 612, 792];
    const box = mediaBox.map((value) => Number(doc.resolve(value)));
    const width = box[2] - box[0] || 612;
    const height = box[3] - box[1] || 792;

    const resources = doc.inherited(page.dict, 'Resources');
    const fontDict = resources instanceof Map ? doc.resolve(resources.get('Font')) : null;
    const fonts = new Map();
    if (fontDict instanceof Map) for (const [name, ref] of fontDict) fonts.set(name, buildFont(doc, ref, fontCache));

    const content = doc.pageContent(page.dict);
    const runs = walkContent(doc, content, fonts);

    pages.push({ width, height, originX: box[0], originY: box[1], runs, lines: groupRunsIntoLines(runs) });
  }

  return { pages, text: pages.map((page) => pageToText(page)).join('\n\n') };
}

/**
 * Join the visual lines of one page into paragraphs.
 *
 * A line that reaches the right edge of the text block is a soft wrap and is
 * joined with the next line; a shorter line ends a paragraph. Without this,
 * entity names split by line wrapping (for example `上海云图信息技术有` /
 * `限公司`) never look like one entity to the model.
 */
function pageToText(page) {
  const lines = page.lines;
  if (!lines.length) return '';
  const paragraphs = [];
  let current = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    current += line.text;
    const continues =
      next &&
      !/[。！？!?：:]["”』」)）]?$/.test(line.text.trim()) &&
      next.x <= line.x + Math.max(2, line.size * 0.5);
    if (!continues) {
      paragraphs.push(current);
      current = '';
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.join('\n');
}

/** Right edge of a line in points. */
function lineEnd(line) {
  const lastRun = line.runs.at(-1);
  const end = lastRun ? lastRun.x + (lastRun.width ?? estimateWidth(lastRun.text, lastRun.size)) : line.x;
  return Math.max(end, line.x + estimateWidth(line.text, line.size));
}

function walkContent(doc, content, fonts) {
  const tokens = tokenizeContent(content);
  const runs = [];

  let font = null;
  let fontSize = 12;
  let leading = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;
  let rise = 0;
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];

  const operands = [];
  let arrayAccum = null;
  let arrayActive = false;

  const showText = (bytes) => {
    if (!font) return;
    const codes = decodeCodes(bytes, font);
    let text = '';
    let advance = 0;
    for (const code of codes) {
      const mapped = font.toUnicode ? font.toUnicode.get(code) : String.fromCharCode(code);
      text += mapped ?? '';
      const width = (font.widths.get(code) ?? font.defaultWidth) / 1000;
      advance += (width * fontSize + charSpacing + (code === 32 ? wordSpacing : 0)) * horizontalScale;
    }
    const x = tm[4];
    const y = tm[5] + rise;
    const size = Math.abs(tm[3] || 1) * fontSize * Math.abs(tm[0] || 1) || fontSize;
    if (text) runs.push({ x, y, size, width: advance, text, font: font.baseFont });
    tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + advance * tm[0], tm[5] + advance * tm[1]];
  };

  for (const token of tokens) {
    if (token.type === 'arrayStart') {
      arrayActive = true;
      arrayAccum = [];
      continue;
    }
    if (token.type === 'arrayEnd') {
      arrayActive = false;
      if (arrayAccum) operands.push(arrayAccum);
      arrayAccum = null;
      continue;
    }
    if (arrayActive) {
      if (token.type === 'number') arrayAccum.push(token.value);
      else if (token.type === 'string') arrayAccum.push({ string: token.value });
      continue;
    }
    if (token.type !== 'operator') {
      operands.push(token.type === 'string' ? { string: token.value } : token.value);
      continue;
    }

    const op = token.value;
    switch (op) {
      case 'BT':
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [...tm];
        break;
      case 'ET':
        break;
      case 'Tf': {
        const name = operands[operands.length - 2];
        const size = operands[operands.length - 1];
        if (typeof name === 'string') font = fonts.get(name) ?? null;
        if (typeof size === 'number') fontSize = size;
        break;
      }
      case 'TL':
        leading = Number(operands[operands.length - 1]) || 0;
        break;
      case 'Tc':
        charSpacing = Number(operands[operands.length - 1]) || 0;
        break;
      case 'Tw':
        wordSpacing = Number(operands[operands.length - 1]) || 0;
        break;
      case 'Tz':
        horizontalScale = (Number(operands[operands.length - 1]) || 100) / 100;
        break;
      case 'Ts':
        rise = Number(operands[operands.length - 1]) || 0;
        break;
      case 'Td': {
        const tx = Number(operands[operands.length - 2]) || 0;
        const ty = Number(operands[operands.length - 1]) || 0;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + tx * tlm[0] + ty * tlm[2], tlm[5] + tx * tlm[1] + ty * tlm[3]];
        tm = [...tlm];
        break;
      }
      case 'TD': {
        const tx = Number(operands[operands.length - 2]) || 0;
        const ty = Number(operands[operands.length - 1]) || 0;
        leading = -ty;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + tx * tlm[0] + ty * tlm[2], tlm[5] + tx * tlm[1] + ty * tlm[3]];
        tm = [...tlm];
        break;
      }
      case 'Tm': {
        const values = operands.slice(-6).map(Number);
        if (values.length === 6 && values.every((value) => Number.isFinite(value))) {
          tm = values;
          tlm = [...values];
        }
        break;
      }
      case 'T*':
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] - leading * tlm[2], tlm[5] - leading * tlm[3]];
        tm = [...tlm];
        break;
      case 'Tj': {
        const last = operands[operands.length - 1];
        if (last && last.string) showText(last.string);
        break;
      }
      case "'": {
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] - leading * tlm[2], tlm[5] - leading * tlm[3]];
        tm = [...tlm];
        const last = operands[operands.length - 1];
        if (last && last.string) showText(last.string);
        break;
      }
      case '"': {
        const last = operands[operands.length - 1];
        wordSpacing = Number(operands[operands.length - 3]) || 0;
        charSpacing = Number(operands[operands.length - 2]) || 0;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] - leading * tlm[2], tlm[5] - leading * tlm[3]];
        tm = [...tlm];
        if (last && last.string) showText(last.string);
        break;
      }
      case 'TJ': {
        const array = operands[operands.length - 1];
        if (Array.isArray(array)) {
          for (const item of array) {
            if (typeof item === 'number') {
              const shift = (-item / 1000) * fontSize * horizontalScale;
              tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + shift * tm[0], tm[5] + shift * tm[1]];
            } else if (item && item.string) showText(item.string);
          }
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }

  return runs;
}

/**
 * Group positioned runs into visual lines.
 *
 * Runs are kept in the order the content stream draws them: PDF producers emit
 * text in reading order, and sorting a shared baseline by x scrambles lines
 * whose fragments were distributed (justified) across the page — the horizontal
 * positions of such fragments overlap and no longer describe reading order.
 * A baseline change starts a new line; a horizontal gap inside one baseline
 * becomes a space.
 */
export function groupRunsIntoLines(runs) {
  const lines = [];
  let current = null;
  for (const run of runs) {
    const tolerance = Math.max(2, run.size * 0.5);
    if (!current || Math.abs(current.baseline - run.y) > tolerance) {
      current = { baseline: run.y, size: run.size, runs: [] };
      lines.push(current);
    }
    current.runs.push(run);
    if (run.size > current.size) current.size = run.size;
  }
  return lines
    .map((line) => {
      let text = '';
      let previousEnd = null;
      for (const run of line.runs) {
        if (previousEnd !== null) {
          const gap = run.x - previousEnd;
          // Word exports justify CJK text by spacing glyphs apart; a gap between
          // two CJK characters is layout, not a word boundary, so no space there.
          const needsSpace =
            gap > run.size * 0.35 && !/\s$/.test(text) && !/^[\s，。、；：）》】！？]/.test(run.text);
          if (needsSpace && !isCjkAdjacent(text, run.text)) text += ' ';
        }
        text += run.text;
        previousEnd = run.x + (run.width ?? estimateWidth(run.text, run.size));
      }
      return { x: line.runs[0].x, y: line.baseline, size: line.size, text: text.trimEnd(), runs: line.runs };
    })
    .filter((line) => line.text.trim().length > 0);
}

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** True when the text ends with a CJK character and the next run starts with one. */
function isCjkAdjacent(text, next) {
  const before = [...text].pop();
  const after = [...next][0];
  return Boolean(before && after && CJK_RE.test(before) && CJK_RE.test(after));
}

function estimateWidth(text, size) {  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    width += code > 0x2e80 ? size : size * 0.5;
  }
  return width;
}
