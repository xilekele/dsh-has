import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { buildNerMessages, buildPairMessages, buildSeekMessages } from '../lib/prompts.js';
import { takeChunk, chunkText, splitEdgeWhitespace } from '../lib/chunker.js';
import {
  findTags,
  hasTags,
  mergeMappings,
  normalizeMappingDict,
  parseJsonTolerant,
  saveMapping,
  loadMapping,
} from '../lib/mapping.js';
import { computePairMapping } from '../lib/pair.js';
import { detectScriptLang, isSameLanguage } from '../lib/lang.js';
import { normalizeEntityMap } from '../lib/validation.js';
import { restoreWithoutModel, toolSeek } from '../lib/seek.js';
import { collectTextDocuments } from '../lib/io.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const fakeCountTokens = async (text) => Math.max(1, Math.ceil(String(text).length / 2));

test('prompts match the reference contract', () => {
  const [ner] = buildNerMessages('张三住在北京', ['人名', '地址']);
  assert.equal(
    ner.content,
    'Recognize the following entity types in the text.\nSpecified types:["人名","地址"]\n<text>张三住在北京</text>',
  );
  const pair = buildPairMessages('a', 'b');
  assert.equal(
    pair[0].content,
    '<original>a</original>\n<anonymized>b</anonymized>\nExtract the mapping from anonymized entities to original entities.',
  );
  const seek = buildSeekMessages({ '<x[1].a.b>': ['值'] }, 'text <x[1].a.b>');
  assert.equal(
    seek[0].content,
    'The mapping from anonymized entities to original entities:\n{"<x[1].a.b>":["值"]}\nRestore the original text based on the above mapping:\ntext <x[1].a.b>',
  );
});

test('chunker respects the token budget', async () => {
  const text = '第一句话。第二句话！第三句话？'.repeat(40);
  const chunks = await chunkText(text, fakeCountTokens, 20);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text);
  const single = await takeChunk('短文本', fakeCountTokens, 100);
  assert.equal(single.text, '短文本');
});

test('tag parsing and mapping normalization', () => {
  assert.deepEqual(findTags('a <人名[1].personal.name> b <电话[2].contact.phone>'), [
    '<人名[1].personal.name>',
    '<电话[2].contact.phone>',
  ]);
  assert.equal(hasTags('no tags'), false);
  assert.deepEqual(normalizeMappingDict({ '<a[1].b.c>': 'x' }), { '<a[1].b.c>': ['x'] });
  assert.throws(() => normalizeMappingDict({ 'not a tag': ['x'] }), /not a valid anonymized tag/);
  assert.deepEqual(mergeMappings({ '<a[1].b.c>': ['x'] }, { '<a[1].b.c>': ['x', 'y'] }), { '<a[1].b.c>': ['x', 'y'] });
  assert.deepEqual(parseJsonTolerant('```json\n{"a":["b"]}\n```'), { a: ['b'] });
  assert.equal(parseJsonTolerant('no json here'), null);
});

test('entity map validation deduplicates and rejects bad shapes', () => {
  assert.deepEqual(normalizeEntityMap({ 人名: [' 张三 ', '张三', ''], 地址: '北京' }), {
    人名: ['张三'],
    地址: ['北京'],
  });
  assert.throws(() => normalizeEntityMap([], { context: 'NER output' }), /did not return a JSON object/);
});

test('tool restore replaces every tag occurrence', () => {
  const mapping = { '<人名[1].personal.name>': ['张三'], '<地址[2].personal.location>': ['北京'] };
  const anonymized = '你好 <人名[1].personal.name>，<人名[1].personal.name> 在 <地址[2].personal.location>。';
  assert.equal(toolSeek(anonymized, mapping), '你好 张三，张三 在 北京。');
  assert.equal(restoreWithoutModel(anonymized, mapping), '你好 张三，张三 在 北京。');
  assert.equal(restoreWithoutModel('no tags', mapping), 'no tags');
});

test('diff Pair extracts a mapping from simple substitution', () => {
  const original = '联系人张三，电话13800001111。';
  const anonymized = '联系人<人名[1].personal.name>，电话<电话[2].contact.phone>。';
  const result = computePairMapping(original, anonymized);
  assert.equal(result.selfCheck.pass, true);
  assert.deepEqual(result.normalizedMapping['<人名[1].personal.name>'], ['张三']);
  assert.deepEqual(result.normalizedMapping['<电话[2].contact.phone>'], ['13800001111']);
});

test('language detection and same-language check', () => {
  assert.equal(detectScriptLang('这是一个中文句子，包含足够多的汉字来判定语言。')?.lang, 'zh');
  assert.equal(detectScriptLang('This is a plain English sentence with many latin letters.')?.lang, 'en');
  assert.equal(isSameLanguage('张三', '这是中文'), true);
});

test('mapping files round-trip through disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-has-test-'));
  const file = path.join(dir, 'nested', 'm.mapping.json');
  const mapping = { '<人名[1].personal.name>': ['张三'] };
  saveMapping(mapping, file);
  assert.deepEqual(loadMapping(file), mapping);
  await fs.rm(dir, { recursive: true, force: true });
});

test('directory collection skips binary files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-has-docs-'));
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello');
  await fs.writeFile(path.join(dir, 'b.bin'), Buffer.from([0x00, 0x01, 0x02]));
  const { documents, skipped } = await collectTextDocuments(dir);
  assert.deepEqual(documents.map((item) => path.basename(item.source)), ['a.txt']);
  assert.deepEqual(skipped.map((item) => item.reason), ['binary']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('pdf writer emits a structurally valid document', async () => {
  const { findCjkFont, CJK_FONT_CANDIDATES } = await import('../lib/fonts.js');
  const found = await findCjkFont(CJK_FONT_CANDIDATES);
  if (!found) return; // no embeddable CJK font on this machine
  const { layoutText, buildPdf } = await import('../lib/pdf-write.js');
  const pages = layoutText(found.font, '测试<人名[1].个人.姓名>，结束。', { width: 400, height: 400 });
  const bytes = buildPdf({ pages, font: found.font });
  const text = bytes.toString('latin1');
  assert.equal(text.slice(0, 8), '%PDF-1.4', 'pdf header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'pdf trailer');
  const startxref = /startxref\s+(\d+)\s+%%EOF/.exec(text);
  assert.ok(startxref, 'startxref present');
  const at = Number(startxref[1]);
  assert.equal(text.slice(at, at + 4), 'xref', 'startxref points at the table');
  const table = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(text.slice(at));
  assert.ok(table, 'xref table');
  const count = Number(table[1]);
  const lines = table[2].split('\n').filter((line) => line.trim());
  assert.equal(lines.length, count, 'one entry per object plus the free entry');
  for (let id = 1; id < count; id += 1) {
    const offset = Number(lines[id].slice(0, 10));
    assert.equal(text.slice(offset, offset + String(id).length + 6), `${id} 0 obj`, `object ${id} offset`);
  }
});
test('edge whitespace survives a rewrite', () => {
  const original = '  张三住在北京  \r\n';
  const { lead, core, trail } = splitEdgeWhitespace(original);
  assert.equal(lead, '  ');
  assert.equal(trail, '  \r\n');
  assert.equal(core, '张三住在北京');
  assert.equal(`${lead}${core}${trail}`, original);
  assert.deepEqual(splitEdgeWhitespace('   \n'), { lead: '   \n', core: '', trail: '' });
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
