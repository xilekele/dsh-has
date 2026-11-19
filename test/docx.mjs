/**
 * Word round trip: anonymize a .docx into <dir>/.has/anonymized, restore it into
 * <dir>/.has/restored, and compare the extracted text with the original.
 *
 * Usage: node test/docx.mjs <file.docx> [--types 人名,电话号码]
 */
import path from 'node:path';
import fs from 'node:fs/promises';

import { resolveConfig } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { anonymizeDocx, restoreDocx, collectParagraphs } from '../lib/docx.js';
import { loadMapping, saveMapping } from '../lib/mapping.js';
import { defaultAnonymizedDir, defaultRestoredDir, seekMappingPath } from '../lib/io.js';
import { readZip } from '../lib/zip.js';
import { runSeek } from '../lib/seek.js';

const argv = process.argv.slice(2);
const file = argv.find((item) => !item.startsWith('--'));
if (!file) {
  console.error('usage: node test/docx.mjs <file.docx> [--types 人名,电话号码]');
  process.exit(1);
}
const typesFlag = argv.indexOf('--types');
const types =
  typesFlag >= 0 && argv[typesFlag + 1]
    ? argv[typesFlag + 1].split(',').map((item) => item.trim()).filter(Boolean)
    : ['人名', '公司名', '电话号码', '电子邮箱', '地址'];

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
  const { client } = await server.ensure({ slots: 1 });

  const startedHide = Date.now();
  const hidden = await anonymizeDocx(client, originalBytes, types, { warn: (m) => console.log('[hide]', m) });
  await fs.mkdir(path.dirname(mappingFile), { recursive: true });
  saveMapping(hidden.mapping, mappingFile);
  await fs.writeFile(anonymizedFile, hidden.bytes);
  console.log(`hide: ${Date.now() - startedHide} ms, ${hidden.paragraphs} paragraphs, ${Object.keys(hidden.mapping).length} mapping entries`);
  console.log(`anonymized text:\n${hidden.anonymized}\n`);

  const startedRestore = Date.now();
  const restored = await restoreDocx(client, hidden.bytes, loadMapping(mappingFile), {
    warn: (m) => console.log('[seek]', m),
    seekText: (text, mapping) => runSeek(client, text, mapping).then((result) => result.text),
  });
  await fs.mkdir(path.dirname(restoredFile), { recursive: true });
  await fs.writeFile(restoredFile, restored.bytes);
  console.log(`restore: ${Date.now() - startedRestore} ms, method=${restored.method}`);

  const restoredText = collectParagraphs(readZip(restored.bytes).get('word/document.xml').toString('utf8'))
    .map((paragraph) => paragraph.text)
    .join('\n');
  const originalText = collectParagraphs(readZip(originalBytes).get('word/document.xml').toString('utf8'))
    .map((paragraph) => paragraph.text)
    .join('\n');
  const identical = originalText === restoredText;
  console.log(`text round-trip identical: ${identical}`);
  if (!identical) {
    console.log('expected:', JSON.stringify(originalText));
    console.log('actual:  ', JSON.stringify(restoredText));
  }
  console.log(`\nanonymized: ${anonymizedFile}\nmapping:    ${mappingFile}\nrestored:   ${restoredFile}`);

  await server.dispose();
  process.exit(identical ? 0 : 2);
} catch (error) {
  console.error('docx round trip failed:', error);
  await server.dispose().catch(() => {});
  process.exit(1);
}
