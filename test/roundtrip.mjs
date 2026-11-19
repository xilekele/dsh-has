/**
 * File-mode round trip: hide a file into <dir>/.has/anonymized, restore it into
 * <dir>/.has/restored, and compare the bytes with the original.
 *
 * Usage: node test/roundtrip.mjs <file> [--types 人名,电话号码] [--keep]
 */
import path from 'node:path';
import fs from 'node:fs/promises';

import { resolveConfig } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { runHide } from '../lib/hide.js';
import { runSeek } from '../lib/seek.js';
import { loadMapping, saveMapping } from '../lib/mapping.js';
import {
  defaultAnonymizedDir,
  defaultRestoredDir,
  readTextDocument,
  seekMappingPath,
  writeTextOutput,
} from '../lib/io.js';

const argv = process.argv.slice(2);
const file = argv.find((item) => !item.startsWith('--'));
if (!file) {
  console.error('usage: node test/roundtrip.mjs <file> [--types 人名,电话号码] [--keep]');
  process.exit(1);
}
const typesFlag = argv.indexOf('--types');
const types =
  typesFlag >= 0 && argv[typesFlag + 1]
    ? argv[typesFlag + 1].split(',').map((item) => item.trim()).filter(Boolean)
    : ['人名', '电话号码', '地址'];
const keep = argv.includes('--keep');

const config = resolveConfig({});
const source = path.resolve(file);
const dir = path.dirname(source);
const anonymizedDir = defaultAnonymizedDir(dir);
const restoredDir = defaultRestoredDir(dir);
const anonymizedFile = path.join(anonymizedDir, path.basename(source));
const mappingDir = path.join(anonymizedDir, 'mappings');
const mappingFile = seekMappingPath(mappingDir, source);
const restoredFile = path.join(restoredDir, path.basename(source));

const server = new ServerManager(config, { log: (level, message) => console.log(`[${level}] ${message}`) });

try {
  const original = (await readTextDocument(source)).text;
  const { client } = await server.ensure({ slots: 1 });

  const hideStart = Date.now();
  const hidden = await runHide(client, original, types, { warn: (m) => console.log('[hide]', m) });
  await fs.mkdir(mappingDir, { recursive: true });
  saveMapping(hidden.mapping, mappingFile);
  await writeTextOutput(anonymizedFile, hidden.text, { overwrite: true });
  console.log(`hide: ${Date.now() - hideStart} ms, ${hidden.chunks ?? 1} chunk(s), ${Object.keys(hidden.mapping).length} mapping entries`);

  const restoreStart = Date.now();
  const restored = await runSeek(client, hidden.text, loadMapping(mappingFile), {
    originalText: original,
    warn: (m) => console.log('[seek]', m),
  });
  await writeTextOutput(restoredFile, restored.text, { overwrite: true });
  console.log(`restore: ${Date.now() - restoreStart} ms, method=${restored.method}`);

  const expected = Buffer.from(original, 'utf8');
  const actual = Buffer.from(restored.text, 'utf8');
  const identical = expected.equals(actual);
  console.log(`round-trip byte-identical: ${identical}`);
  if (!identical) {
    console.log(`  expected ${expected.length} bytes, got ${actual.length}`);
    console.log(`  expected tail: ${JSON.stringify(original.slice(-16))}`);
    console.log(`  actual   tail: ${JSON.stringify(restored.text.slice(-16))}`);
  }
  console.log(`\nanonymized: ${anonymizedFile}\nmapping:    ${mappingFile}\nrestored:   ${restoredFile}`);
  console.log(`\n${hidden.text}`);

  if (!keep && !identical) process.exitCode = 2;
  await server.dispose();
  process.exit(identical ? 0 : 2);
} catch (error) {
  console.error('round trip failed:', error);
  await server.dispose().catch(() => {});
  process.exit(1);
}
