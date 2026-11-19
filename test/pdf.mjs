/**
 * PDF round trip: anonymize a .pdf into <dir>/.has/anonymized, restore it into
 * <dir>/.has/restored, and compare the extracted text with the original.
 *
 * Line breaks are expected to change (the rebuilt PDF re-wraps the text), so
 * the comparison collapses whitespace.
 *
 * Usage: node test/pdf.mjs <file.pdf> [--types 人名,电话号码]
 */
import path from 'node:path';
import fs from 'node:fs/promises';

import { resolveConfig } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { anonymizePdf, pdfPlainText, restorePdf } from '../lib/pdf.js';
import { loadMapping, saveMapping } from '../lib/mapping.js';
import { defaultAnonymizedDir, defaultRestoredDir, seekMappingPath } from '../lib/io.js';

const normalize = (text) => text.replace(/\s+/g, '').trim();

const argv = process.argv.slice(2);
const file = argv.find((item) => !item.startsWith('--'));
if (!file) {
  console.error('usage: node test/pdf.mjs <file.pdf> [--types 人名,电话号码]');
  process.exit(1);
}
const typesFlag = argv.indexOf('--types');
const types =
  typesFlag >= 0 && argv[typesFlag + 1]
    ? argv[typesFlag + 1].split(',').map((item) => item.trim()).filter(Boolean)
    : ['人名', '公司名', '电话号码', '电子邮箱', '地址', '银行卡号'];

const config = resolveConfig({});
const source = path.resolve(file);
const dir = path.dirname(source);
const anonymizedDir = defaultAnonymizedDir(dir);
const mappingFile = seekMappingPath(path.join(anonymizedDir, 'mappings'), source);
const anonymizedFile = path.join(anonymizedDir, path.basename(source));
const restoredFile = path.join(defaultRestoredDir(dir), path.basename(source));

const server = new ServerManager(config, { log: (level, message) => console.log(`[${level}] ${message}`) });

try {
  const originalBytes = await fs.readFile(source);
  const originalText = pdfPlainText(originalBytes);
  console.log('extracted text:');
  console.log(originalText);
  console.log('');

  const { client } = await server.ensure({ slots: 1 });

  const startedHide = Date.now();
  const hidden = await anonymizePdf(client, originalBytes, types, { warn: (m) => console.log('[hide]', m) });
  await fs.mkdir(path.dirname(mappingFile), { recursive: true });
  saveMapping(hidden.mapping, mappingFile);
  await fs.writeFile(anonymizedFile, hidden.bytes);
  console.log(`hide: ${Date.now() - startedHide} ms, ${hidden.pages} pages, ${Object.keys(hidden.mapping).length} mapping entries`);
  console.log(`anonymized text:\n${hidden.anonymized}\n`);

  const anonymizedText = pdfPlainText(hidden.bytes);
  console.log(`anonymized pdf text:\n${anonymizedText}\n`);

  const startedRestore = Date.now();
  const restored = await restorePdf(client, hidden.bytes, loadMapping(mappingFile), {
    warn: (m) => console.log('[seek]', m),
  });
  await fs.mkdir(path.dirname(restoredFile), { recursive: true });
  await fs.writeFile(restoredFile, restored.bytes);
  console.log(`restore: ${Date.now() - startedRestore} ms, method=${restored.method}`);

  const restoredText = pdfPlainText(restored.bytes);
  const identical = normalize(originalText) === normalize(restoredText);
  console.log(`text round-trip identical (whitespace-insensitive): ${identical}`);
  if (!identical) {
    console.log('expected:', JSON.stringify(normalize(originalText)));
    console.log('actual:  ', JSON.stringify(normalize(restoredText)));
  }
  console.log(`\nanonymized: ${anonymizedFile}\nmapping:    ${mappingFile}\nrestored:   ${restoredFile}`);

  await server.dispose();
  process.exit(identical ? 0 : 2);
} catch (error) {
  console.error('pdf round trip failed:', error);
  await server.dispose().catch(() => {});
  process.exit(1);
}
