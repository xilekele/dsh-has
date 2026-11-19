/**
 * seek — restore anonymized text (Phase 3 of the HaS workflow).
 *
 * Deterministic Tool-Seek is tried first when the text and the mapping
 * values are in the same language; otherwise (or when tags remain) the
 * local model restores chunk by chunk, never splitting a mapping key.
 */

import {
  DEFAULT_MAX_CHUNK_TOKENS,
  fallbackBoundaryPositions,
  sentenceBoundaryPositions,
  splitEdgeWhitespace,
} from './chunker.js';
import { isSameLanguage } from './lang.js';
import {
  TAG_PATTERN,
  findCompositeEntries,
  hasTags,
  normalizeMappingDict,
  parseJsonTolerant,
} from './mapping.js';
import { buildSeekMessages, buildSplitMessages } from './prompts.js';
import { mapConcurrent } from './hide.js';

export const DEFAULT_MAX_PARALLEL_REQUESTS = 4;

/** Restore by replacing tags with the first value of each mapping entry. */
export function toolSeek(text, mapping) {
  let restored = text;
  const entries = Object.entries(mapping ?? {}).sort((a, b) => b[0].length - a[0].length);
  for (const [tag, values] of entries) {
    if (values?.length) restored = restored.split(tag).join(String(values[0]));
  }
  return restored;
}

export function seekSelfCheck(restoredText) {
  return !hasTags(restoredText);
}

export function shouldTryToolSeek(text, mapping, originalText = null) {
  if (originalText) return isSameLanguage(originalText, text);
  const sample = Object.values(mapping ?? {})
    .flatMap((values) => values.slice(0, 2))
    .join(' ');
  if (!sample.trim()) return true;
  return isSameLanguage(sample, text);
}

/** Restore without the model when deterministic replacement suffices. */
export function restoreWithoutModel(text, mapping, originalText = null) {
  if (!hasTags(text)) return text;
  if (!shouldTryToolSeek(text, mapping, originalText)) return null;
  const restored = toolSeek(text, mapping);
  return seekSelfCheck(restored) ? restored : null;
}

function normalizeSplitResult(splitResult) {
  if (splitResult && typeof splitResult === 'object' && !Array.isArray(splitResult)) {
    return normalizeMappingDict(splitResult);
  }
  if (Array.isArray(splitResult)) {
    const merged = {};
    for (const item of splitResult) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Model-Split returned a non-object entry');
      }
      Object.assign(merged, item);
    }
    return normalizeMappingDict(merged);
  }
  throw new Error('Model-Split did not return valid JSON');
}

/** Split composite mappings whose composite key no longer appears in the text. */
export async function normalizeSeekMapping(client, text, mapping) {
  const { atomic, composite } = findCompositeEntries(mapping);
  if (Object.keys(composite).length === 0) return mapping;

  const preserved = {};
  const unresolved = {};
  for (const [key, values] of Object.entries(composite)) {
    if (text.includes(key)) preserved[key] = values;
    else unresolved[key] = values;
  }
  if (!Object.keys(unresolved).length) return mapping;

  const rawOutput = await client.chat(
    buildSplitMessages(Object.entries(unresolved).map(([key, values]) => ({ [key]: values }))),
    { maxTokens: 1024 },
  );
  let normalizedSplit;
  try {
    normalizedSplit = normalizeSplitResult(parseJsonTolerant(rawOutput));
  } catch {
    return mapping;
  }

  const merged = { ...atomic, ...normalizedSplit, ...preserved };
  for (const [key, values] of Object.entries(unresolved)) {
    if (!(key in merged)) merged[key] = values;
  }
  return merged;
}

function findKeyOccurrences(text, mapping) {
  const occurrences = [];
  for (const key of Object.keys(mapping)) {
    let start = 0;
    for (;;) {
      const index = text.indexOf(key, start);
      if (index < 0) break;
      occurrences.push({ key, start: index, end: index + key.length });
      start = index + 1;
    }
  }
  occurrences.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.key.localeCompare(b.key));
  return occurrences;
}

function hasUncoveredTags(text, occurrences) {
  for (const match of text.matchAll(new RegExp(TAG_PATTERN.source, 'g'))) {
    const tagStart = match.index;
    const tagEnd = tagStart + match[0].length;
    if (!occurrences.some((item) => item.start <= tagStart && item.end >= tagEnd)) return true;
  }
  return false;
}

function isSafeSplit(pos, occurrences) {
  return occurrences.every((item) => !(item.start < pos && pos < item.end));
}

function localMappingForPrefix(mapping, occurrences, endPos) {
  const included = new Set(occurrences.filter((item) => item.end <= endPos).map((item) => item.key));
  const result = {};
  for (const [key, values] of Object.entries(mapping)) if (included.has(key)) result[key] = values;
  return result;
}

