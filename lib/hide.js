/**
 * hide — anonymize text locally (Phase 1 of the HaS workflow).
 *
 * Per-chunk pipeline: NER → Hide (with/without mapping) → Pair (diff first,
 * model second) → composite split → mapping self-check.
 */

import { takeChunk, splitEdgeWhitespace, DEFAULT_MAX_CHUNK_TOKENS } from './chunker.js';
import { computePairMapping } from './pair.js';
import {
  TAG_PATTERN,
  findCompositeEntries,
  findTags,
  mergeMappings,
  normalizeMappingDict,
  parseJsonTolerant,
} from './mapping.js';
import {
  buildHideWithMessages,
  buildHideWithoutMessages,
  buildNerMessages,
  buildPairMessages,
  buildSplitMessages,
} from './prompts.js';
import { normalizeEntityMap } from './validation.js';

export const HIDE_OVERHEAD = 200;
export const PAIR_OVERHEAD = 230;
export const OUTPUT_RATIO = 1.05;
export const MIN_CHUNK_TOKENS = 100;
export const RETRY_SHRINK_FACTOR = 0.75;
export const MAX_OVERFLOW_RETRIES = 2;

const noop = () => {};

/**
 * Shrink the text budget as the carried mapping grows.
 * Hide: T*(1+α) + F_hide + M ≤ ctx  →  T ≤ (ctx - F_hide - M)/(1+α)
 * Pair: T*(1+α) + F_pair ≤ ctx
 */
export async function computeChunkBudget(countTokens, maxChunkTokens, mapping, contextWindow = 8192) {
  const pairLimit = Math.floor((contextWindow - PAIR_OVERHEAD) / (1 + OUTPUT_RATIO));
  if (!mapping || Object.keys(mapping).length === 0) {
    const hideLimit = Math.floor((contextWindow - HIDE_OVERHEAD) / (1 + OUTPUT_RATIO));
    return Math.min(maxChunkTokens, hideLimit, pairLimit);
  }

  const mappingJson = JSON.stringify(mapping);
  const mappingTokens = await countTokens(mappingJson);
  const hideLimit = Math.floor((contextWindow - HIDE_OVERHEAD - mappingTokens) / (1 + OUTPUT_RATIO));
  const budget = Math.min(maxChunkTokens, hideLimit, pairLimit);
  if (budget < MIN_CHUNK_TOKENS) {
    throw new Error(
      'Accumulated mapping no longer leaves room for more text chunks ' +
        `(${Object.keys(mapping).length} entries, ~${mappingTokens} mapping tokens, derived budget ${hideLimit}). ` +
        'Split the document or reduce the carried mapping.',
    );
  }
  return budget;
}

