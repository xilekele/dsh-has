/**
 * Minimal PDF reader/writer: enough to extract positioned text lines from a
 * text-based PDF, and to build a fresh single-font document from them.
 *
 * Scope: classic objects, object streams (/ObjStm), FlateDecode streams,
 * Type0/Identity-H and simple TrueType/Type1 fonts with /ToUnicode maps. No
 * rendering, no images, no encryption.
 */

import zlib from 'node:zlib';

/* ------------------------------------------------------------------ lexer */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITER = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

class Lexer {
  constructor(text, pos = 0) {
    this.text = text;
    this.pos = pos;
  }

  skipSpace() {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (WHITESPACE.has(ch.charCodeAt(0))) this.pos += 1;
      else if (ch === '%') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n' && this.text[this.pos] !== '\r') this.pos += 1;
      } else break;
    }
  }

  /** Read the next raw token (name, number, string, delimiter) or null at EOF. */
  next() {
    this.skipSpace();
    if (this.pos >= this.text.length) return null;
    const ch = this.text[this.pos];

    if (ch === '/') {
      let end = this.pos + 1;
      while (end < this.text.length) {
        const c = this.text[end];
        if (WHITESPACE.has(c.charCodeAt(0)) || DELIMITER.has(c)) break;
        end += 1;
      }
      const raw = this.text.slice(this.pos + 1, end);
      this.pos = end;
      return { type: 'name', value: decodeName(raw) };
    }

    if (ch === '(') return { type: 'string', value: this.readLiteralString() };

    if (ch === '<') {
      if (this.text[this.pos + 1] === '<') {
        this.pos += 2;
        return { type: 'punct', value: '<<' };
      }
      return { type: 'string', value: this.readHexString() };
    }

    if (ch === '>') {
      if (this.text[this.pos + 1] === '>') {
        this.pos += 2;
        return { type: 'punct', value: '>>' };
      }
      this.pos += 1;
      return { type: 'punct', value: '>' };
    }

    if (ch === '[' || ch === ']') {
      this.pos += 1;
      return { type: 'punct', value: ch };
    }

    if (ch === '{' || ch === '}') {
      this.pos += 1;
      return { type: 'punct', value: ch };
    }

    let end = this.pos;
    while (end < this.text.length) {
      const c = this.text[end];
      if (WHITESPACE.has(c.charCodeAt(0)) || DELIMITER.has(c)) break;
      end += 1;
    }
    const word = this.text.slice(this.pos, end);
    this.pos = end;
    if (!word) {
      this.pos += 1;
      return { type: 'punct', value: ch };
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { type: 'number', value: Number(word) };
    return { type: 'keyword', value: word };
  }

  readLiteralString() {
    // this.text[this.pos] === '('
    let depth = 0;
    this.pos += 1;
    const bytes = [];
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '\\') {
        const next = this.text[this.pos + 1];
        this.pos += 2;
        switch (next) {
          case 'n': bytes.push(0x0a); break;
          case 'r': bytes.push(0x0d); break;
          case 't': bytes.push(0x09); break;
          case 'b': bytes.push(0x08); break;
          case 'f': bytes.push(0x0c); break;
          case '(': bytes.push(0x28); break;
          case ')': bytes.push(0x29); break;
          case '\\': bytes.push(0x5c); break;
          case '\r':
            if (this.text[this.pos] === '\n') this.pos += 1;
            break;
          case '\n':
            break;
          default:
            if (next >= '0' && next <= '7') {
              let octal = next;
              while (octal.length < 3 && this.text[this.pos] >= '0' && this.text[this.pos] <= '7') {
                octal += this.text[this.pos];
                this.pos += 1;
              }
              bytes.push(parseInt(octal, 8) & 0xff);
            } else if (next !== undefined) {
              bytes.push(next.charCodeAt(0) & 0xff);
            }
        }
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
    return Buffer.from(bytes).toString('latin1');
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
    const buffer = Buffer.from(hex, 'hex');
    return buffer.toString('latin1');
  }
}

function decodeName(raw) {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/* ------------------------------------------------------------- object model */

class Name {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return '/' + this.value;
  }
}

class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}

const PUNCT = Symbol('punct');

class Dict extends Map {}

function isDictLike(value) {
  return value instanceof Map;
}

/* ------------------------------------------------------------- PDF document */

export class PdfDocument {
  constructor(buffer) {
    this.text = buffer.toString('latin1');
    this.buffer = buffer;
    this.objects = new Map(); // num -> { value, stream }
    this.cache = new Map();
    this.trailer = new Map();
    this.#scanObjects();
    this.#scanTrailer();
  }

  get length() {
    return this.objects.size;
  }

