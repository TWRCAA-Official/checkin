import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';
import { dateToSerial, serialToDate, fmtTime } from '../src/time.js';

const TZ = 'Asia/Taipei';

// 記憶體版的試算表：values[0] 是第 2 列
function memoryStore(values, { delayMs = 0 } = {}) {
  const wait = () => new Promise(r => setTimeout(r, delayMs));
  const store = {
    values,
    reads: 0,
    writes: [],
    async timeZone() { return TZ; },
    async readAll() { store.reads++; await wait(); return values.map(r => r.slice()); },
    async readRow(row) { await wait(); return (values[row - 2] || []).slice(); },
    async writeCheckIn(row, v) {
      await wait();
      const r = values[row - 2];
      while (r.length < 7) r.push('');
      r[4] = v[0]; r[5] = v[1]; r[6] = v[2];
      store.writes.push({ row, v });
    },
  };
  return store;
}

function setup(extra = {}) {
  const values = [
    ['G-AAAAAA', '彩虹A團', 'a@x.org, b@x.org', '紅色'],
    ['G-BBBBBB', '彩虹 B 團', 'B@X.org', '藍色', '已報到', dateToSerial(new Date('2026-10-31T05:05:00Z'), TZ), '阿明'],
    ['', '還沒有代碼的團體', 'c@x.org', ''],
    ['G-CCCCCC', '彩虹C團', 'c@x.org', '綠色'],
  ];
  const store = memoryStore(values, extra);
  const config = { staffPin: 'pw1234', doneLabel: '已報到', timeZone: TZ, cacheSeconds: 15, scannerUrl: 'https://example.org/scan/' };
  const fixed = new Date('2026-10-31T04:30:00Z'); // 臺北 12:30
  const service = createService({ store, config, now: () => fixed });
  return { store, service, values };
}

test('時間序號與 HH:mm 互轉（以試算表時區為準）', () => {
  const d = new Date('2026-10-31T05:05:00Z');
  const s = dateToSerial(d, TZ);
  assert.equal(serialToDate(s, TZ).getTime(), d.getTime());
  assert.equal(fmtTime(s, TZ, TZ), '13:05');
  assert.equal(fmtTime('手動填的', TZ, TZ), '手動填的');
  assert.equal(fmtTime(undefined, TZ, TZ), '');
});

test('lookupGroup：名稱忽略空白與全半形，Email 不分大小寫，回應不含 Email', async () => {
  const { service } = setup();
  const r = await service.handle({ action: 'lookupGroup', name: '彩虹B團', email: ' b@x.ORG ' });
  assert.deepEqual(r, { ok: true, code: 'G-BBBBBB', name: '彩虹 B 團', team: '藍色', done: true, time: '13:05', qrText: 'https://example.org/scan/?code=G-BBBBBB' });
  assert.ok(!JSON.stringify(r).includes('@'));
  assert.deepEqual(await service.handle({ action: 'lookupGroup', name: '彩虹A團', email: 'nope@x.org' }), { ok: false });
  assert.deepEqual(await service.handle({ action: 'lookupGroup', name: '', email: '' }), { ok: false });
  // 第二個 Email 也可以
  assert.equal((await service.handle({ action: 'lookupGroup', name: '彩虹A團', email: 'b@x.org' })).code, 'G-AAAAAA');
});

test('沒有代碼的列不算在名單裡', async () => {
  const { service } = setup();
  const s = await service.handle({ action: 'getStats', pin: 'pw1234' });
  assert.deepEqual(s, { done: 1, total: 3 });
});

test('getStatus', async () => {
  const { service } = setup();
  assert.deepEqual(await service.handle({ action: 'getStatus', code: 'g-bbbbbb' }), { done: true, time: '13:05' });
  assert.deepEqual(await service.handle({ action: 'getStatus', code: 'G-AAAAAA' }), { done: false, time: '' });
  assert.deepEqual(await service.handle({ action: 'getStatus', code: 'G-NOPE' }), { done: false });
  assert.deepEqual(await service.handle({ action: 'getStatus', code: '' }), { done: false });
});

test('密碼：verifyPin、getStats、getRoster、checkIn 的錯誤回應與 Apps Script 相同', async () => {
  const { service } = setup();
  assert.deepEqual(await service.handle({ action: 'verifyPin', pin: ' pw1234 ' }), { ok: true });
  assert.deepEqual(await service.handle({ action: 'verifyPin', pin: 'wrong' }), { ok: false });
  assert.deepEqual(await service.handle({ action: 'getStats', pin: 'wrong' }), { error: 'pin', message: 'PIN' });
  assert.deepEqual(await service.handle({ action: 'getRoster', pin: '' }), { error: 'pin', message: 'PIN' });
  assert.deepEqual(await service.handle({ action: 'checkIn', pin: 'x', code: 'G-AAAAAA' }), { result: 'pin' });
  assert.deepEqual(await service.handle({ action: 'nope' }), { error: 'action' });
});

test('沒設定密碼時一律拒絕', async () => {
  const store = memoryStore([]);
  const service = createService({ store, config: { staffPin: '', doneLabel: '已報到', timeZone: TZ, cacheSeconds: 15, scannerUrl: '' } });
  assert.deepEqual(await service.handle({ action: 'verifyPin', pin: '' }), { ok: false });
});

