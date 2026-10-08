import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSheetStore } from '../src/sheets.js';

// 攔截 fetch，檢查送給 Sheets API 的網址
function fakeFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: decodeURIComponent(String(url)), init });
    return new Response(JSON.stringify(handler(String(url), init)), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const tokenProvider = { async token() { return 't'; }, reset() {} };

test('readSheets：只讀存在的分頁，一次 batchGet', async () => {
  const f = fakeFetch(url => url.includes('fields=sheets')
    ? { sheets: [{ properties: { title: '報到名單' } }, { properties: { title: '市集報到' } }] }
    : { valueRanges: [{ values: [['G-A']] }, {}] });
  try {
    const store = createSheetStore({ spreadsheetId: 'S', tokenProvider });
    const out = await store.readSheets(['報到名單', '花車報到', '市集報到']);
    assert.deepEqual(out, { 報到名單: [['G-A']], 花車報到: [], 市集報到: [] });
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[1].url, /\/S\/values:batchGet\?ranges='報到名單'!A2:L&ranges='市集報到'!A2:L&valueRenderOption=UNFORMATTED_VALUE/);
  } finally { f.restore(); }
});

test('writeCells：從指定欄開始寫入，RAW', async () => {
  const f = fakeFetch(() => ({}));
  try {
    const store = createSheetStore({ spreadsheetId: 'S', tokenProvider });
    await store.writeCells("市集'報到", 5, 7, ['已簽退', 1, '阿明', '淨空無毀損', '']);
    assert.match(f.calls[0].url, /\/values\/'市集''報到'!H5:L5\?valueInputOption=RAW$/);
    assert.equal(f.calls[0].init.method, 'PUT');
    assert.deepEqual(JSON.parse(f.calls[0].init.body).values, [['已簽退', 1, '阿明', '淨空無毀損', '']]);
  } finally { f.restore(); }
});