async function countSeekPromptTokens(countTokens, text, mapping) {
  if (!hasTags(text)) return 0;
  const messages = buildSeekMessages(mapping, text);
  return countTokens(messages[0].content);
}

function candidatePositions(text, occurrences, searchEnd) {
  const positions = new Set();
  for (const pos of [...sentenceBoundaryPositions(text.slice(0, searchEnd)), ...fallbackBoundaryPositions(text.slice(0, searchEnd))]) {
    positions.add(pos);
  }
  for (const item of occurrences) {
    if (item.start > 0 && item.start <= searchEnd) positions.add(item.start);
    if (item.end > 0 && item.end <= searchEnd) positions.add(item.end);
  }
  return [...positions]
    .filter((pos) => pos > 0 && pos < text.length && isSafeSplit(pos, occurrences))
    .sort((a, b) => b - a);
}

async function takeSeekChunk(text, mapping, occurrences, countTokens, maxTokens, { index, startChar }) {
  if (!text) throw new Error('Cannot plan an empty seek chunk');

  const fullMapping = localMappingForPrefix(mapping, occurrences, text.length);
  const fullPromptTokens = await countSeekPromptTokens(countTokens, text, fullMapping);
  if (fullPromptTokens <= maxTokens) {
    return {
      text,
      index,
      startChar,
      endChar: startChar + text.length,
      mapping: fullMapping,
      needsModel: hasTags(text),
      promptTokenCount: fullPromptTokens,
    };
  }

  const charsPerToken = text.length / Math.max(fullPromptTokens, 1);
  const estimatedChars = Math.max(1, Math.floor(maxTokens * charsPerToken));
  const searchEnd = Math.min(estimatedChars + 50, text.length);

  for (const splitPos of candidatePositions(text, occurrences, searchEnd)) {
    const localMapping = localMappingForPrefix(mapping, occurrences, splitPos);
    const chunkText = text.slice(0, splitPos);
    const promptTokens = await countSeekPromptTokens(countTokens, chunkText, localMapping);
    if (promptTokens <= maxTokens) {
      return {
        text: chunkText,
        index,
        startChar,
        endChar: startChar + splitPos,
        mapping: localMapping,
        needsModel: hasTags(chunkText),
        promptTokenCount: promptTokens,
      };
    }
  }

  let hardCut = Math.min(estimatedChars, text.length - 1);
  while (hardCut > 0 && !isSafeSplit(hardCut, occurrences)) hardCut -= 1;
  if (hardCut > 0) {
    const localMapping = localMappingForPrefix(mapping, occurrences, hardCut);
    const chunkText = text.slice(0, hardCut);
    const promptTokens = await countSeekPromptTokens(countTokens, chunkText, localMapping);
    if (promptTokens <= maxTokens) {
      return {
        text: chunkText,
        index,
        startChar,
        endChar: startChar + hardCut,
        mapping: localMapping,
        needsModel: hasTags(chunkText),
        promptTokenCount: promptTokens,
      };
    }
  }

  const firstComplete = occurrences.length ? Math.min(...occurrences.map((item) => item.end)) : 0;
  if (firstComplete > 0) {
    const localMapping = localMappingForPrefix(mapping, occurrences, firstComplete);
    const chunkText = text.slice(0, firstComplete);
    const promptTokens = await countSeekPromptTokens(countTokens, chunkText, localMapping);
    if (promptTokens <= maxTokens) {
      return {
        text: chunkText,
        index,
        startChar,
        endChar: startChar + firstComplete,
        mapping: localMapping,
        needsModel: hasTags(chunkText),
        promptTokenCount: promptTokens,
      };
    }
  }

  throw new Error(
    'A single seek chunk cannot fit in the model budget, even after splitting at safe key boundaries. ' +
      'Increase maxChunkTokens or reduce the mapping size.',
  );
}

