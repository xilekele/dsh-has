import { readFileSync } from 'node:fs';
import { extractDocument } from './lib/pdf-text.js';
const buf = readFileSync(String.raw`C:\Users\86152\Desktop\Code\Dhas\testcase\Oreport.pdf`);
const doc = extractDocument(buf);
console.log('pages:', doc.pages.length, 'chars:', doc.text.length);
for (const [i, page] of doc.pages.entries()) {
  console.log(`page ${i + 1}: ${page.lines.length} lines, ${page.runs.length} runs, ${page.width}x${page.height}, first=${JSON.stringify(page.lines[0]?.text?.slice(0, 40))}`);
}
console.log('--- first 800 chars ---');
console.log(doc.text.slice(0, 800));
