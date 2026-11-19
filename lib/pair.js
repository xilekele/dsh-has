/**
 * Diff-based (Tool-Pair) mapping extraction.
 *
 * Port of the reference pair algorithm: tokenize both texts symbolically,
 * align them with a Python-`difflib.SequenceMatcher`-compatible matcher, and
 * read entity/tag pairs out of the resulting opcodes. Includes the
 * contextual-conjunction fallback strategies from the reference.
 */

const TAG_PATTERN = /<([^<>\[\]]+)\[(\d+)\]\.([^<>\[\].]+)\.([^<>\[\].]+)>/g;
const CONJ_JUNK_SET = new Set(['及', '和', '与', '到', '的']);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/y;
const URL_RE = /https?:\/\/[^\s\u3000<>"'）】>)\u4E00-\u9FFF]+/iy;
const TRAIL_PUNCTS = new Set([
  ...'.,!?:;)]}',
  ...'，。！？：；）】】、》”’',
]);

const SEP = '\u0000';

function charToken(text) {
  return { k: 'char', t: text };
}
function spanToken(text, kind) {
  return { k: 'span', t: text, kind };
}
function tagToken(text) {
  return { k: 'tag', t: text };
}

function keyOf(token) {
  return token.k + SEP + token.t;
}

function equalsToken(a, b) {
  return a.k === b.k && a.t === b.t;
}

export function normalizePlainText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\ufeff/g, '')
    .replace(/[\u200b\u200c\u200d]/g, '')
    .normalize('NFC');
}

/** Tokenize plain text, keeping emails / urls / 《...》 spans as single tokens. */
export function tokenizePlainText(value, { includeQuoteDelims = true } = {}) {
  const s = normalizePlainText(value ?? '') ?? '';
  /** @type {Array<{k: string, t: string, kind?: string}>} */
  const tokens = [];
  let i = 0;

  const appendSpan = (text, kind) => {
    if (text) tokens.push(spanToken(text, kind));
  };

  while (i < s.length) {
    const code = s.charCodeAt(i);

    if (code < 128 && /[A-Za-z0-9._%+-]/.test(s[i])) {
      EMAIL_RE.lastIndex = i;
      const email = EMAIL_RE.exec(s);
      if (email) {
        let span = email[0];
        let end = i + span.length;
        while (span && TRAIL_PUNCTS.has(span[span.length - 1])) {
          span = span.slice(0, -1);
          end -= 1;
        }
        if (span) {
          appendSpan(span, 'email');
          i = end;
          continue;
        }
      }
    }

    if ((s.startsWith('http://', i) || s.startsWith('https://', i))) {
      URL_RE.lastIndex = i;
      const url = URL_RE.exec(s);
      if (url) {
        let span = url[0];
        let end = i + span.length;
        while (span && TRAIL_PUNCTS.has(span[span.length - 1])) {
          span = span.slice(0, -1);
          end -= 1;
        }
        if (span) {
          appendSpan(span, 'url');
          i = end;
          continue;
        }
      }
    }

    if (s[i] === '《') {
      const close = s.indexOf('》', i + 1);
      if (close !== -1 && close - i <= 200) {
        if (includeQuoteDelims) {
          appendSpan(s.slice(i, close + 1), 'quote');
        } else {
          tokens.push(charToken('《'));
          const inner = s.slice(i + 1, close);
          if (inner) appendSpan(inner, 'quote');
          tokens.push(charToken('》'));
        }
        i = close + 1;
        continue;
      }
    }

    tokens.push(charToken(s[i]));
    i += 1;
  }

  return tokens;
}

/** Tokenize hide text, splitting anonymized tags into their own TagTokens. */
export function tokenizeHideWithTags(hide, { includeQuoteDelims = true } = {}) {
  const tokens = [];
  let last = 0;
  for (const match of String(hide).matchAll(new RegExp(TAG_PATTERN.source, 'g'))) {
    const start = match.index;
    if (start > last) {
      tokens.push(...tokenizePlainText(hide.slice(last, start), { includeQuoteDelims }));
    }
    tokens.push(tagToken(match[0]));
    last = start + match[0].length;
  }
  if (last < hide.length) {
    tokens.push(...tokenizePlainText(hide.slice(last), { includeQuoteDelims }));
  }
  return tokens;
}