/** Plan model/passthrough chunks without splitting a mapping key. */
export async function planSeekChunksFromMapping(text, mapping, countTokens, maxChunkTokens) {
  const occurrences = findKeyOccurrences(text, mapping);

  if (hasUncoveredTags(text, occurrences)) {
    const promptTokens = await countSeekPromptTokens(countTokens, text, mapping);
    if (promptTokens <= maxChunkTokens) {
      return [
        {
          text,
          index: 0,
          startChar: 0,
          endChar: text.length,
          mapping,
          needsModel: true,
          promptTokenCount: promptTokens,
        },
      ];
    }
    throw new Error(
      'Cross-language seek could not be chunked safely because some tags are not covered by mapping keys. ' +
        'This usually means the translated text mutated a tag or still depends on unresolved composite mappings.',
    );
  }

  const chunks = [];
  let offset = 0;
  let index = 0;

  while (offset < text.length) {
    const remainingText = text.slice(offset);
    const remainingOccurrences = occurrences
      .filter((item) => item.end > offset)
      .map((item) => ({ key: item.key, start: item.start - offset, end: item.end - offset }));

    if (!remainingOccurrences.length) {
      chunks.push({
        text: remainingText,
        index,
        startChar: offset,
        endChar: text.length,
        mapping: {},
        needsModel: false,
        promptTokenCount: 0,
      });
      break;
    }

    const first = remainingOccurrences[0];
    if (first.start > 0) {
      const passthrough = remainingText.slice(0, first.start);
      chunks.push({
        text: passthrough,
        index,
        startChar: offset,
        endChar: offset + passthrough.length,
        mapping: {},
        needsModel: false,
        promptTokenCount: 0,
      });
      offset += passthrough.length;
      index += 1;
      continue;
    }

    const chunk = await takeSeekChunk(remainingText, mapping, remainingOccurrences, countTokens, maxChunkTokens, {
      index,
      startChar: offset,
    });
    chunks.push(chunk);
    offset += chunk.text.length;
    index += 1;
  }

  return chunks;
}

export async function planSeekChunks(client, text, mapping, maxChunkTokens) {
  const normalized = await normalizeSeekMapping(client, text, mapping);
  return planSeekChunksFromMapping(text, normalized, (value) => client.countTokens(value), maxChunkTokens);
}

async function runModelSeekChunk(client, text, mapping, warn = () => {}) {
  // Bound a degenerate generation so a broken chunk fails instead of hanging.
  const maxTokens = Math.min(8192, Math.max(768, text.length + 256));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const restoredRaw = await client.chat(buildSeekMessages(mapping, text), { maxTokens });
    let restored = restoredRaw;
    if (hasTags(restored) && Object.keys(mapping).length) restored = toolSeek(restored, mapping);
    if (seekSelfCheck(restored)) return restored;
    if (attempt === 0) warn('Model-Seek left unresolved tags; retrying once with the original chunk');
  }
  throw new Error('Model-Seek left unresolved tags after one retry');
}

async function executeSeekChunks(client, chunks, maxParallelRequests = DEFAULT_MAX_PARALLEL_REQUESTS) {
  const modelChunks = chunks.filter((chunk) => chunk.needsModel);
  const outputs = new Array(chunks.length).fill('');

  await mapConcurrent(modelChunks, maxParallelRequests, async (chunk) => {
    outputs[chunk.index] = await runModelSeekChunk(client, chunk.text, chunk.mapping);
    return null;
  });

  for (const chunk of chunks) if (!chunk.needsModel) outputs[chunk.index] = chunk.text;
  return outputs.join('');
}

export async function estimateSeekModelRequestCount(
  text,
  mapping,
  { countTokens, maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS, originalText = null } = {},
) {
  const restored = restoreWithoutModel(text, mapping, originalText);
  if (restored !== null || !hasTags(text)) return 0;
  const chunks = await planSeekChunksFromMapping(text, mapping, countTokens, maxChunkTokens);
  return chunks.filter((chunk) => chunk.needsModel).length;
}

/**
 * Restore anonymized text.
 * @returns {Promise<{text: string, chunks?: number, method: 'tool'|'model'|'none'}>}
 */
export async function runSeek(client, text, mapping, options = {}) {
  const {
    originalText = null,
    maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
    maxParallelRequests = DEFAULT_MAX_PARALLEL_REQUESTS,
    warn = () => {},
  } = options;
  if (maxParallelRequests < 1) throw new Error('max_parallel_requests must be >= 1');

  const restored = restoreWithoutModel(text, mapping, originalText);
  if (restored !== null) return { text: restored, method: 'tool' };
  if (!hasTags(text)) return { text, method: 'none' };

  if (shouldTryToolSeek(text, mapping, originalText)) {
    warn('Tool-Seek self-check failed, falling back to Model-Seek...');
  }

  const { lead, core, trail } = splitEdgeWhitespace(text);
  const chunks = await planSeekChunks(client, core, mapping, maxChunkTokens);
  const restoredText = await executeSeekChunks(client, chunks, maxParallelRequests);
  if (!seekSelfCheck(restoredText)) {
    throw new Error('Seek output still contains unresolved tags after model retry');
  }
  const result = { text: `${lead}${restoredText}${trail}`, method: 'model' };
  if (chunks.length > 1) result.chunks = chunks.length;
  return result;
}

/** Restore several documents that each carry their own mapping. */
export async function runSeekBatch(client, documents, options = {}) {
  const results = [];
  for (const document of documents) {
    const item = await runSeek(client, document.text, document.mapping, options);
    results.push({ file: document.source, text: item.text, ...(item.chunks ? { chunks: item.chunks } : {}) });
  }
  return { results, count: results.length };
}
