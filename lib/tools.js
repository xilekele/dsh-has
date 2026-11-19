/**
 * Tool definitions: has_scan, has_hide, has_restore, has_status.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { runHide, runHideBatch } from './hide.js';
import { runScan, runScanBatch } from './scan.js';
import { runSeek } from './seek.js';
import { describeConfig } from './config.js';
import { anonymizeDocx, docxPlainText, isDocxFile, restoreDocx } from './docx.js';
import { anonymizePdf, anonymizePdfText, isPdfFile, pdfPlainText, restorePdf, restorePdfText } from './pdf.js';
import {
  absolutePath,
  collectDocxFiles,
  collectPdfFiles,
  collectTextDocuments,
  defaultAnonymizedDir,
  defaultRestoredDir,
  ensureDir,
  pathExists,
  readTextDocument,
  seekMappingPath,
  stemName,
  writeJsonOutput,
  writeTextOutput,
} from './io.js';
import { loadMapping, saveMapping } from './mapping.js';

const textBlock = (text) => [{ type: 'text', text }];

const TYPES_PARAM = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  description:
    'Entity type names to look for, e.g. ["人名","电话号码","地址"] for Chinese text or ["person name","phone number","address"] for any other language. Names are open-ended: pick exactly what the user wants hidden. Write them in the SAME language as the text.',
};

const CHUNK_TOKENS_PARAM = {
  type: 'number',
  description:
    'Tokens per model call. Larger chunks finish in fewer calls and send less text twice; smaller chunks limit memory and per-call latency. Defaults are tuned per command - only set this if you have a reason.',
};

const PDF_AS_TEXT_PARAM = {
  type: 'boolean',
  description:
    'For .pdf input: extract the text and write a .txt instead of a re-typeset PDF. Much cheaper for long reports and keeps every character, but figures, tables and layout are lost.',
  default: false,
};

/** Validate an optional per-call chunk size; undefined means "use the config". */
function optionalChunkTokens(value) {
  if (value === undefined || value === null) return undefined;
  const tokens = Math.floor(Number(value));
  if (!Number.isFinite(tokens) || tokens < 100) {
    throw new Error('"maxChunkTokens" must be a number of at least 100.');
  }
  return Math.min(tokens, 8192);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function elapsed(startedAt) {
  return Date.now() - startedAt;
}

function skippedNote(skipped) {
  return skipped?.length ? { skipped, skippedCount: skipped.length } : {};
}

/** Find the mapping directory for an anonymized directory (two supported layouts). */
async function resolveRestoreMappingDir(dir) {
  const local = path.join(dir, 'mappings');
  if (await pathExists(local)) return local;
  const nested = path.join(defaultAnonymizedDir(dir), 'mappings');
  if (await pathExists(nested)) return nested;
  return local;
}

/** Find the mapping file for an anonymized file (next to it, or in the original tree). */
async function resolveRestoreMappingPath(file) {
  const dir = path.dirname(file);
  const candidates = [
    path.join(dir, 'mappings', `${stemName(file)}.mapping.json`),
    seekMappingPath(path.join(defaultAnonymizedDir(dir), 'mappings'), file),
  ];
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  return candidates[0];
}

async function readInputText(args) {
  const wanted = ['text', 'path'].filter((key) => args?.[key] !== undefined && args?.[key] !== '');
  if (wanted.length !== 1) {
    throw new Error('Provide exactly one of "text" or "path".');
  }
  if (args.path === undefined) return { kind: 'text', text: String(args.text) };

  const target = absolutePath(args.path);
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) throw new Error(`Path does not exist: ${target}`);
  if (stat.isDirectory()) return { kind: 'dir', dir: target };
  if (!stat.isFile()) throw new Error(`Not a regular file: ${target}`);

  if (isDocxFile(target)) {
    const bytes = await fsp.readFile(target);
    return { kind: 'docx', file: target, text: docxPlainText(bytes), bytes };
  }

  if (isPdfFile(target)) {
    const bytes = await fsp.readFile(target);
    return { kind: 'pdf', file: target, text: pdfPlainText(bytes), bytes };
  }

  const document = await readTextDocument(target);
  if (document.skipped) throw new Error(`Cannot read ${target} (${document.skipped}).`);
  return { kind: 'file', file: target, text: document.text };
}