  #scanObjects() {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let match;
    while ((match = re.exec(this.text))) {
      const num = Number(match[1]);
      const start = re.lastIndex;
      const end = this.text.indexOf('endobj', start);
      if (end < 0) continue;
      const body = this.text.slice(start, end);
      const streamAt = body.indexOf('stream');
      const valueText = streamAt >= 0 ? body.slice(0, streamAt) : body;
      let value;
      try {
        value = this.parseValueText(valueText);
      } catch {
        re.lastIndex = end + 6;
        continue;
      }
      let stream = null;
      if (streamAt >= 0) {
        let dataStart = start + streamAt + 'stream'.length;
        if (this.text[dataStart] === '\r') dataStart += 1;
        if (this.text[dataStart] === '\n') dataStart += 1;
        let length = null;
        if (isDictLike(value)) length = this.#numberValue(value.get('Length'));
        let dataEnd;
        if (typeof length === 'number' && length >= 0) dataEnd = dataStart + length;
        else dataEnd = this.text.indexOf('endstream', dataStart);
        stream = this.buffer.subarray(dataStart, dataEnd);
      }
      this.objects.set(num, { value, stream });
      re.lastIndex = end + 6;
    }
  }

  #numberValue(value) {
    if (typeof value === 'number') return value;
    if (value instanceof Ref) {
      const resolved = this.#rawResolve(value.num);
      return typeof resolved === 'number' ? resolved : null;
    }
    return null;
  }

  #rawResolve(num) {
    const entry = this.objects.get(num);
    if (!entry) return undefined;
    return entry.value;
  }

  #scanTrailer() {
    const re = /trailer\s*<</g;
    let match;
    let last = null;
    while ((match = re.exec(this.text))) last = match.index + 'trailer'.length;
    if (last !== null) {
      try {
        const lexer = new Lexer(this.text, last);
        const value = this.parseValue(lexer);
        if (isDictLike(value)) for (const [k, v] of value) this.trailer.set(k, v);
      } catch {
        /* ignore */
      }
    }
    // Cross-reference streams carry their own /Root: fall back to any object
    // holding a /Type /Catalog entry.
    if (!this.trailer.has('Root')) {
      for (const [num, entry] of this.objects) {
        if (isDictLike(entry.value) && String(rawName(entry.value.get('Type'))) === 'Catalog') {
          this.trailer.set('Root', new Ref(num, 0));
          break;
        }
      }
    }
    if (this.trailer.has('Root')) {
      const root = this.resolve(this.trailer.get('Root'));
      if (isDictLike(root) && !this.trailer.has('RootRef')) this.trailer.set('RootRef', this.trailer.get('Root'));
    }
    this.#expandObjectStreams();
  }

  #expandObjectStreams() {
    const streams = [];
    for (const [num, entry] of this.objects) {
      if (isDictLike(entry.value) && String(rawName(entry.value.get('Type'))) === 'ObjStm') streams.push(num);
    }
    for (const num of streams) {
      const entry = this.objects.get(num);
      if (!entry?.stream) continue;
      let data;
      try {
        data = this.decodeStream(entry.value, entry.stream);
      } catch {
        continue;
      }
      const dict = entry.value;
      const count = this.#numberValue(dict.get('N')) ?? 0;
      const first = this.#numberValue(dict.get('First')) ?? 0;
      const header = data.subarray(0, first).toString('latin1');
      const numbers = header.split(/\s+/).filter(Boolean).map(Number);
      for (let index = 0; index < count; index += 1) {
        const objNum = numbers[index * 2];
        const offset = numbers[index * 2 + 1];
        if (!Number.isFinite(objNum) || !Number.isFinite(offset)) continue;
        if (this.objects.has(objNum)) continue;
        const body = data.subarray(first + offset).toString('latin1');
        try {
          const value = this.parseValueText(body);
          this.objects.set(objNum, { value, stream: null });
        } catch {
          /* skip malformed entries */
        }
      }
    }
  }

  parseValueText(text) {
    const lexer = new Lexer(text, 0);
    return this.parseValue(lexer);
  }

  parseValue(lexer) {
    const token = lexer.next();
    if (!token) return null;
    if (token.type === 'number') {
      // Possible indirect reference "num gen R".
      const save = lexer.pos;
      const second = lexer.next();
      if (second && second.type === 'number' && Number.isInteger(token.value) && Number.isInteger(second.value)) {
        const third = lexer.next();
        if (third && third.type === 'keyword' && third.value === 'R') return new Ref(token.value, second.value);
      }
      lexer.pos = save;
      return token.value;
    }
    if (token.type === 'name') return new Name(token.value);
    if (token.type === 'string') return token.value;
    if (token.type === 'keyword') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    if (token.type === 'punct') {
      if (token.value === '<<') {
        const dict = new Dict();
        for (;;) {
          lexer.skipSpace();
          if (lexer.pos >= lexer.text.length) break;
          if (lexer.text.startsWith('>>', lexer.pos)) {
            lexer.pos += 2;
            break;
          }
          const key = lexer.next();
          if (!key) break;
          if (key.type === 'punct' && key.value === '>>') break;
          if (key.type !== 'name') continue;
          const value = this.parseValue(lexer);
          dict.set(key.value, value);
        }
        return dict;
      }
      if (token.value === '[') {
        const array = [];
        for (;;) {
          lexer.skipSpace();
          if (lexer.pos >= lexer.text.length) break;
          if (lexer.text[lexer.pos] === ']') {
            lexer.pos += 1;
            break;
          }
          const value = this.parseValue(lexer);
          if (value === undefined) break;
          array.push(value);
        }
        return array;
      }
      return PUNCT;
    }
    return null;
  }

  resolve(value, depth = 0) {
    if (!(value instanceof Ref)) return value;
    if (depth > 32) return null;
    if (this.cache.has(value.num)) return this.cache.get(value.num);
    const entry = this.objects.get(value.num);
    if (!entry) return undefined;
    let resolved = entry.value;
    if (resolved instanceof Ref) resolved = this.resolve(resolved, depth + 1);
    this.cache.set(value.num, resolved);
    return resolved;
  }

  /** Resolve a value and return the raw stream bytes (decoded). */
  streamOf(value) {
    let ref = value;
    if (!(ref instanceof Ref)) return null;
    const entry = this.objects.get(ref.num);
    if (!entry?.stream) return null;
    return this.decodeStream(entry.value, entry.stream);
  }

  decodeStream(dict, raw) {
    if (!isDictLike(dict) || !raw) return raw;
    let filters = dict.get('Filter');
    filters = this.resolve(filters);
    const list = Array.isArray(filters) ? filters : filters ? [filters] : [];
    let data = raw;
    for (const filter of list) {
      const name = String(rawName(this.resolve(filter)));
      if (name === 'FlateDecode' || name === 'Fl') data = zlib.inflateSync(data);
      else if (name === 'ASCIIHexDecode') data = Buffer.from(data.toString('latin1').replace(/>.*$/, ''), 'hex');
      else throw new Error(`Unsupported PDF filter: ${name}`);
    }
    return data;
  }

  /* ------------------------------------------------------------- page walk */

  pages() {
    const root = this.resolve(this.trailer.get('Root'));
    const pagesRef = isDictLike(root) ? root.get('Pages') : null;
    const out = [];
    const seen = new Set();
    const walk = (nodeRef) => {
      const node = this.resolve(nodeRef);
      if (!isDictLike(node)) return;
      const key = nodeRef instanceof Ref ? nodeRef.num : null;
      if (key !== null) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      const type = String(rawName(node.get('Type')));
      if (type === 'Pages') {
        const kids = this.resolve(node.get('Kids')) ?? [];
        for (const kid of kids) walk(kid);
      } else if (type === 'Page') {
        out.push({ ref: nodeRef, dict: node });
      }
    };
    walk(pagesRef);
    return out;
  }

  pageContent(pageDict) {
    const contents = this.resolve(pageDict.get('Contents'));
    const parts = Array.isArray(contents) ? contents : contents ? [pageDict.get('Contents')] : [];
    const chunks = [];
    for (const part of parts) {
      const data = this.streamOf(part);
      if (data) chunks.push(data.toString('latin1'));
    }
    return chunks.join('\n');
  }

  inherited(pageDict, key) {
    let node = pageDict;
    for (let depth = 0; isDictLike(node) && depth < 32; depth += 1) {
      if (node.has(key)) return this.resolve(node.get(key));
      const parent = this.resolve(node.get('Parent'));
      if (!isDictLike(parent)) break;
      node = parent;
    }
    return null;
  }
}

