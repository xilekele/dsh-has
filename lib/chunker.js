/**
 * Text chunking with sentence-boundary awareness, ported from the
 * reference has_text_chunker implementation.
 */

export const DEFAULT_MAX_CHUNK_TOKENS = 3000;

// Priority: paragraph break > sentence enders > semicolons.
const SENTENCE_BOUNDARIES = /(?<=[\n])|(?<=[。！？!?])|(?<=[；;])/g;
// Fallback: split on any punctuation including commas.
const FALLBACK_BOUNDARIES = /(?<=[，,。！？!?；;：:\n])/g;

function boundaryPositions(pattern, text) {
  const positions = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match;
  while ((match = re.exec(text)) !== null) {
    positions.push(match.index);
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  return positions;
}

/** Character offsets just after a sentence boundary. */
export function sentenceBoundaryPositions(text) {
  return boundaryPositions(SENTENCE_BOUNDARIES, text);
}

/** Character offsets just after any punctuation boundary. */
export function fallbackBoundaryPositions(text) {
  return boundaryPositions(FALLBACK_BOUNDARIES, text);
}

async function tryBoundaries(boundaries, text, countTokens, maxTokens) {
  for (let i = boundaries.length - 1; i >= 0; i -= 1) {
    const pos = boundaries[i];
    if (pos <= 0) continue;
    if ((await countTokens(text.slice(0, pos))) <= maxTokens) return pos;
  }
  return 0;
}

async function findSplitPoint(text, countTokens, maxTokens) {
  const sentence = await tryBoundaries(boundaryPositions(SENTENCE_BOUNDARIES, text), text, countTokens, maxTokens);
  if (sentence > 0) return sentence;
  return tryBoundaries(boundaryPositions(FALLBACK_BOUNDARIES, text), text, countTokens, maxTokens);
}

/**
 * Return the next chunk of `text` that fits within maxTokens.
 * @returns {Promise<{text: string, index: number, startChar: number, endChar: number, tokenCount: number}|null>}
 */
export async function takeChunk(text, countTokens, maxTokens = DEFAULT_MAX_CHUNK_TOKENS, options = {}) {
  if (!text) return null;
  const index = options.index ?? 0;
  const startChar = options.startChar ?? 0;

  const totalTokens = await countTokens(text);
  if (totalTokens <= maxTokens) {
    return { text, index, startChar, endChar: startChar + text.length, tokenCount: totalTokens };
  }

  const charsPerToken = text.length / totalTokens;
  const estimatedChars = Math.floor(maxTokens * charsPerToken);
  const searchEnd = Math.min(estimatedChars + 50, text.length);
  let splitPos = await findSplitPoint(text.slice(0, searchEnd), countTokens, maxTokens);
  if (splitPos <= 0) splitPos = Math.max(1, estimatedChars);

  const chunkText = text.slice(0, splitPos);
  return {
    text: chunkText,
    index,
    startChar,
    endChar: startChar + splitPos,
    tokenCount: await countTokens(chunkText),
  };
}

/**
 * Split leading and trailing whitespace off `text`.
 *
 * The models rewrite whole passages, so they naturally drop edge whitespace
 * (notably a trailing newline). Callers keep `lead`/`trail` and re-attach them
 * so round trips stay byte-exact.
 * @returns {{lead: string, core: string, trail: string}}
 */
export function splitEdgeWhitespace(text) {
  const value = String(text ?? '');
  const lead = value.match(/^\s*/)?.[0] ?? '';
  const trail = value.match(/\s*$/)?.[0] ?? '';
  if (lead.length + trail.length >= value.length) return { lead: value, core: '', trail: '' };
  return { lead, core: value.slice(lead.length, value.length - trail.length), trail };
}

/**
 * Split text into chunks that fit within maxTokens.
 * @returns {Promise<Array<{text: string, index: number, startChar: number, endChar: number, tokenCount: number}>>}
 */
export async function chunkText(text, countTokens, maxTokens = DEFAULT_MAX_CHUNK_TOKENS) {
  if (!text || !text.trim()) return [];

  const chunks = [];
  let remaining = text;
  let offset = 0;
  let index = 0;

  while (remaining) {
    const chunk = await takeChunk(remaining, countTokens, maxTokens, { index, startChar: offset });
    if (!chunk) break;
    chunks.push(chunk);
    offset = chunk.endChar;
    remaining = remaining.slice(chunk.text.length);
    index += 1;
  }

  return chunks;
}
