// 本機測試用：用記憶體裡的假試算表啟動 API（不連 Google）。
//   node dev/local.js
// 然後在網站根目錄另開 http server，把 config.js 的 API_URL 暫時改成 http://localhost:8787/。

import { createServer } from '../src/server.js';
import { createService } from '../src/service.js';
import { dateToSerial } from '../src/time.js';

const TZ = 'Asia/Taipei';
const values = [
  ['G-TEST01', '測試團體一', 'one@example.org', '紅色'],
  ['G-TEST02', '測試團體二', 'two@example.org', '黃色', '已報到', dateToSerial(new Date(Date.now() - 3600e3), TZ), '測試'],
  ['G-TEST03', '測試團體三', 'three@example.org', '藍色大隊'],
];

const store = {
  async timeZone() { return TZ; },
  async readAll() { return values.map(r => r.slice()); },
  async readRow(row) { return (values[row - 2] || []).slice(); },
  async writeCheckIn(row, v) { const r = values[row - 2]; while (r.length < 7) r.push(''); r.splice(4, 3, ...v); console.log('寫入第', row, '列', v); },
};

const config = { staffPin: process.env.STAFF_PIN || 'test1234', doneLabel: '已報到', timeZone: TZ, cacheSeconds: 15, scannerUrl: 'http://localhost:8765/scan/' };
const port = Number(process.env.PORT) || 8787;
createServer({ service: createService({ store, config }), allowedOrigins: ['http://localhost:8765'] })
  .listen(port, () => console.log(`本機 API：http://localhost:${port}/（工作人員密碼 ${config.staffPin}）`));