function assertTypes(types) {
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error('"types" must be a non-empty array of entity type names.');
  }
  const cleaned = [...new Set(types.map((item) => String(item).trim()).filter(Boolean))];
  if (!cleaned.length) throw new Error('"types" must contain at least one non-empty name.');
  return cleaned;
}

/* ------------------------------------------------------------------ scan */

export function defineScanTool({ getContext }) {
  return {
    name: 'has_scan',
    description:
      'Find (without removing) sensitive entities such as names, phone numbers, ID numbers, addresses or ' +
      'emails in local text or files, using an on-device model. Returns per-type counts; pass reveal:true ' +
      'to also see the matched values. Use this to check what a document contains before deciding what to ' +
      'hide, or to report exposure. Nothing leaves the machine.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to scan. Mutually exclusive with path.' },
        path: {
          type: 'string',
          description:
            'File or directory to scan (directory = immediate children only; UTF-8 text, .docx and .pdf). Mutually exclusive with text.',
        },
        types: TYPES_PARAM,
        maxChunkTokens: CHUNK_TOKENS_PARAM,
        reveal: {
          type: 'boolean',
          description: 'Also return the matched entity values. Default false (counts only).',
          default: false,
        },
      },
      required: ['types'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          total: { type: 'number' },
          counts: { type: 'object', additionalProperties: true },
          entities: { type: 'object', additionalProperties: true },
          summary: { type: 'string' },
        },
      },
      render(_args, value) {
        return textBlock(value?.summary ?? JSON.stringify(value));
      },
    },
    timeoutMs: 900_000,
    async execute(args, exec) {
      const startedAt = Date.now();
      const { config, server, log } = getContext();
      const types = assertTypes(args.types);
      const reveal = args.reveal === true;
      const source = await readInputText(args);
      const scanChunkTokens = optionalChunkTokens(args.maxChunkTokens) ?? config.scanMaxChunkTokens;

      return server.withClient(async (client) => {
        const warn = (message) => log('debug', message);
        let result;
        if (source.kind === 'dir') {
          const { documents, skipped } = await collectTextDocuments(source.dir);
          for (const file of await collectDocxFiles(source.dir)) {
            try {
              documents.push({ source: file, text: docxPlainText(await fsp.readFile(file)) });
            } catch (error) {
              skipped.push({ file, reason: `docx_failed: ${error?.message ?? error}` });
            }
          }
          for (const file of await collectPdfFiles(source.dir)) {
            try {
              documents.push({ source: file, text: pdfPlainText(await fsp.readFile(file)) });
            } catch (error) {
              skipped.push({ file, reason: `pdf_failed: ${error?.message ?? error}` });
            }
          }
          const batch = await runScanBatch(client, documents, types, {
            maxChunkTokens: scanChunkTokens,
            maxParallelRequests: config.maxParallelRequests,
          });
          const counts = {};
          for (const item of batch.results) {
            for (const [type, values] of Object.entries(item.entities)) {
              counts[type] = (counts[type] ?? 0) + values.length;
            }
          }
          result = {
            ok: true,
            command: 'scan',
            source: { kind: 'dir', path: source.dir },
            types,
            total: Object.values(counts).reduce((sum, count) => sum + count, 0),
            counts,
            summary: renderScanSummary(counts, reveal ? batch.results : null, source.dir),
            ...(reveal ? { entities: batch.results } : {}),
            ...skippedNote(skipped),
          };
        } else {
          const scan = await runScan(client, source.text, types, {
            maxChunkTokens: scanChunkTokens,
            maxParallelRequests: config.maxParallelRequests,
          });
          const counts = {};
          for (const [type, values] of Object.entries(scan.entities)) counts[type] = values.length;
          result = {
            ok: true,
            command: 'scan',
            source: source.kind === 'text' ? { kind: 'text' } : { kind: 'file', path: source.file },
            types,
            total: Object.values(counts).reduce((sum, count) => sum + count, 0),
            counts,
            summary: renderScanSummary(counts, reveal ? [{ file: source.file ?? null, entities: scan.entities }] : null, null),
            ...(reveal ? { entities: scan.entities } : {}),
          };
        }
        result.elapsedMs = elapsed(startedAt);
        result.model = config.modelPath ? path.basename(config.modelPath) : null;
        return result;
      }, { slots: config.maxParallelRequests, signal: exec?.signal });
    },
  };
}