/** True when every tag in the anonymized text is covered by the mapping. */
export function mappingSelfCheck(anonymizedText, mapping) {
  const textTags = new Set(findTags(anonymizedText));
  if (textTags.size === 0) return true;

  const mappedTags = new Set();
  for (const key of Object.keys(mapping)) {
    for (const match of key.matchAll(new RegExp(TAG_PATTERN.source, 'g'))) mappedTags.add(match[0]);
  }
  for (const tag of textTags) if (!mappedTags.has(tag)) return false;

  return Object.values(mapping).every((values) => Array.isArray(values) && values.length > 0);
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

/**
 * Upper bound for one generation. The model is trained to stop on its own; a
 * degenerate repetition should fail fast (and let the caller shrink) instead of
 * running until the request timeout.
 */
function outputCap(textOrTokens) {
  const tokens = typeof textOrTokens === 'number' ? textOrTokens : Math.ceil(String(textOrTokens).length * 0.9);
  return Math.min(8192, Math.max(768, Math.ceil(tokens * 1.5) + 256));
}

/** Split composite mapping keys with Model-Split; keep them intact on failure. */
export async function handleCompositeTags(client, mapping) {
  const { atomic, composite } = findCompositeEntries(mapping);
  if (Object.keys(composite).length === 0) return mapping;

  const messages = buildSplitMessages(Object.entries(composite).map(([key, values]) => ({ [key]: values })));
  const rawOutput = await client.chat(messages, { maxTokens: 1024 });
  const splitResult = parseJsonTolerant(rawOutput);

  let normalizedSplit;
  try {
    normalizedSplit = normalizeSplitResult(splitResult);
  } catch (error) {
    return mapping;
  }

  const merged = { ...atomic, ...normalizedSplit };
  for (const [compositeKey, values] of Object.entries(composite)) {
    const componentTags = Array.from(compositeKey.matchAll(new RegExp(TAG_PATTERN.source, 'g')), (m) => m[0]);
    if (!componentTags.length || !componentTags.every((tag) => tag in merged)) merged[compositeKey] = values;
  }
  return merged;
}

/** Diff-based pair extraction; null when its self-check fails. */
export function toolPair(originalText, anonymizedText) {
  const result = computePairMapping(originalText, anonymizedText);
  return result.selfCheck?.pass ? result.normalizedMapping : null;
}

/** Model-based pair extraction; rejects mappings that miss tags. */
export async function modelPair(client, originalText, anonymizedText) {
  const rawOutput = await client.chat(buildPairMessages(originalText, anonymizedText), { maxTokens: 2048 });
  const pairResult = parseJsonTolerant(rawOutput);
  if (!pairResult || typeof pairResult !== 'object' || Array.isArray(pairResult)) {
    throw new Error('Model-Pair did not return a JSON object');
  }

  let mapping;
  try {
    mapping = normalizeMappingDict(pairResult);
  } catch (error) {
    throw new Error(`Model-Pair returned invalid mapping (${error.message})`);
  }

  mapping = await handleCompositeTags(client, mapping);
  if (!mappingSelfCheck(anonymizedText, mapping)) {
    throw new Error('Model-Pair mapping did not cover all tags in anonymized text');
  }
  return mapping;
}

/**
 * Anonymize one text chunk.
 * @returns {Promise<{text: string, mapping: object}>}
 */
export async function hideSingleChunk(client, text, types, options = {}) {
  const existingMapping = options.existingMapping ?? null;
  const useToolPair = options.toolPair ?? true;
  const warn = options.warn ?? noop;
  const cap = outputCap(options.chunkTokens ?? text);

  const nerOutput = await client.chat(buildNerMessages(text, types), { maxTokens: 1536 });
  const nerResult = normalizeEntityMap(parseJsonTolerant(nerOutput), { context: 'NER output' });
  if (!Object.values(nerResult).some((values) => values.length > 0)) {
    return { text, mapping: existingMapping ?? {} };
  }

  const messages = existingMapping
    ? buildHideWithMessages(text, types, nerOutput, existingMapping)
    : buildHideWithoutMessages(text, types, nerOutput);
  const anonymizedText = await client.chat(messages, { maxTokens: cap });

  let chunkMapping = null;
  if (useToolPair) {
    chunkMapping = toolPair(text, anonymizedText);
    if (chunkMapping !== null) {
      chunkMapping = await handleCompositeTags(client, chunkMapping);
      if (!mappingSelfCheck(anonymizedText, chunkMapping)) {
        warn('Tool-Pair mapping failed self-check after composite split, falling back to Model-Pair');
        chunkMapping = null;
      } else {
        warn('Tool-Pair succeeded (skipped Model-Pair)');
      }
    } else {
      warn('Tool-Pair self-check failed, falling back to Model-Pair');
    }
  }
  if (chunkMapping === null) chunkMapping = await modelPair(client, text, anonymizedText);

  const merged = existingMapping ? mergeMappings(existingMapping, chunkMapping) : chunkMapping;
  return { text: anonymizedText, mapping: merged };
}

/**
 * Anonymize text with automatic chunking and mapping accumulation.
 * @returns {Promise<{text: string, mapping: object, chunks?: number}>}
 */
export async function runHide(client, text, types, options = {}) {
  const {
    existingMapping = null,
    maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
    toolPair: useToolPair = true,
    contextWindow = 8192,
    warn = noop,
    onProgress = noop,
    signal,
  } = options;

  if (!text || !text.trim()) return { text: text ?? '', mapping: existingMapping ? { ...existingMapping } : {} };

  // The model rewrites prose and drops edge whitespace, so keep it here.
  const { lead, core, trail } = splitEdgeWhitespace(text);
  if (!core) return { text, mapping: existingMapping ? { ...existingMapping } : {} };

  let accumulatedMapping = existingMapping ? { ...existingMapping } : {};
  const anonymizedParts = [];
  let remainingText = core;
  let chunkCount = 0;

  while (remainingText) {
    const chunkBudget = await computeChunkBudget(
      (value) => client.countTokens(value),
      maxChunkTokens,
      Object.keys(accumulatedMapping).length ? accumulatedMapping : null,
      contextWindow,
    );
    const chunk = await takeChunk(remainingText, (value) => client.countTokens(value), chunkBudget, {
      index: chunkCount,
    });
    if (!chunk) break;

    let currentChunkText = chunk.text;
    let currentBudget = chunkBudget;
    let anonymizedText = null;

    for (let attempt = 0; attempt <= MAX_OVERFLOW_RETRIES; attempt += 1) {
      try {
        const result = await hideSingleChunk(client, currentChunkText, types, {
          existingMapping: Object.keys(accumulatedMapping).length ? accumulatedMapping : null,
          toolPair: useToolPair,
          warn,
          signal,
          chunkTokens: chunk.tokenCount ?? currentBudget,
        });
        anonymizedText = result.text;
        accumulatedMapping = result.mapping;
        break;
      } catch (error) {
        // Retryable = context overflow or a generation that ran past the
        // request deadline; a smaller chunk finishes in time.
        if (!error.retryable) throw error;
        if (attempt >= MAX_OVERFLOW_RETRIES) throw error;
        currentBudget = Math.floor(currentBudget * RETRY_SHRINK_FACTOR);
        if (currentBudget < MIN_CHUNK_TOKENS) throw error;
        warn(
          `Generation failed on chunk ${chunkCount + 1} (${error.name}: ${error.message}), retrying with reduced budget ${currentBudget}`,
        );
        const retryChunk = await takeChunk(remainingText, (value) => client.countTokens(value), currentBudget, {
          index: chunkCount,
        });
        if (!retryChunk) throw error;
        currentChunkText = retryChunk.text;
      }
    }

    anonymizedParts.push(anonymizedText);
    remainingText = remainingText.slice(currentChunkText.length);
    chunkCount += 1;
    onProgress({
      chunk: chunkCount,
      charsDone: core.length - remainingText.length,
      charsTotal: core.length,
      mappingKeys: Object.keys(accumulatedMapping).length,
    });
  }

  const result = { text: `${lead}${anonymizedParts.join('')}${trail}`, mapping: accumulatedMapping };
  if (chunkCount > 1) result.chunks = chunkCount;
  return result;
}

/** Run `worker` over `items` with a concurrency limit, preserving order. */
export async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length || 1));

  await Promise.all(
    Array.from({ length: size }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

/** Anonymize several documents, each with an independent mapping. */
export async function runHideBatch(client, documents, types, options = {}) {
  const { maxParallelRequests = 4, ...rest } = options;
  if (maxParallelRequests < 1) throw new Error('max_parallel_requests must be >= 1');
  if (!documents.length) return { results: [], count: 0 };

  const results = await mapConcurrent(documents, maxParallelRequests, async (document) => {
    const hidden = await runHide(client, document.text, types, rest);
    return { file: document.source, ...hidden };
  });

  return { results, count: results.length };
}

export function estimateHideBatchRequestCount(documents) {
  return documents.filter((document) => document.text && document.text.trim()).length;
}
