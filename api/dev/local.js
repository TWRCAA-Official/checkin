// 本機測試用：用記憶體裡的假試算表啟動 API（不連 Google）。
//   node dev/local.js
// 然後在網站根目錄另開 http server，把 config.js 的 API_URL 暫時改成 http://localhost:8787/。

import { createServer } from '../src/server.js';
import { createService } from '../src/service.js';
import { dateToSerial } from '../src/time.js';

const TZ = 'Asia/Taipei';
const ago = h => dateToSerial(new Date(Date.now() - h * 3600e3), TZ);
const sheets = {
  報到名單: [
    ['G-TEST01', '測試團體一', 'one@example.org', '紅色'],
    ['G-TEST02', '測試團體二', 'two@example.org', '黃色', '已報到', ago(1), '測試'],
    ['G-TEST03', '測試團體三', 'three@example.org', '藍色大隊'],
  ],
  花車報到: [
    ['F-TEST01', '測試團體一', 'one@example.org', '紅色'],
  ],
  市集報到: [
    ['M-TEST01', '測試攤商一', 'shop@example.org', 'A12', '已報到', ago(3), '測試'],
    ['M-TEST02', '測試攤商二', 'shop2@example.org', 'B03'],
  ],
};

const store = {
  async timeZone() { return TZ; },
  async readSheets(names) { return Object.fromEntries(names.map(n => [n, (sheets[n] || []).map(r => r.slice())])); },
  async readRow(sheet, row) { return ((sheets[sheet] || [])[row - 2] || []).slice(); },
  async writeCells(sheet, row, col, v) {
    const r = sheets[sheet][row - 2];
    while (r.length < col + v.length) r.push('');
    r.splice(col, v.length, ...v);
    console.log('寫入', sheet, '第', row, '列', v);
  },
};

const config = {
  staffPin: process.env.STAFF_PIN || 'test1234', doneLabel: '已報到', outLabel: '已簽退',
  sheets: { team: '報到名單', float: '花車報到', market: '市集報到' },
  timeZone: TZ, cacheSeconds: 15, scannerUrl: 'http://localhost:8765/2026/checkin/scan/',
};
const port = Number(process.env.PORT) || 8787;
createServer({ service: createService({ store, config }), allowedOrigins: ['http://localhost:8765'] })
  .listen(port, () => console.log(`本機 API：http://localhost:${port}/（工作人員密碼 ${config.staffPin}）`));
