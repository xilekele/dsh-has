/**
 * Tool-level PDF checks: has_hide / has_restore on a .pdf, then directory mode
 * with a .pdf and a .txt side by side.
 *
 * Usage: node test/pdf-tools.mjs <file.pdf> [types]
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { resolveConfig } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { createTools } from '../lib/tools.js';
import { isPdfFile, pdfPlainText } from '../lib/pdf.js';

const normalize = (text) => text.replace(/\s+/g, '').trim();

const file = process.argv[2];
const types = (process.argv[3] ?? '人名,公司名,电话号码,电子邮箱,地址,银行卡号,税号,银行名').split(',').map((t) => t.trim());
if (!file) {
  console.error('usage: node test/pdf-tools.mjs <file.pdf> [types]');
  process.exit(1);
}
assert.ok(isPdfFile(file), 'not a .pdf file');

const config = resolveConfig({});
const server = new ServerManager(config, { log: (level, message) => console.log(`[${level}] ${message}`) });
const tools = Object.fromEntries(createTools({ getContext: () => ({ config, server, log: () => {} }) }).map((t) => [t.name, t]));
const exec = { signal: undefined };

try {
  const hidden = await tools.has_hide.execute({ path: path.resolve(file), types }, exec);
  console.log('\n' + hidden.summary);
  const out = hidden.outputs[0];
  assert.equal(hidden.outputMode, 'files');
  assert.ok(out.output.endsWith('.pdf'), 'output keeps the .pdf suffix');
  assert.ok(out.mapping.endsWith('.mapping.json'));

  const restored = await tools.has_restore.execute({ path: out.output, reveal: true }, exec);
  console.log(restored.summary);

  const restoredFile = restored.outputs[0].output;
  const [original, roundTrip] = await Promise.all([
    fsp.readFile(path.resolve(file)),
    fsp.readFile(restoredFile),
  ]);
  const before = normalize(pdfPlainText(original));
  const after = normalize(pdfPlainText(roundTrip));
  console.log('\npdf text identical (whitespace-insensitive): ' + (before === after ? 'true' : 'false'));
  if (before !== after) {
    console.log('--- original\n' + before + '\n--- restored\n' + after);
    process.exit(2);
  }

  // Directory mode: the same document inside a folder must be picked up.
  const dir = path.join(path.dirname(path.resolve(file)), '.pdf-dir-test');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(path.resolve(file), path.join(dir, path.basename(file)));
  await fsp.writeFile(path.join(dir, 'note.txt'), '联系人张三，电话 13900001111。', 'utf8');

  const dirHide = await tools.has_hide.execute({ path: dir, types }, exec);
  console.log('\n' + dirHide.summary);
  assert.equal(dirHide.count, 2);

  const dirRestore = await tools.has_restore.execute({ path: path.join(dir, '.has', 'anonymized') }, exec);
  console.log(dirRestore.summary);
  assert.equal(dirRestore.count, 2);

  console.log('\npdf tool-level checks passed.');
} finally {
  await server.dispose();
}