export function renderTokens(tokens) {
  return tokens.map((token) => token.t).join('');
}

function renderRange(tokens, start, end) {
  return renderTokens(tokens.slice(start, end));
}

function isWhitespaceToken(token) {
  return token.k === 'char' && /\s/.test(token.t);
}

/**
 * Python-difflib `SequenceMatcher` compatible enough for diff alignment:
 * equality-only comparison plus optional junk predicate, autojunk disabled.
 */
class SequenceMatcher {
  constructor(a, b, isJunk = null) {
    this.a = a;
    this.b = b;
    this.b2j = new Map();
    this.bjunk = new Set();
    this.isJunk = typeof isJunk === 'function' ? isJunk : null;

    for (let i = 0; i < b.length; i += 1) {
      const key = keyOf(b[i]);
      const indices = this.b2j.get(key);
      if (indices) indices.push(i);
      else this.b2j.set(key, [i]);
    }

    if (this.isJunk) {
      for (const key of [...this.b2j.keys()]) {
        const token = b.find((candidate) => keyOf(candidate) === key);
        if (token && this.isJunk(token)) {
          this.bjunk.add(key);
          this.b2j.delete(key);
        }
      }
    }
  }

  isbjunk(token) {
    return this.bjunk.has(keyOf(token));
  }

  #findLongestMatch(alo, ahi, blo, bhi) {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();

    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map();
      const indices = b2j.get(keyOf(a[i])) ?? [];
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }

    while (
      besti > alo &&
      bestj > blo &&
      !this.isbjunk(b[bestj - 1]) &&
      equalsToken(a[besti - 1], b[bestj - 1])
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !this.isbjunk(b[bestj + bestsize]) &&
      equalsToken(a[besti + bestsize], b[bestj + bestsize])
    ) {
      bestsize += 1;
    }
    while (besti > alo && bestj > blo && this.isbjunk(b[bestj - 1]) && equalsToken(a[besti - 1], b[bestj - 1])) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      this.isbjunk(b[bestj + bestsize]) &&
      equalsToken(a[besti + bestsize], b[bestj + bestsize])
    ) {
      bestsize += 1;
    }

    return [besti, bestj, bestsize];
  }

  #matchingBlocks() {
    const la = this.a.length;
    const lb = this.b.length;
    const queue = [[0, la, 0, lb]];
    const blocks = [];

    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = this.#findLongestMatch(alo, ahi, blo, bhi);
      if (k) {
        blocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }

    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

    const merged = [];
    let [i1, j1, k1] = [0, 0, 0];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) merged.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([la, lb, 0]);
    return merged;
  }

  getOpcodes() {
    const opcodes = [];
    let i = 0;
    let j = 0;
    for (const [ai, bj, size] of this.#matchingBlocks()) {
      let tag = '';
      if (i < ai && j < bj) tag = 'replace';
      else if (i < ai) tag = 'delete';
      else if (j < bj) tag = 'insert';
      if (tag) opcodes.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) opcodes.push(['equal', ai, i, bj, j]);
    }
    return opcodes;
  }
}

function lcp(a, b) {
  const limit = Math.min(a.length, b.length);
  let k = 0;
  while (k < limit && a[k] === b[k]) k += 1;
  return a.slice(0, k);
}

function lcsuf(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k += 1;
  return k > 0 ? a.slice(a.length - k) : '';
}

const BRACKET_PAIRS = new Map([
  ['[', ']'],
  ['(', ')'],
  ['（', '）'],
  ['【', '】'],
  ['《', '》'],
  ['「', '」'],
  ['{', '}'],
]);

