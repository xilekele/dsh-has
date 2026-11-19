import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { resolveConfig } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { createTools } from '../lib/tools.js';

const config = resolveConfig({});
if (!config.modelPath || !config.llamaServerPath) {
  console.error('needs model + llama-server');
  process.exit(1);
}

const server = new ServerManager(config, { log: (level, message) => console.log(`[${level}] ${message}`) });
const tools = Object.fromEntries(createTools({ getContext: () => ({ config, server, log: () => {} }) }).map((t) => [t.name, t]));
const exec = { signal: undefined };

const SAMPLE = '请把合同寄给王小明，电话 13900002222，地址上海市浦东新区世纪大道100号。';
const TYPES = ['人名', '电话号码', '地址'];

try {
  const status = await tools.has_status.execute({ action: 'check' }, exec);
  console.log('status:\n' + status.summary);
  assert.equal(status.ok, true);
  assert.equal(status.ready, true);

  const scan = await tools.has_scan.execute({ text: SAMPLE, types: TYPES }, exec);
  console.log('\nscan summary:\n' + scan.summary);
  assert.equal(scan.ok, true);
  assert.deepEqual(Object.keys(scan).includes('entities'), false);

  const scanRevealed = await tools.has_scan.execute({ text: SAMPLE, types: TYPES, reveal: true }, exec);
  assert.equal(scanRevealed.ok, true);
  assert.ok(Object.values(scanRevealed.entities).flat().length > 0);

  const hidden = await tools.has_hide.execute({ text: SAMPLE, types: TYPES }, exec);
  console.log('\nhide summary:\n' + hidden.summary);
  console.log('anonymized: ' + hidden.text);
  assert.ok(hidden.mappingPath.endsWith('.mapping.json'));
  assert.match(hidden.text, /<[^<>]+\[\d+\]\.[^<>]+\.[^<>]+>/);

  const restored = await tools.has_restore.execute({ text: hidden.text, mappingPath: hidden.mappingPath }, exec);
  console.log('\nrestore summary: ' + restored.summary);
  assert.equal(restored.method, 'tool');
  assert.equal(restored.text.replace(/\s+/g, ''), SAMPLE.replace(/\s+/g, ''));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-has-docs-'));
  const dirWithDocs = path.join(dir, 'inbox');
  await fs.mkdir(dirWithDocs);
  await fs.writeFile(path.join(dirWithDocs, 'ticket-a.txt'), SAMPLE);
  await fs.writeFile(path.join(dirWithDocs, 'ticket-b.txt'), '联系人李雷，手机 13700003333。');
  await fs.writeFile(path.join(dirWithDocs, 'blob.bin'), Buffer.from([0, 1, 2, 3]));

  const batch = await tools.has_hide.execute({ path: dirWithDocs, types: ['人名', '手机号码', '电话号码', '地址'] }, exec);
  console.log('\nbatch hide:\n' + batch.summary);
  assert.equal(batch.outputs.length, 2);
  assert.equal(batch.skippedCount, 1);

  const batchRestore = await tools.has_restore.execute({ path: path.join(dirWithDocs, '.has', 'anonymized') }, exec);
  console.log('\nbatch restore:\n' + batchRestore.summary);
  assert.equal(batchRestore.outputs.length, 2);
  for (const item of batchRestore.outputs) {
    const text = await fs.readFile(item.output, 'utf8');
    assert.ok(text.includes('王小') || text.includes('李雷'), `restored content looks wrong: ${text}`);
  }

  const stopped = await tools.has_status.execute({ action: 'stop' }, exec);
  assert.equal(stopped.ok, true);
  await fs.rm(dir, { recursive: true, force: true });
  console.log('\nall tool-level checks passed');
  process.exit(0);
} catch (error) {
  console.error('tool test failed:', error);
  await server.dispose().catch(() => {});
  process.exit(1);
}