function renderScanSummary(counts, revealed, dir) {
  const entries = Object.entries(counts ?? {}).filter(([, count]) => count > 0);
  if (!entries.length) return 'No matching entities found.';
  const lines = entries.map(([type, count]) => `- ${type}: ${count}`);
  const head = `Found ${entries.reduce((sum, [, count]) => sum + count, 0)} entit${entries.reduce((sum, [, count]) => sum + count, 0) === 1 ? 'y' : 'ies'} (${entries.length} type${entries.length === 1 ? '' : 's'}):`;
  if (!revealed) return [head, ...lines, '(counts only; pass reveal:true to list values)'].join('\n');

  const detail = [];
  for (const item of revealed) {
    const label = item.file ? path.relative(dir ?? process.cwd(), item.file) : null;
    for (const [type, values] of Object.entries(item.entities)) {
      if (!values.length) continue;
      detail.push(`  ${label ? `${label} → ` : ''}${type}: ${values.join('、')}`);
    }
  }
  return [head, ...lines, '', ...detail].join('\n');
}

/* ------------------------------------------------------------------ hide */

export function defineHideTool({ getContext }) {
  return {
    name: 'has_hide',
    description:
      'Replace sensitive entities in local text or files with reversible tags like <人名[1].personal.name>, ' +
      'using an on-device model, and save the mapping needed to restore them. Use this BEFORE sending ' +
      'sensitive content to a remote model or service, then pass the tagged text on and call has_restore ' +
      'afterwards. Text input returns the tagged text; file/directory input writes anonymized files and ' +
      'returns their paths. The mapping file is never printed - keep it on disk.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to anonymize. Mutually exclusive with path.' },
        path: {
          type: 'string',
          description: 'File (.txt, .docx, .pdf) or directory to anonymize (directory = immediate children only). Mutually exclusive with text.',
        },
        types: TYPES_PARAM,
        maxChunkTokens: CHUNK_TOKENS_PARAM,
        pdfAsText: PDF_AS_TEXT_PARAM,
        mappingPath: {
          type: 'string',
          description:
            'Where to write the mapping JSON (required for later restore). Defaults to a timestamped file under the dsh-has state directory for text input, or <output>/mappings/<name>.mapping.json for files.',
        },
        outputPath: {
          type: 'string',
          description: 'Output file (single-file input) or directory (directory input). Defaults to <dir>/.has/anonymized.',
        },
        reveal: {
          type: 'boolean',
          description: 'For file input, also return the anonymized file contents. Default false (paths only).',
          default: false,
        },
      },
      required: ['types'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          outputMode: { type: 'string' },
          text: { type: 'string' },
          mappingPath: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render(_args, value) {
        return textBlock(value?.summary ?? JSON.stringify(value));
      },
    },
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const startedAt = Date.now();
      const { config, server, log } = getContext();
      const types = assertTypes(args.types);
      const reveal = args.reveal === true;
      const source = await readInputText(args);
      const hideChunkTokens = optionalChunkTokens(args.maxChunkTokens) ?? config.maxChunkTokens;
      const warn = (message) => log('debug', message);

      return server.withClient(async (client) => {
        if (source.kind === 'text') {
          const mappingPath = args.mappingPath
            ? absolutePath(args.mappingPath)
            : path.join(config.stateDir, 'mappings', `hide-${nowStamp()}.mapping.json`);
          const result = await runHide(client, source.text, types, {
            maxChunkTokens: hideChunkTokens,
            toolPair: config.toolPair,
            warn,
          });
          await saveMapping(result.mapping, mappingPath);
          return {
            ok: true,
            command: 'hide',
            outputMode: 'text',
            source: { kind: 'text' },
            text: result.text,
            mappingPath,
            mappingEntries: Object.keys(result.mapping).length,
            ...(result.chunks ? { chunks: result.chunks } : {}),
            summary: renderHideTextSummary(result, mappingPath),
            elapsedMs: elapsed(startedAt),
          };
        }

        if (source.kind === 'file' || source.kind === 'docx' || source.kind === 'pdf') {
          const isDocx = source.kind === 'docx';
          const dir = source.file ? path.dirname(source.file) : process.cwd();
          const outputPath = args.outputPath
            ? absolutePath(args.outputPath)
            : path.join(defaultAnonymizedDir(dir), path.basename(source.file));
          const mappingPath = args.mappingPath
            ? absolutePath(args.mappingPath)
            : path.join(path.dirname(outputPath), 'mappings', `${stemName(source.file)}.mapping.json`);

          const pdfAsText = args.pdfAsText === true && source.kind === 'pdf';
          let result;
          if (isDocx) {
            const hidden = await anonymizeDocx(client, source.bytes, types, {
              maxChunkTokens: hideChunkTokens,
              toolPair: config.toolPair,
              warn,
            });
            await ensureDir(path.dirname(outputPath));
            await fsp.writeFile(outputPath, hidden.bytes);
            result = { mapping: hidden.mapping, text: hidden.anonymized };
          } else if (source.kind === 'pdf') {
            const hidden = pdfAsText
              ? await anonymizePdfText(client, source.bytes, types, {
                  maxChunkTokens: hideChunkTokens,
                  toolPair: config.toolPair,
                  warn,
                })
              : await anonymizePdf(client, source.bytes, types, {
                  maxChunkTokens: hideChunkTokens,
                  toolPair: config.toolPair,
                  warn,
                });
            const target =
              pdfAsText && !args.outputPath
                ? path.join(path.dirname(outputPath), `${stemName(source.file)}.txt`)
                : outputPath;
            await ensureDir(path.dirname(target));
            if (pdfAsText) {
              await writeTextOutput(target, hidden.text, { overwrite: true });
            } else {
              await fsp.writeFile(target, hidden.bytes);
            }
            result = {
              mapping: hidden.mapping,
              text: hidden.text ?? hidden.anonymized,
              outputPath: target,
            };
          } else {
            result = await runHide(client, source.text, types, {
              maxChunkTokens: hideChunkTokens,
              toolPair: config.toolPair,
              warn,
            });
            await ensureDir(path.dirname(outputPath));
            await writeTextOutput(outputPath, result.text, { overwrite: true });
          }
          await saveMapping(result.mapping, mappingPath);

          const output = {
            file: source.file,
            output: result.outputPath ?? outputPath,
            mapping: mappingPath,
            ...(result.chunks ? { chunks: result.chunks } : {}),
          };
          return {
            ok: true,
            command: 'hide',
            outputMode: 'files',
            source: { kind: 'file', path: source.file },
            outputs: [output],
            ...(reveal ? { text: result.text } : {}),
            summary: renderHideFileSummary([output]),
            elapsedMs: elapsed(startedAt),
          };
        }

        const outDir = args.outputPath ? absolutePath(args.outputPath) : defaultAnonymizedDir(source.dir);
        const mappingDir = path.join(outDir, 'mappings');
        const { documents, skipped } = await collectTextDocuments(source.dir);
        const batch = await runHideBatch(client, documents, types, {
          maxChunkTokens: hideChunkTokens,
          toolPair: config.toolPair,
          maxParallelRequests: config.maxParallelRequests,
          warn,
        });

        const outputs = [];
        for (const item of batch.results) {
          const output = path.join(outDir, path.basename(item.file));
          const mapping = path.join(mappingDir, `${stemName(item.file)}.mapping.json`);
          await ensureDir(outDir);
          await writeTextOutput(output, item.text, { overwrite: true });
          await saveMapping(item.mapping, mapping);
          outputs.push({ file: item.file, output, mapping, ...(item.chunks ? { chunks: item.chunks } : {}) });
        }

        // Word documents are processed one at a time: rewriting runs needs the
        // per-paragraph mapping, and these are usually the minority of a folder.
        const docxFiles = await collectDocxFiles(source.dir);
        for (const file of docxFiles) {
          try {
            const hidden = await anonymizeDocx(client, await fsp.readFile(file), types, {
              maxChunkTokens: hideChunkTokens,
              toolPair: config.toolPair,
              warn,
            });
            const output = path.join(outDir, path.basename(file));
            const mapping = path.join(mappingDir, `${stemName(file)}.mapping.json`);
            await ensureDir(outDir);
            await fsp.writeFile(output, hidden.bytes);
            await saveMapping(hidden.mapping, mapping);
            outputs.push({ file, output, mapping });
          } catch (error) {
            skipped.push({ file, reason: `docx_failed: ${error?.message ?? error}` });
          }
        }

        const pdfAsText = args.pdfAsText === true;
        for (const file of await collectPdfFiles(source.dir)) {
          try {
            const hidden = pdfAsText
              ? await anonymizePdfText(client, await fsp.readFile(file), types, {
                  maxChunkTokens: hideChunkTokens,
                  toolPair: config.toolPair,
                  warn,
                })
              : await anonymizePdf(client, await fsp.readFile(file), types, {
                  maxChunkTokens: hideChunkTokens,
                  toolPair: config.toolPair,
                  warn,
                });
            const output = path.join(
              outDir,
              pdfAsText ? `${stemName(file)}.txt` : path.basename(file),
            );
            const mapping = path.join(mappingDir, `${stemName(file)}.mapping.json`);
            await ensureDir(outDir);
            if (pdfAsText) {
              await writeTextOutput(output, hidden.text, { overwrite: true });
            } else {
              await fsp.writeFile(output, hidden.bytes);
            }
            await saveMapping(hidden.mapping, mapping);
            outputs.push({ file, output, mapping });
          } catch (error) {
            skipped.push({ file, reason: `pdf_failed: ${error?.message ?? error}` });
          }
        }
        return {
          ok: true,
          command: 'hide',
          outputMode: 'files',
          source: { kind: 'dir', path: source.dir },
          outputs,
          count: outputs.length,
          ...skippedNote(skipped),
          summary: renderHideFileSummary(outputs, skipped),
          elapsedMs: elapsed(startedAt),
        };
      }, { slots: config.maxParallelRequests, signal: exec?.signal });
    },
  };
}

