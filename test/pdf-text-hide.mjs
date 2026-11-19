/**
 * Anonymize a PDF into a plain .txt (no re-typesetting), with progress on stderr
 * and a resume checkpoint so a crash does not throw away hours of work.
 *
 * Usage:
 *   node test/pdf-text-hide.mjs <file.pdf> [--types 人名,公司名] [--out <dir>] [--fresh]
 *
 * Writes <dir>/.has/anonymized/<name>.txt and
 *        <dir>/.has/anonymized/mappings/<name>.mapping.json
 * Checkpoint: <txt>.state.json (deleted on success; --fresh starts over).
 */
import path from 'node:path';
import fsp from 'node:fs/promises';

import { resolveConfig } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { extractDocument } from '../lib/pdf-text.js';
import { computeChunkBudget, hideSingleChunk } from '../lib/hide.js';
import { takeChunk, splitEdgeWhitespace } from '../lib/chunker.js';
import { saveMapping } from '../lib/mapping.js';
import { defaultAnonymizedDir, ensureDir, pathExists, stemName } from '../lib/io.js';

const RETRY_SHRINK_FACTOR = 0.75;
const MAX_OVERFLOW_RETRIES = 2;
const MAX_TRANSPORT_RETRIES = 3;

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const isFlagValue = (index) => ['--types', '--out'].includes(argv[index - 1]);
const file = argv.find((item, index) => !item.startsWith('--') && !isFlagValue(index));
if (!file) {
  console.error('usage: node test/pdf-text-hide.mjs <file.pdf> [--types 人名,公司名] [--out <dir>] [--fresh]');
  process.exit(1);
}
const fresh = argv.includes('--fresh');
const types = (flag('types') ?? '人名,公司名,银行名,电话号码,电子邮箱,地址,身份证号,银行卡号,统一社会信用代码')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const source = path.resolve(file);
const dir = flag('out') ? path.resolve(flag('out')) : path.dirname(source);
const outputPath = path.join(defaultAnonymizedDir(dir), `${stemName(source)}.txt`);
const mappingPath = path.join(defaultAnonymizedDir(dir), 'mappings', `${stemName(source)}.mapping.json`);
const statePath = `${outputPath}.state.json`;

const config = resolveConfig({});
const server = new ServerManager(config, { log: (level, message) => console.error(`[${level}] ${message}`) });
const started = Date.now();
const transportRetryable = (error) =>
  /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|Cannot connect to llama-server/i.test(
    String(error?.message ?? error),
  );

try {
  const buffer = await fsp.readFile(source);
  const document = extractDocument(buffer);
  if (!document.text.trim()) throw new Error('this PDF has no extractable text layer (scanned images are not OCRed)');

  // Keep edge whitespace out of the model round trip, exactly like runHide does.
  const { lead, core, trail } = splitEdgeWhitespace(document.text);

  let state = null;
  if (!fresh && (await pathExists(statePath))) {
    try {
      state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
      console.error(`[resume] ${state.chunks} chunks, ${Object.keys(state.mapping ?? {}).length} mapping keys already done`);
    } catch {
      state = null;
    }
  }
  if (!state) state = { parts: [], mapping: {}, remaining: core, chunks: 0 };

  await server.withClient(
    async (client) => {
      const countTokens = (value) => client.countTokens(value);
      let { parts, mapping, remaining, chunks } = state;
      let transportRetries = 0;

      while (remaining) {
        const budget = await computeChunkBudget(
          countTokens,
          config.maxChunkTokens,
          Object.keys(mapping).length ? mapping : null,
          config.contextPerSlot,
        );
        let chunk = await takeChunk(remaining, countTokens, budget, { index: chunks });
        if (!chunk) break;

        let anonymized = null;
        let currentBudget = budget;
        for (let attempt = 0; attempt <= MAX_OVERFLOW_RETRIES; attempt += 1) {
          try {
            const result = await hideSingleChunk(client, chunk.text, types, {
              existingMapping: Object.keys(mapping).length ? mapping : null,
              toolPair: config.toolPair,
              warn: (message) => console.error('[warn]', message),
            });
            anonymized = result.text;
            mapping = result.mapping;
            break;
          } catch (error) {
            if (transportRetryable(error) && transportRetries < MAX_TRANSPORT_RETRIES) {
              transportRetries += 1;
              console.error(
                `[retry] llama-server went away (${error?.message ?? error}); restarting (attempt ${transportRetries}/${MAX_TRANSPORT_RETRIES})`,
              );
              await server.restart({ slots: 1 });
              attempt -= 1;
              continue;
            }
            if (!error?.retryable) throw error;
            if (attempt >= MAX_OVERFLOW_RETRIES) throw error;
            currentBudget = Math.floor(currentBudget * RETRY_SHRINK_FACTOR);
            if (currentBudget < 100) throw error;
            console.error(`[warn] generation failed on chunk ${chunks + 1} (${error?.message ?? error}); retrying with ${currentBudget} tokens`);
            const retryChunk = await takeChunk(remaining, countTokens, currentBudget, { index: chunks });
            if (!retryChunk) throw error;
            chunk = retryChunk;
          }
        }

        parts.push(anonymized);
        remaining = remaining.slice(chunk.text.length);
        chunks += 1;
        await fsp.writeFile(statePath, JSON.stringify({ parts, mapping, remaining, chunks }), 'utf8');

        const charsDone = core.length - remaining.length;
        const seconds = (Date.now() - started) / 1000;
        const rate = charsDone / Math.max(seconds, 1);
        const etaMinutes = rate > 0 ? Math.round((core.length - charsDone) / rate / 60) : 0;
        console.error(
          `[progress] chunk ${chunks}: ${charsDone}/${core.length} chars (${((charsDone / core.length) * 100).toFixed(1)}%), ` +
            `${Object.keys(mapping).length} mapping keys, ${rate.toFixed(1)} chars/s, eta ${etaMinutes} min`,
        );
      }

      const text = lead + parts.join('') + trail;
      await ensureDir(path.dirname(outputPath));
      await fsp.writeFile(outputPath, text, 'utf8');
      await saveMapping(mapping, mappingPath);
      await fsp.rm(statePath, { force: true });
      return text;
    },
    { slots: 1 },
  );

  const text = await fsp.readFile(outputPath, 'utf8');
  const saved = JSON.parse(await fsp.readFile(mappingPath, 'utf8'));
  const entries = Object.keys(saved.mapping ?? saved).length;
  console.log(
    JSON.stringify(
      {
        ok: true,
        source,
        output: outputPath,
        mapping: mappingPath,
        pages: document.pages.length,
        mappingEntries: entries,
        chars: text.length,
        elapsedMs: Date.now() - started,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error('pdf text hide failed:', error);
  process.exitCode = 1;
} finally {
  await server.dispose().catch(() => {});
}