/**
 * Strip a matching bracket pair that the model dropped around an entity.
 *
 * When the rewrite turns `[a@b.com](mailto:a@b.com)` into `<tag>(mailto:<tag>)`,
 * the diff attributes the deleted `[` and `]` to the entity. Keeping them in the
 * mapping re-inserts punctuation that the anonymized text no longer has, so the
 * restored text grows brackets in the wrong place.
 */
function stripOuterBrackets(entity) {
  let value = entity;
  for (let guard = 0; guard < 3; guard += 1) {
    if (value.length <= 2) break;
    const first = value[0];
    const last = value[value.length - 1];
    if (BRACKET_PAIRS.get(first) !== last) break;
    const inner = value.slice(1, -1).trim();
    if (!inner) break;
    value = inner;
  }
  return value;
}

function findAdjacentCompositeGroup(insertTokens, allowedMidTokens = null) {
  const n = insertTokens.length;
  let i = 0;
  while (i < n && insertTokens[i].k !== 'tag') i += 1;
  if (i >= n) return null;

  const start = i;
  let hasTag = false;
  while (i < n) {
    const token = insertTokens[i];
    if (token.k === 'tag') {
      hasTag = true;
      i += 1;
      continue;
    }
    if (isWhitespaceToken(token)) {
      i += 1;
      continue;
    }
    if (token.k === 'char' && allowedMidTokens?.has(token.t)) {
      i += 1;
      continue;
    }
    break;
  }
  return hasTag ? [start, i] : null;
}

function insideQuote(tokens, startIndex, endIndex) {
  let li = startIndex - 1;
  let leftQuote = -1;
  while (li >= 0) {
    const token = tokens[li];
    if (token.k === 'char' && token.t === '《') {
      leftQuote = li;
      break;
    }
    if (token.k === 'char' && token.t === '》') break;
    li -= 1;
  }
  if (leftQuote === -1) return false;

  let ri = endIndex;
  let rightQuote = -1;
  while (ri < tokens.length) {
    const token = tokens[ri];
    if (token.k === 'char' && token.t === '》') {
      rightQuote = ri;
      break;
    }
    if (token.k === 'char' && token.t === '《') break;
    ri += 1;
  }
  return rightQuote !== -1 && leftQuote < startIndex && endIndex <= rightQuote;
}

function renderSkipTags(tokens) {
  return tokens.filter((token) => token.k !== 'tag').map((token) => token.t).join('');
}

function firstPlainPrefix(tokens) {
  const parts = [];
  let i = 0;
  while (i < tokens.length && isWhitespaceToken(tokens[i])) i += 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.k === 'tag') break;
    const text = token.t;
    if (text && !/^\s+$/.test(text)) {
      parts.push(text);
      i += 1;
      continue;
    }
    if (text && /^\s+$/.test(text)) {
      parts.push(text);
      i += 1;
      continue;
    }
    i += 1;
  }
  return parts.join('');
}

function suffixOverlapWithRightPrefix(value, right) {
  const a = value ?? '';
  const b = right ?? '';
  let k = Math.min(a.length, b.length);
  while (k > 0) {
    if (a.endsWith(b.slice(0, k))) return k;
    k -= 1;
  }
  return 0;
}

