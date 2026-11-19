import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import { resolveConfig } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { runHide } from '../lib/hide.js';
import { runSeek } from '../lib/seek.js';
import { runScan } from '../lib/scan.js';
import { saveMapping, loadMapping } from '../lib/mapping.js';

const config = resolveConfig({});
console.log('model:', config.modelPath);
console.log('llama-server:', config.llamaServerPath);
console.log('state dir:', config.stateDir);
if (!config.modelPath || !config.llamaServerPath) {
  console.error('integration test needs both the model and llama-server');
  process.exit(1);
}

const server = new ServerManager(config, { log: (level, message) => console.log(`[${level}] ${message}`) });
const startedAt = Date.now();

const SAMPLE = [
  '客服工单 2026-0417。',
  '客户张伟（身份证 110101199003074512，手机 13800001111）反映，他通过邮箱 zhangwei@example.com 联系售后。',
  '收货地址是北京市朝阳区建国路88号SOHO现代城3号楼1201室。',
  '付款人李娜，工行卡 6222020200112233445。',
  '请尽快回电，谢谢。',
].join('\n');
const TYPES = ['人名', '电话号码', '身份证号', '地址', '电子邮箱', '银行卡号'];

try {
  const { client, info } = await server.ensure({ slots: 1 });
  console.log(`server ready on port ${info.port} in ${Date.now() - startedAt} ms`);

  const scanStart = Date.now();
  const scan = await runScan(client, SAMPLE, TYPES, { maxParallelRequests: 4 });
  console.log(`scan (${Date.now() - scanStart} ms):`, JSON.stringify(scan.entities, null, 2));

  const hideStart = Date.now();
  const hidden = await runHide(client, SAMPLE, TYPES, { warn: (m) => console.log('[hide]', m) });
  console.log(`\nhide (${Date.now() - hideStart} ms, ${hidden.chunks ?? 1} chunk):\n${hidden.text}`);
  console.log('\nmapping:', JSON.stringify(hidden.mapping, null, 2));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-has-it-'));
  const mappingFile = path.join(dir, 'it.mapping.json');
  saveMapping(hidden.mapping, mappingFile);

  const restoreStart = Date.now();
  const restored = await runSeek(client, hidden.text, loadMapping(mappingFile), {
    originalText: SAMPLE,
    warn: (m) => console.log('[seek]', m),
  });
  console.log(`\nrestore (${Date.now() - restoreStart} ms, method=${restored.method}):\n${restored.text}`);

  const normalized = (text) => text.replace(/\s+/g, '');
  const identical = normalized(restored.text) === normalized(SAMPLE);
  console.log(`\nround-trip identical: ${identical}`);
  if (!identical) {
    console.log('expected:', JSON.stringify(normalized(SAMPLE)));
    console.log('actual:  ', JSON.stringify(normalized(restored.text)));
  }
  await fs.rm(dir, { recursive: true, force: true });
  await server.dispose();
  process.exit(identical ? 0 : 2);
} catch (error) {
  console.error('integration failed:', error);
  await server.dispose().catch(() => {});
  process.exit(1);
}