function rawName(value) {
  return value instanceof Name ? value.value : value;
}

/* ------------------------------------------------------------- font decoding */

function parseToUnicode(data) {
  const map = new Map();
  const text = data.toString('latin1');
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let match;
  while ((match = bfcharRe.exec(text))) {
    const body = match[1];
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pair;
    while ((pair = pairRe.exec(body))) {
      const src = parseInt(pair[1], 16);
      map.set(src, hexToText(pair[2]));
    }
  }
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((match = bfrangeRe.exec(text))) {
    const body = match[1];
    const lineRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    let line;
    while ((line = lineRe.exec(body))) {
      const start = parseInt(line[1], 16);
      const end = parseInt(line[2], 16);
      if (line[4]) {
        const base = parseInt(line[4], 16);
        for (let code = start; code <= end && code - start < 65536; code += 1) {
          map.set(code, hexToText((base + (code - start)).toString(16).padStart(4, '0')));
        }
      } else if (line[5]) {
        const items = [...line[5].matchAll(/<([0-9a-fA-F]+)>/g)].map((item) => hexToText(item[1]));
        for (let index = 0; index < items.length && start + index <= end; index += 1) map.set(start + index, items[index]);
      }
    }
  }
  return map;
}

function hexToText(hex) {
  const clean = hex.length % 2 ? hex + '0' : hex;
  const buffer = Buffer.from(clean, 'hex');
  if (buffer.length >= 2) {
    let out = '';
    for (let index = 0; index + 1 < buffer.length; index += 2) out += String.fromCharCode(buffer.readUInt16BE(index));
    return out;
  }
  return String.fromCharCode(buffer[0] ?? 0);
}
