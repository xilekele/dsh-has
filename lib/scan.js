/**
 * scan — find sensitive entities without replacing them (NER only).
 */

import { chunkText } from './chunker.js';
import { parseJsonTolerant } from './mapping.js';
import { buildNerMessages } from './prompts.js';
import { normalizeEntityMap } from './validation.js';
import { mapConcurrent } from './hide.js';

export const DEFAULT_SCAN_MAX_CHUNK_TOKENS = 5000;

export async function scanSingleChunk(client, text, types, chunkIndex) {
  const rawOutput = await client.chat(buildNerMessages(text, types), { maxTokens: 1536 });
  return normalizeEntityMap(parseJsonTolerant(rawOutput), {
    context: `NER output for chunk ${chunkIndex + 1}`,
  });
}

/** Merge chunk entity maps, preserving first-seen order. */
export function mergeEntities(chunkResults) {
  const merged = {};
  for (const result of chunkResults) {
    for (const [entityType, entities] of Object.entries(result ?? {})) {
      if (!(entityType in merged)) merged[entityType] = [];
      for (const entity of entities) {
        const value = String(entity).trim();
        if (value && !merged[entityType].includes(value)) merged[entityType].push(value);
      }
    }
  }
  return merged;
}

/** @returns {Promise<{entities: Record<string, string[]>}>} */
export async function runScan(client, text, types, options = {}) {
  const { maxChunkTokens = DEFAULT_SCAN_MAX_CHUNK_TOKENS, maxParallelRequests = 4 } = options;
  if (maxParallelRequests < 1) throw new Error('max_parallel_requests must be >= 1');

  const chunks = await chunkText(text, (value) => client.countTokens(value), maxChunkTokens);
  if (!chunks.length) return { entities: {} };

  const results = await mapConcurrent(chunks, maxParallelRequests, (chunk) =>
    scanSingleChunk(client, chunk.text, types, chunk.index),
  );
  return { entities: mergeEntities(results) };
}

/** Scan several documents with a shared request pool. */
export async function runScanBatch(client, documents, types, options = {}) {
  const { maxChunkTokens = DEFAULT_SCAN_MAX_CHUNK_TOKENS, maxParallelRequests = 4 } = options;
  if (maxParallelRequests < 1) throw new Error('max_parallel_requests must be >= 1');
  if (!documents.length) return { results: [], count: 0, summary: {} };

  const plans = [];
  for (const document of documents) {
    const chunks = await chunkText(document.text, (value) => client.countTokens(value), maxChunkTokens);
    plans.push({ document, chunks, results: new Array(chunks.length).fill(null) });
  }

  const tasks = plans.flatMap((plan, documentIndex) =>
    plan.chunks.map((chunk) => ({ plan, documentIndex, chunk })),
  );

  await mapConcurrent(tasks, maxParallelRequests, async (task) => {
    const result = await scanSingleChunk(client, task.chunk.text, types, task.chunk.index);
    task.plan.results[task.chunk.index] = result;
    return result;
  });

  const results = [];
  const summary = {};
  for (const plan of plans) {
    const entities = mergeEntities(plan.results.filter(Boolean));
    results.push({ file: plan.document.source, entities });
    for (const [entityType, values] of Object.entries(entities)) {
      summary[entityType] = (summary[entityType] ?? 0) + values.length;
    }
  }

  return { results, count: results.length, summary };
}

export async function estimateScanRequestCount(text, countTokens, maxChunkTokens = DEFAULT_SCAN_MAX_CHUNK_TOKENS) {
  if (!text || !text.trim()) return 0;
  return (await chunkText(text, countTokens, maxChunkTokens)).length;
}