function renderHideTextSummary(result, mappingPath) {
  const entries = Object.keys(result.mapping ?? {}).length;
  const chunks = result.chunks ? ` in ${result.chunks} chunks` : '';
  const example = result.text?.match(/<[^<>\[\]]+\[\d+\]\.[^<>]+>/)?.[0];
  const tagNote = example
    ? `Tags such as ${example}: keep them byte-for-byte when you use the text, then call has_restore with this mappingPath.`
    : 'No entity tag was produced (nothing matched the requested types).';
  return [
    `Anonymized local text${chunks}; ${entries} mapping entr${entries === 1 ? 'y' : 'ies'} saved to ${mappingPath}.`,
    tagNote,
  ].join('\n');
}

function renderHideFileSummary(outputs, skipped) {
  const lines = outputs.map((item) => `- ${item.file} → ${item.output}`);
  const mapped = outputs.length ? `\nMappings: ${path.dirname(outputs[0].mapping)}` : '';
  const skip = skipped?.length ? `\nSkipped ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} (binary/non-UTF-8/unreadable).` : '';
  return [`Anonymized ${outputs.length} file${outputs.length === 1 ? '' : 's'}:`, ...lines, mapped + skip].join('\n');
}

/* --------------------------------------------------------------- restore */

export function defineRestoreTool({ getContext }) {
  return {
    name: 'has_restore',
    description:
      'Restore original values into text or files that has_hide replaced with tags such as ' +
      '<人名[1].personal.name>, using the mapping JSON saved by has_hide. Deterministic replacement is tried ' +
      'first; the on-device model is used only when needed (for example after the tagged text was translated). ' +
      'Text input returns the restored text; file input writes a restored file and returns its path.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Tagged text to restore. Mutually exclusive with path.' },
        path: {
          type: 'string',
          description: 'File (.txt, .docx, .pdf) or directory to restore (directory = immediate children only). Mutually exclusive with text.',
        },
        mappingPath: {
          type: 'string',
          description:
            'Mapping JSON written by has_hide. Required for text input; for files it defaults to <dir>/.has/anonymized/mappings/<name>.mapping.json.',
        },
        outputPath: {
          type: 'string',
          description: 'Output file (single file) or directory. Defaults to <dir>/.has/restored.',
        },
        originalPath: {
          type: 'string',
          description: 'Optional original file; helps language checks when the tagged text was translated.',
        },
        maxChunkTokens: CHUNK_TOKENS_PARAM,
        pdfAsText: PDF_AS_TEXT_PARAM,
        reveal: {
          type: 'boolean',
          description: 'For file input, also return the restored contents. Default false (paths only).',
          default: false,
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          method: { type: 'string' },
          text: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render(_args, value) {
        return textBlock(value?.summary ?? JSON.stringify(value));
      },
    },
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const startedAt = Date.now();
      const { config, server, log } = getContext();
      const reveal = args.reveal === true;
      const source = await readInputText(args);
      const seekChunkTokens = optionalChunkTokens(args.maxChunkTokens) ?? config.maxChunkTokens;
      const warn = (message) => log('debug', message);

      async function restoreOne(client, text, mappingPath, originalText) {
        const mapping = await loadMapping(mappingPath);
        return runSeek(client, text, mapping, {
          originalText: originalText ?? null,
          maxChunkTokens: seekChunkTokens,
          maxParallelRequests: config.maxParallelRequests,
          warn,
        });
      }

      return server.withClient(async (client) => {
        if (source.kind === 'text') {
          if (!args.mappingPath) throw new Error('mappingPath is required when restoring text.');
          const mappingPath = absolutePath(args.mappingPath);
          if (!(await pathExists(mappingPath))) throw new Error(`Mapping file not found: ${mappingPath}`);
          const originalText = args.originalPath
            ? (await readTextDocument(absolutePath(args.originalPath))).text ?? null
            : null;
          const result = await restoreOne(client, source.text, mappingPath, originalText);
          return {
            ok: true,
            command: 'restore',
            outputMode: 'text',
            source: { kind: 'text' },
            method: result.method,
            text: result.text,
            ...(result.chunks ? { chunks: result.chunks } : {}),
            summary: `Restored ${result.method === 'tool' ? 'by direct mapping replacement' : 'with the on-device model'}${result.chunks ? ` in ${result.chunks} chunks` : ''}.`,
            elapsedMs: elapsed(startedAt),
          };
        }

        if (source.kind === 'file' || source.kind === 'docx' || source.kind === 'pdf') {
          const isDocx = source.kind === 'docx';
          const mappingPath = args.mappingPath
            ? absolutePath(args.mappingPath)
            : await resolveRestoreMappingPath(source.file);
          if (!(await pathExists(mappingPath))) throw new Error(`Mapping file not found: ${mappingPath}`);

          const outputPath = args.outputPath
            ? absolutePath(args.outputPath)
            : path.join(defaultRestoredDir(path.dirname(source.file)), path.basename(source.file));
          const originalText = args.originalPath
            ? (await readTextDocument(absolutePath(args.originalPath))).text ?? null
            : null;

          const pdfAsText = args.pdfAsText === true && source.kind === 'pdf';
          let result;
          if (isDocx) {
            result = await restoreDocx(client, source.bytes, await loadMapping(mappingPath), {
              warn,
              seekText: (text, mapping) => runSeek(client, text, mapping, { warn }).then((value) => value.text),
            });
            await ensureDir(path.dirname(outputPath));
            await fsp.writeFile(outputPath, result.bytes);
          } else if (source.kind === 'pdf') {
            const mapping = await loadMapping(mappingPath);
            const target =
              pdfAsText && !args.outputPath
                ? path.join(defaultRestoredDir(path.dirname(source.file)), `${stemName(source.file)}.txt`)
                : outputPath;
            if (pdfAsText) {
              result = await restorePdfText(client, source.bytes, mapping, { warn });
              await ensureDir(path.dirname(target));
              await writeTextOutput(target, result.text, { overwrite: true });
            } else {
              result = await restorePdf(client, source.bytes, mapping, { warn });
              await ensureDir(path.dirname(target));
              await fsp.writeFile(target, result.bytes);
            }
            result.outputPath = target;
          } else {
            result = await restoreOne(client, source.text, mappingPath, originalText);
            await ensureDir(path.dirname(outputPath));
            await writeTextOutput(outputPath, result.text, { overwrite: true });
          }
          const output = { file: source.file, output: outputPath, method: result.method, ...(result.chunks ? { chunks: result.chunks } : {}) };
          return {
            ok: true,
            command: 'restore',
            outputMode: 'files',
            source: { kind: 'file', path: source.file },
            outputs: [output],
            ...(reveal ? { text: result.text } : {}),
            summary: `Restored ${source.file} → ${outputPath} (${result.method === 'tool' ? 'direct mapping' : 'model'}).`,
            elapsedMs: elapsed(startedAt),
          };
        }

        const outDir = args.outputPath ? absolutePath(args.outputPath) : defaultRestoredDir(source.dir);
        const mappingDir = args.mappingPath
          ? absolutePath(args.mappingPath)
          : await resolveRestoreMappingDir(source.dir);

        const { documents, skipped } = await collectTextDocuments(source.dir);
        const outputs = [];
        const missing = [];
        for (const document of documents) {
          const mappingPath = seekMappingPath(mappingDir, document.source);
          if (!(await pathExists(mappingPath))) {
            missing.push({ file: document.source, reason: 'mapping_not_found' });
            continue;
          }
          const result = await restoreOne(client, document.text, mappingPath, null);
          const output = path.join(outDir, path.basename(document.source));
          await ensureDir(outDir);
          await writeTextOutput(output, result.text, { overwrite: true });
          outputs.push({ file: document.source, output, method: result.method, ...(result.chunks ? { chunks: result.chunks } : {}) });
        }

        for (const file of await collectDocxFiles(source.dir)) {
          const mappingPath = seekMappingPath(mappingDir, file);
          if (!(await pathExists(mappingPath))) {
            missing.push({ file, reason: 'mapping_not_found' });
            continue;
          }
          try {
            const result = await restoreDocx(client, await fsp.readFile(file), await loadMapping(mappingPath), {
              warn,
              seekText: (text, mapping) => runSeek(client, text, mapping, { warn }).then((value) => value.text),
            });
            const output = path.join(outDir, path.basename(file));
            await ensureDir(outDir);
            await fsp.writeFile(output, result.bytes);
            outputs.push({ file, output, method: result.method });
          } catch (error) {
            missing.push({ file, reason: `docx_failed: ${error?.message ?? error}` });
          }
        }

        for (const file of await collectPdfFiles(source.dir)) {
          const mappingPath = seekMappingPath(mappingDir, file);
          if (!(await pathExists(mappingPath))) {
            missing.push({ file, reason: 'mapping_not_found' });
            continue;
          }
          try {
            const result = await restorePdf(client, await fsp.readFile(file), await loadMapping(mappingPath), { warn });
            const output = path.join(outDir, path.basename(file));
            await ensureDir(outDir);
            await fsp.writeFile(output, result.bytes);
            outputs.push({ file, output, method: result.method });
          } catch (error) {
            missing.push({ file, reason: `pdf_failed: ${error?.message ?? error}` });
          }
        }
        const skippedAll = [...skipped, ...missing];
        return {
          ok: true,
          command: 'restore',
          outputMode: 'files',
          source: { kind: 'dir', path: source.dir },
          outputs,
          count: outputs.length,
          ...skippedNote(skippedAll),
          summary:
            `Restored ${outputs.length} file${outputs.length === 1 ? '' : 's'} into ${outDir}.` +
            (skippedAll.length ? ` Skipped ${skippedAll.length} (no mapping or unreadable).` : ''),
          elapsedMs: elapsed(startedAt),
        };
      }, { slots: config.maxParallelRequests, signal: exec?.signal });
    },
  };
}

