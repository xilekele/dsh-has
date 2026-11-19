import { readFileSync } from 'node:fs';
import { resolveConfig } from './lib/config.js';
import { ServerManager } from './lib/server.js';
import { extractDocument } from './lib/pdf-text.js';
import { runScan } from './lib/scan.js';

const config = resolveConfig({});
const buf = readFileSync(String.raw`C:\Users\86152\Desktop\Code\Dhas\testcase\Oreport.pdf`);
const doc = extractDocument(buf);
const pages = [30, 60, 90, 120, 150, 180, 210];
const samplePages = [3, 20, ...pages.filter((p) => p < doc.pages.length)];
const text = samplePages.map((n) => doc.pages[n - 1]?.lines?.map((l) => l.text).join('\n') ?? '').join('\n');
console.log('sample chars:', text.length, 'pages:', samplePages.join(','));
const types = ['人名', '公司名', '电话号码', '电子邮箱', '地址', '身份证号', '银行卡号', '统一社会信用代码', '银行名', '项目名'];
const server = new ServerManager(config, { log: () => {} });
try {
  await server.withClient(
    async (client) => {
      const started = Date.now();
      const r = await runScan(client, text, types);
      console.log('scan ms:', Date.now() - started);
      for (const [type, values] of Object.entries(r.entities)) {
        console.log(`${type}: ${values.length}`, values.slice(0, 4));
      }
    },
    { slots: 1 },
  );
} finally {
  await server.dispose();
}