/** Extract (entity, compositeTag) pairs from a src/dst token alignment. */
export function extractEntityTagPairs(srcTokens, dstTokens, { isJunk = null, allowedMidTokens = null } = {}) {
  const opcodes = new SequenceMatcher(srcTokens, dstTokens, isJunk).getOpcodes();
  const pairs = [];
  const usedMidTokens = new Set();

  const record = (entityRaw, delTokens, insTokens, group, j1) => {
    const [g0, g1] = group;
    let entity = entityRaw;
    const composite = renderRange(insTokens, g0, g1);
    const leftCtx = renderRange(insTokens, 0, g0);
    const rightCtx = renderRange(insTokens, g1, insTokens.length);

    const pre = lcp(entity, leftCtx);
    const suf = lcsuf(entity, rightCtx);
    if (pre) entity = entity.slice(pre.length);
    if (suf && entity.length > suf.length) entity = entity.slice(0, entity.length - suf.length);

    try {
      if (insideQuote(dstTokens, j1 + g0, j1 + g1)) {
        const firstPlain = firstPlainPrefix(insTokens.slice(g1));
        if (firstPlain) {
          const pos = entity.lastIndexOf(firstPlain);
          if (pos !== -1) entity = entity.slice(0, pos);
        }
        if (entity) {
          const rightPlain = renderSkipTags(insTokens.slice(g1));
          const overlap = suffixOverlapWithRightPrefix(entity, rightPlain);
          if (overlap && entity.length > overlap) entity = entity.slice(0, entity.length - overlap);
        }
      }
    } catch {
      /* quote heuristics are best effort */
    }

    entity = entity.trim();
    if (entity) entity = stripOuterBrackets(entity);
    if (!entity) entity = renderRange(delTokens, 0, delTokens.length);

    if (allowedMidTokens) {
      for (const token of insTokens.slice(g0, g1)) {
        if (token.k === 'char' && allowedMidTokens.has(token.t)) usedMidTokens.add(token.t);
      }
    }
    pairs.push([entity, composite]);
  };

  opcodes.forEach((opcode, index) => {
    const [tag, i1, i2, j1, j2] = opcode;
    if (tag === 'replace') {
      const delTokens = srcTokens.slice(i1, i2);
      const insTokens = dstTokens.slice(j1, j2);
      const group = findAdjacentCompositeGroup(insTokens, allowedMidTokens);
      if (!group) return;
      record(renderRange(delTokens, 0, delTokens.length), delTokens, insTokens, group, j1);
    } else if (tag === 'insert') {
      if (index === 0) return;
      const previous = opcodes[index - 1];
      if (previous[0] !== 'delete') return;
      const delTokens = srcTokens.slice(previous[1], previous[2]);
      const insTokens = dstTokens.slice(j1, j2);
      const group = findAdjacentCompositeGroup(insTokens, allowedMidTokens);
      if (!group) return;
      record(renderRange(delTokens, 0, delTokens.length), delTokens, insTokens, group, j1);
    }
  });

  return { pairs, usedMidTokens };
}

/**
 * Compute a mapping plus its self-check, trying the default diff and then
 * contextual-conjunction fallbacks when the default alignment misses tags.
 */