/* ---------------------------------------------------------------- status */

export function defineStatusTool({ getContext }) {
  return {
    name: 'has_status',
    description:
      'Report dsh-has readiness: whether the local HaS model and llama-server are installed, whether the ' +
      'local server is running (and on which port), and where mappings/state live. Use it when a has_* ' +
      'call fails or before promising on-device anonymization. action:"stop" frees the model from memory.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'start', 'stop'],
          description: 'check (default) reports state; start warms the server; stop shuts it down.',
          default: 'check',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return textBlock(value?.summary ?? JSON.stringify(value));
      },
    },
    timeoutMs: 180_000,
    async execute(args = {}) {
      const { config, server } = getContext();
      const action = args.action ?? 'check';
      const startedAt = Date.now();

      if (action === 'stop') {
        await server.dispose();
      }
      if (action === 'start' || action === 'check') {
        // A check that the runtime is usable, without loading the model for "check".
        if (action === 'start') await server.ensure({ slots: 1 });
      }

      const info = await describeConfig(config);
      const running = server.status();
      const ready = Boolean(info.modelPresent && info.llamaServerPath);
      const lines = [
        `dsh-has ${action === 'check' ? 'status' : action}: ${ready ? 'ready' : 'NOT ready'}`,
        `- model: ${info.modelPresent ? info.modelPath : `missing (expected ${path.join(info.stateDir, 'models', 'has_text_model.gguf')})`}`,
        `- llama-server: ${info.llamaServerPath ?? 'not found (install llama.cpp or set llamaServerPath)'}`,
        `- local server: ${running.running ? `running on ${running.baseUrl} (slots ${running.slots ?? '?'}, pid ${running.pid ?? 'external'})` : 'stopped (starts on first use)'}`,
        `- state dir: ${info.stateDir}`,
        `- mappings for text input: ${path.join(info.stateDir, 'mappings')}`,
        `- chunk budget: ${info.maxChunkTokens} tokens (scan ${info.scanMaxChunkTokens})`,
      ];
      if (action === 'start' && running.running) lines.push('- server warmed up.');
      if (action === 'stop') lines.push('- server stopped and memory released.');

      return {
        ok: true,
        command: 'status',
        action,
        ready,
        ...info,
        server: running,
        summary: lines.join('\n'),
        elapsedMs: elapsed(startedAt),
      };
    },
  };
}

export function createTools({ getContext }) {
  return [
    defineScanTool({ getContext }),
    defineHideTool({ getContext }),
    defineRestoreTool({ getContext }),
    defineStatusTool({ getContext }),
  ];
}