test('getRoster 不含 Email', async () => {
  const { service } = setup();
  const r = await service.handle({ action: 'getRoster', pin: 'pw1234' });
  assert.equal(r.rows.length, 3);
  assert.deepEqual(Object.keys(r.rows[0]).sort(), ['code', 'done', 'name', 'team', 'time']);
  assert.ok(!JSON.stringify(r).includes('@'));
});

test('checkIn：成功寫入 E～G，接著重複報到回 dup', async () => {
  const { service, store, values } = setup();
  const ok = await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'https://example.org/scan/?code=g-aaaaaa', staff: '小美' });
  assert.deepEqual(ok, { result: 'ok', name: '彩虹A團', team: '紅色', time: '12:30', done: 2, total: 3 });
  assert.equal(values[0][4], '已報到');
  assert.equal(fmtTime(values[0][5], TZ, TZ), '12:30');
  assert.equal(values[0][6], '小美');
  assert.deepEqual(store.writes.map(w => w.row), [2]);
  // 快取立刻更新，團體頁輪詢馬上看到
  assert.deepEqual(await service.handle({ action: 'getStatus', code: 'G-AAAAAA' }), { done: true, time: '12:30' });
  // 舊網址格式也認得
  const dup = await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'https://script.google.com/x/exec?page=scan&code=G-AAAAAA', staff: '' });
  assert.deepEqual(dup, { result: 'dup', name: '彩虹A團', team: '紅色', time: '12:30' });
  assert.equal(store.writes.length, 1);
});

test('checkIn：查無代碼、空白代碼', async () => {
  const { service } = setup();
  assert.deepEqual(await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'G-ZZZZZZ' }), { result: 'unknown', code: 'G-ZZZZZZ' });
  assert.deepEqual(await service.handle({ action: 'checkIn', pin: 'pw1234', code: '   ' }), { result: 'unknown', code: '' });
  // 不合法的 %編碼 不會讓伺服器出錯
  assert.deepEqual(await service.handle({ action: 'checkIn', pin: 'pw1234', code: '?code=%E0%A4%A' }), { result: 'unknown', code: '%E0%A4%A' });
});

test('checkIn：試算表在別處已經報到（快取還沒更新）也會回 dup，不重寫', async () => {
  const { service, store, values } = setup();
  await service.handle({ action: 'getStats', pin: 'pw1234' }); // 先讀進快取
  values[3][4] = '已報到'; values[3][5] = dateToSerial(new Date('2026-10-31T04:00:00Z'), TZ);
  const r = await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'G-CCCCCC', staff: '小美' });
  assert.deepEqual(r, { result: 'dup', name: '彩虹C團', team: '綠色', time: '12:00' });
  assert.equal(store.writes.length, 0);
});

test('checkIn：試算表排序過（快取列號過期）會重新讀取並寫到正確的列', async () => {
  const { service, values } = setup();
  await service.handle({ action: 'getStats', pin: 'pw1234' });
  values.reverse(); // 排序
  const r = await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'G-AAAAAA', staff: '小美' });
  assert.equal(r.result, 'ok');
  const row = values.find(v => v[0] === 'G-AAAAAA');
  assert.equal(row[4], '已報到');
  assert.equal(values.filter(v => v[4] === '已報到').length, 2);
});

test('checkIn：剛新增到試算表的團體也找得到', async () => {
  const { service, values } = setup();
  await service.handle({ action: 'getStats', pin: 'pw1234' });
  values.push(['G-NEWNEW', '新團體', 'n@x.org', '紫色']);
  const r = await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'G-NEWNEW', staff: '' });
  assert.equal(r.result, 'ok');
  assert.equal(r.total, 4);
});

test('checkIn：同一個團體同時被兩支手機掃，只寫入一次', async () => {
  const { service, store } = setup({ delayMs: 20 });
  const [a, b] = await Promise.all([
    service.handle({ action: 'checkIn', pin: 'pw1234', code: 'G-CCCCCC', staff: '甲' }),
    service.handle({ action: 'checkIn', pin: 'pw1234', code: 'G-CCCCCC', staff: '乙' }),
  ]);
  assert.deepEqual([a.result, b.result].sort(), ['dup', 'ok']);
  assert.equal(store.writes.length, 1);
});

test('經手人名字以文字寫入（不會變成公式）', async () => {
  const { service, values } = setup();
  await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'G-CCCCCC', staff: '=HYPERLINK("x")' });
  assert.equal(values[3][6], '=HYPERLINK("x")'); // store 收到原字串；實際寫入用 RAW
});

test('名單快取：15 秒內不重讀試算表，同時多個請求只讀一次', async () => {
  const { service, store } = setup({ delayMs: 20 });
  await Promise.all(Array.from({ length: 20 }, () => service.handle({ action: 'getStatus', code: 'G-AAAAAA' })));
  assert.equal(store.reads, 1);
  await service.handle({ action: 'lookupGroup', name: '彩虹A團', email: 'a@x.org' });
  assert.equal(store.reads, 1);
});

test('試算表讀取失敗時回 server 錯誤，不會丟出例外', async () => {
  const store = memoryStore([]);
  store.readAll = async () => { throw new Error('Sheets API HTTP 403'); };
  const service = createService({ store, config: { staffPin: 'p', doneLabel: '已報到', timeZone: TZ, cacheSeconds: 15, scannerUrl: '' } });
  const r = await service.handle({ action: 'getStatus', code: 'G-A' });
  assert.equal(r.error, 'server');
  assert.match(r.message, /403/);
});