export function computeMappingsAndSelfCheckFromTokens(srcTokens, dstTokens, hideText) {
  const extractConjBetweenTags = (tokens, conjSet) => {
    const selected = new Set();
    tokens.forEach((token, index) => {
      if (!(token.k === 'char' && conjSet.has(token.t))) return;
      let li = index - 1;
      while (li >= 0 && tokens[li].k !== 'tag') li -= 1;
      let ri = index + 1;
      while (ri < tokens.length && tokens[ri].k !== 'tag') ri += 1;
      if (li >= 0 && ri < tokens.length) selected.add(token.t);
    });
    return selected;
  };

  const contextualAllowed = extractConjBetweenTags(dstTokens, CONJ_JUNK_SET);
  const makeIsJunk = (allowed) =>
    allowed && allowed.size
      ? (token) => token.k === 'char' && allowed.has(token.t)
      : null;

  const strategies = [['default', null, null]];
  if (contextualAllowed.size) {
    strategies.push(['fallback:contextual-conj', makeIsJunk(contextualAllowed), contextualAllowed]);
    for (const token of [...contextualAllowed].sort()) {
      const single = new Set([token]);
      strategies.push([`fallback:contextual-one:${token}`, makeIsJunk(single), single]);
    }
  }

  let best = null;
  let bestMissing = null;
  const attemptsSummary = [];
  let defaultSelfCheck = null;
  let chosenLabel = null;
  let chosenIsJunk = null;
  let chosenAllowed = null;
  let chosenUsedMidTokens = new Set();

  for (const [label, isJunk, allowed] of strategies) {
    const { pairs, usedMidTokens } = extractEntityTagPairs(srcTokens, dstTokens, {
      isJunk,
      allowedMidTokens: allowed,
    });

    const mappings = {};
    for (const [entity, tag] of pairs) {
      const bucket = mappings[tag] ?? (mappings[tag] = []);
      if (!bucket.includes(entity)) bucket.push(entity);
    }

    const hideTagSet = new Set(Array.from(String(hideText).matchAll(new RegExp(TAG_PATTERN.source, 'g')), (m) => m[0]));
    const mappedTagSet = new Set();
    for (const composite of Object.keys(mappings)) {
      for (const match of composite.matchAll(new RegExp(TAG_PATTERN.source, 'g'))) mappedTagSet.add(match[0]);
    }
    const allValuesNonEmpty = Object.values(mappings).every((values) => values.length > 0);

    const setEqual =
      hideTagSet.size === mappedTagSet.size && [...hideTagSet].every((tag) => mappedTagSet.has(tag));
    const pass = setEqual && allValuesNonEmpty;

    const missingTags = [...hideTagSet].filter((tag) => !mappedTagSet.has(tag)).sort();
    const extraTags = [...mappedTagSet].filter((tag) => !hideTagSet.has(tag)).sort();

    const selfCheck = {
      pass,
      summary: {
        hideTagSetCount: hideTagSet.size,
        mappedTagSetCount: mappedTagSet.size,
        allValuesNonEmpty,
        setEqual,
      },
      missing: { count: missingTags.length, tags: missingTags.slice(0, 50) },
      extra: { count: extraTags.length, tags: extraTags.slice(0, 50) },
    };

    attemptsSummary.push({
      label,
      pass,
      missingCount: missingTags.length,
      extraCount: extraTags.length,
    });
    if (label === 'default') defaultSelfCheck = selfCheck;

    if (pass) {
      best = { mappings, selfCheck, label, usedMidTokens };
      chosenLabel = label;
      chosenIsJunk = isJunk;
      chosenAllowed = allowed;
      chosenUsedMidTokens = usedMidTokens;
      break;
    }
    if (bestMissing === null || missingTags.length < bestMissing) {
      bestMissing = missingTags.length;
      best = { mappings, selfCheck, label, usedMidTokens };
      chosenLabel = label;
      chosenIsJunk = isJunk;
      chosenAllowed = allowed;
      chosenUsedMidTokens = usedMidTokens;
    }
  }

  const result = best;
  if (chosenLabel !== null) {
    result.selfCheck.strategy = { chosen: chosenLabel, usedFallback: chosenLabel !== 'default' };
    result.chosenIsJunk = chosenIsJunk;
    result.chosenAllowed = chosenAllowed;
    result.defaultSelfCheck = defaultSelfCheck;
  }

  void chosenUsedMidTokens;
  return {
    mappings: result.mappings,
    selfCheck: result.selfCheck,
    chosenStrategy: chosenLabel,
    usedMidTokens: [...chosenUsedMidTokens].sort(),
    attemptsSummary,
  };
}

function normalizeMappingEntries(entries) {
  const normalized = {};
  for (const [key, values] of entries) {
    const keyStr = String(key).trim();
    if (!keyStr) continue;
    const bucket = normalized[keyStr] ?? (normalized[keyStr] = []);
    for (const value of values) {
      const valueStr = String(value).trim();
      if (!valueStr || bucket.includes(valueStr)) continue;
      bucket.push(valueStr);
    }
  }
  return normalized;
}

/** Compute a mapping from an original/anonymized pair without any model call. */
export function computePairMapping(inputText, hideText, { includeQuoteDelims = false } = {}) {
  const srcTokens = tokenizePlainText(String(inputText), { includeQuoteDelims });
  const dstTokens = tokenizeHideWithTags(String(hideText), { includeQuoteDelims });

  const { mappings, selfCheck, chosenStrategy, usedMidTokens, attemptsSummary } =
    computeMappingsAndSelfCheckFromTokens(srcTokens, dstTokens, String(hideText));

  return {
    mapping: mappings,
    normalizedMapping: normalizeMappingEntries(Object.entries(mappings)),
    selfCheck,
    chosenStrategy,
    usedMidTokens,
    attemptsSummary,
  };
}
