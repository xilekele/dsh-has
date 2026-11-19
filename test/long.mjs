import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { resolveConfig } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { createTools } from '../lib/tools.js';

const config = resolveConfig({});
const server = new ServerManager(config, { log: (level, message) => console.log(`[${level}] ${message}`) });
const tools = Object.fromEntries(createTools({ getContext: () => ({ config, server, log: () => {} }) }).map((t) => [t.name, t]));
const exec = { signal: undefined };

const NAMES = ['张伟', '李娜', '王芳', '刘洋', '陈静', '杨磊', '赵敏', '周杰'];
const CITIES = ['北京市朝阳区建国路88号3号楼1201室', '上海市浦东新区世纪大道100号', '广州市天河区体育西路12号', '深圳市南山区科技园南路8号A座'];
const PHONES = ['13800001111', '13900002222', '13700003333', '13600004444'];
const IDS = ['110101199003074512', '310101198805231234', '440301199202145678', '510101199511203456'];

// Long document with varied paragraphs: exercises the multi-chunk path,
// accumulated mapping and cross-chunk ID stability without tempting the model
// into verbatim repetition.
const LONG = Array.from({ length: 45 }, (_, index) => {
  const name = NAMES[index % NAMES.length];
  const city = CITIES[index % CITIES.length];
  const phone = PHONES[index % PHONES.length];
  const id = IDS[index % IDS.length];
  return `第 ${index + 1} 条：${name}的工单已登记，联系电话 ${phone}，证件号 ${id}，收货地址 ${city}，另外备注事项请归档到第 ${(index % 7) + 1} 号柜，处理人 ${NAMES[(index + 3) % NAMES.length]}。`;
}).join('\n');

const TYPES = ['人名', '电话号码', '身份证号', '地址', '电子邮箱', '银行卡号'];

await fs.mkdir(path.join('C:', 'Users', '86152', 'Desktop', 'Code', 'Dhas', '.state'), { recursive: true });

try {
  const hideStart = Date.now();
  const hidden = await tools.has_hide.execute({ text: LONG, types: TYPES, maxChunkTokens: 1500 }, exec);
  console.log(`long hide: ${Date.now() - hideStart} ms, ${hidden.anonymizedLength ?? LONG.length} chars`);
  console.log('summary:\n' + hidden.summary);
  const tags = [...new Set((hidden.text.match(/<[^<>]+>/g) ?? []))];
  console.log('distinct tags:', tags.join(' '));
  assert.ok(tags.length > 0, 'expected tags');

  const restoreStart = Date.now();
  const restored = await tools.has_restore.execute({ text: hidden.text, mappingPath: hidden.mappingPath }, exec);
  console.log(`long restore: ${Date.now() - restoreStart} ms, method ${restored.method}`);
  const normalize = (value) => value.replace(/\s+/g, '');
  assert.equal(normalize(restored.text), normalize(LONG), 'round trip must be identical');

  // Simulate a cloud model that dropped a tag and reflowed whitespace: the
  // restore must still recover what it can and report the fallback path.
  const damaged = hidden.text.replace(tags[0], 'REMOVED').replace(/\n{2,}/g, '\n');
  const recovered = await tools.has_restore.execute({ text: damaged, mappingPath: hidden.mappingPath }, exec);
  console.log('damaged restore method:', recovered.method, 'summary:', recovered.summary.split('\n')[0]);

  await tools.has_status.execute({ action: 'stop' }, exec);
  console.log('\nlong-document checks passed');
  process.exit(0);
} catch (error) {
  console.error('long test failed:', error);
  await server.dispose().catch(() => {});
  process.exit(1);
}
