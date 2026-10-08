import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';
import { dateToSerial, serialToDate, fmtTime } from '../src/time.js';

const TZ = 'Asia/Taipei';

// 記憶體版的試算表：sheets[分頁名稱][0] 是第 2 列；傳陣列時當成只有「報到名單」
const SHEETS = { team: '報到名單', float: '花車報到', market: '市集報到' };
function memoryStore(sheets, { delayMs = 0 } = {}) {
  if (Array.isArray(sheets)) sheets = { [SHEETS.team]: sheets };
  const wait = () => new Promise(r => setTimeout(r, delayMs));
  const store = {
    sheets,
    reads: 0,
    writes: [],
    async timeZone() { return TZ; },
    async readSheets(names) {
      store.reads++; await wait();
      return Object.fromEntries(names.map(n => [n, (sheets[n] || []).map(r => r.slice())]));
    },
    async readRow(sheet, row) { await wait(); return ((sheets[sheet] || [])[row - 2] || []).slice(); },
    async writeCells(sheet, row, col, v) {
      await wait();
      const r = sheets[sheet][row - 2];
      while (r.length < col + v.length) r.push('');
      r.splice(col, v.length, ...v);
      store.writes.push({ sheet, row, col, v });
    },
  };
  return store;
}

const baseConfig = { staffPin: 'pw1234', doneLabel: '已報到', outLabel: '已簽退', sheets: SHEETS, timeZone: TZ, cacheSeconds: 15, scannerUrl: 'https://example.org/scan/' };

function setup(extra = {}) {
  const values = [
    ['G-AAAAAA', '彩虹A團', 'a@x.org, b@x.org', '紅色'],
    ['G-BBBBBB', '彩虹 B 團', 'B@X.org', '藍色', '已報到', dateToSerial(new Date('2026-10-31T05:05:00Z'), TZ), '阿明'],
    ['', '還沒有代碼的團體', 'c@x.org', ''],
    ['G-CCCCCC', '彩虹C團', 'c@x.org', '綠色'],
  ];
  const floats = [
    ['F-AAAAAA', '彩虹A團', 'a@x.org', '紅色'],
  ];
  const market = [
    ['M-AAAAAA', '彩虹小舖', 'shop@x.org', 'A12', '已報到', dateToSerial(new Date('2026-10-31T02:00:00Z'), TZ), '小美'],
    ['M-BBBBBB', '手作攤', 'hand@x.org', 'B03'],
    ['M-CCCCCC', '已簽退的攤', 'done@x.org', 'C01', '已報到', dateToSerial(new Date('2026-10-31T02:00:00Z'), TZ), '小美',
      '已簽退', dateToSerial(new Date('2026-10-31T09:00:00Z'), TZ), '阿明', '特殊事項', '桌子少一張'],
  ];
  const store = memoryStore({ [SHEETS.team]: values, [SHEETS.float]: floats, [SHEETS.market]: market }, extra);
  const fixed = new Date('2026-10-31T04:30:00Z'); // 臺北 12:30
  const service = createService({ store, config: baseConfig, now: () => fixed });
  return { store, service, values, floats, market };
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
  assert.deepEqual(r, { ok: true, kind: 'team', code: 'G-BBBBBB', name: '彩虹 B 團', team: '藍色', done: true, time: '13:05', qrText: 'https://example.org/scan/?code=G-BBBBBB' });
  assert.ok(!JSON.stringify(r).includes('@'));
  assert.deepEqual(await service.handle({ action: 'lookupGroup', name: '彩虹A團', email: 'nope@x.org' }), { ok: false });
  assert.deepEqual(await service.handle({ action: 'lookupGroup', name: '', email: '' }), { ok: false });
  // 第二個 Email 也可以
  assert.equal((await service.handle({ action: 'lookupGroup', name: '彩虹A團', email: 'b@x.org' })).code, 'G-AAAAAA');
});

test('沒有代碼的列不算在名單裡；getStats 分種類計算', async () => {
  const { service } = setup();
  const s = await service.handle({ action: 'getStats', pin: 'pw1234' });
  assert.deepEqual(s, {
    done: 3, total: 7,
    kinds: { team: { done: 1, total: 3 }, float: { done: 0, total: 1 }, market: { done: 2, total: 3 }, marketOut: { done: 1, total: 3 } },
  });
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
  const service = createService({ store, config: { ...baseConfig, staffPin: '' } });
  assert.deepEqual(await service.handle({ action: 'verifyPin', pin: '' }), { ok: false });
});

test('getRoster 不含 Email', async () => {
  const { service } = setup();
  const r = await service.handle({ action: 'getRoster', pin: 'pw1234' });
  assert.equal(r.rows.length, 7);
  assert.deepEqual(Object.keys(r.rows[0]).sort(), ['code', 'done', 'kind', 'name', 'team', 'time']);
  const m = r.rows.find(g => g.code === 'M-CCCCCC');
  assert.deepEqual(m, { code: 'M-CCCCCC', kind: 'market', name: '已簽退的攤', team: 'C01', done: true, time: '10:00', out: true, outTime: '17:00', condition: '特殊事項' });
  assert.ok(!JSON.stringify(r).includes('@'));
});

test('checkIn：成功寫入 E～G，接著重複報到回 dup', async () => {
  const { service, store, values } = setup();
  const ok = await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'https://example.org/scan/?code=g-aaaaaa', staff: '小美' });
  assert.deepEqual(ok, { result: 'ok', kind: 'team', name: '彩虹A團', team: '紅色', time: '12:30', done: 2, total: 3 });
  assert.equal(values[0][4], '已報到');
  assert.equal(fmtTime(values[0][5], TZ, TZ), '12:30');
  assert.equal(values[0][6], '小美');
  assert.deepEqual(store.writes.map(w => [w.sheet, w.row, w.col]), [['報到名單', 2, 4]]);
  // 快取立刻更新，團體頁輪詢馬上看到
  assert.deepEqual(await service.handle({ action: 'getStatus', code: 'G-AAAAAA' }), { done: true, time: '12:30' });
  // 舊網址格式也認得
  const dup = await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'https://script.google.com/x/exec?page=scan&code=G-AAAAAA', staff: '' });
  assert.deepEqual(dup, { result: 'dup', kind: 'team', name: '彩虹A團', team: '紅色', time: '12:30' });
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
  assert.deepEqual(r, { result: 'dup', kind: 'team', name: '彩虹C團', team: '綠色', time: '12:00' });
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
  store.readSheets = async () => { throw new Error('Sheets API HTTP 403'); };
  const service = createService({ store, config: baseConfig });
  const r = await service.handle({ action: 'getStatus', code: 'G-A' });
  assert.equal(r.error, 'server');
  assert.match(r.message, /403/);
});

/* ---------- 花車、彩虹市集 ---------- */

test('lookupGroup 依 kind 查不同分頁；同名同 Email 的隊伍與花車各自有代碼', async () => {
  const { service } = setup();
  assert.equal((await service.handle({ action: 'lookupGroup', name: '彩虹A團', email: 'a@x.org' })).code, 'G-AAAAAA');
  const f = await service.handle({ action: 'lookupGroup', name: '彩虹A團', email: 'a@x.org', kind: 'float' });
  assert.deepEqual(f, { ok: true, kind: 'float', code: 'F-AAAAAA', name: '彩虹A團', team: '紅色', done: false, time: '', qrText: 'https://example.org/scan/?code=F-AAAAAA' });
  const m = await service.handle({ action: 'lookupGroup', name: '彩虹小舖', email: 'SHOP@x.org', kind: 'market' });
  assert.deepEqual(m, { ok: true, kind: 'market', code: 'M-AAAAAA', name: '彩虹小舖', team: 'A12', done: true, time: '10:00', out: false, outTime: '', qrText: 'https://example.org/scan/?code=M-AAAAAA' });
  // 攤商不能用隊伍頁查
  assert.deepEqual(await service.handle({ action: 'lookupGroup', name: '彩虹小舖', email: 'shop@x.org' }), { ok: false });
  // 不認得的 kind 當成隊伍
  assert.equal((await service.handle({ action: 'lookupGroup', name: '彩虹A團', email: 'a@x.org', kind: 'x' })).code, 'G-AAAAAA');
});

test('checkIn：花車與市集寫到各自的分頁，數字只算同一種', async () => {
  const { service, store, floats, market } = setup();
  const f = await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'F-AAAAAA', staff: '甲' });
  assert.deepEqual(f, { result: 'ok', kind: 'float', name: '彩虹A團', team: '紅色', time: '12:30', done: 1, total: 1 });
  assert.deepEqual(floats[0].slice(4, 7).map((v, i) => i === 1 ? fmtTime(v, TZ, TZ) : v), ['已報到', '12:30', '甲']);
  const m = await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'M-BBBBBB', staff: '乙' });
  assert.deepEqual(m, { result: 'ok', kind: 'market', name: '手作攤', team: 'B03', time: '12:30', done: 3, total: 3 });
  assert.equal(market[1][4], '已報到');
  assert.deepEqual(store.writes.map(w => w.sheet), ['花車報到', '市集報到']);
});

test('getStatus：市集多回簽退狀態', async () => {
  const { service } = setup();
  assert.deepEqual(await service.handle({ action: 'getStatus', code: 'M-CCCCCC' }), { done: true, time: '10:00', out: true, outTime: '17:00' });
  assert.deepEqual(await service.handle({ action: 'getStatus', code: 'F-AAAAAA' }), { done: false, time: '' });
});

test('checkOut：淨空無毀損，寫入 H～L', async () => {
  const { service, store, market } = setup();
  const r = await service.handle({ action: 'checkOut', pin: 'pw1234', code: 'https://example.org/scan/?code=m-aaaaaa', staff: '阿明', condition: 'clear', note: '' });
  assert.deepEqual(r, { result: 'ok', kind: 'market', name: '彩虹小舖', team: 'A12', time: '12:30', condition: '淨空無毀損', checkedIn: true, done: 2, total: 3 });
  assert.deepEqual(store.writes.map(w => [w.sheet, w.row, w.col]), [['市集報到', 2, 7]]);
  assert.equal(market[0][7], '已簽退');
  assert.equal(fmtTime(market[0][8], TZ, TZ), '12:30');
  assert.deepEqual(market[0].slice(9), ['阿明', '淨空無毀損', '']);
  // 報到資料不動
  assert.equal(market[0][6], '小美');
  assert.deepEqual(await service.handle({ action: 'getStatus', code: 'M-AAAAAA' }), { done: true, time: '10:00', out: true, outTime: '12:30' });
  // 再簽退一次回 dup，不重寫
  const dup = await service.handle({ action: 'checkOut', pin: 'pw1234', code: 'M-AAAAAA', staff: '', condition: 'clear' });
  assert.deepEqual(dup, { result: 'dup', kind: 'market', name: '彩虹小舖', team: 'A12', time: '12:30', condition: '淨空無毀損', note: '' });
  assert.equal(store.writes.length, 1);
});

test('checkOut：特殊事項一定要有備註；沒報到也可以簽退', async () => {
  const { service, market } = setup();
  assert.deepEqual(await service.handle({ action: 'checkOut', pin: 'pw1234', code: 'M-BBBBBB', condition: 'issue', note: '  ' }), { result: 'invalid', code: 'M-BBBBBB' });
  assert.deepEqual(await service.handle({ action: 'checkOut', pin: 'pw1234', code: 'M-BBBBBB', condition: 'nope' }), { result: 'invalid', code: 'M-BBBBBB' });
  const r = await service.handle({ action: 'checkOut', pin: 'pw1234', code: 'M-BBBBBB', staff: '', condition: 'issue', note: ' 地上有油漬 ' });
  assert.equal(r.result, 'ok');
  assert.equal(r.checkedIn, false);
  assert.deepEqual(market[1].slice(10), ['特殊事項', '地上有油漬']);
  assert.equal(market[1][4] ?? '', ''); // 不會順便補報到
});

test('checkOut：已簽退過回 dup（帶出原本的狀況與備註）', async () => {
  const { service, store } = setup();
  const r = await service.handle({ action: 'checkOut', pin: 'pw1234', code: 'M-CCCCCC', condition: 'clear' });
  assert.deepEqual(r, { result: 'dup', kind: 'market', name: '已簽退的攤', team: 'C01', time: '17:00', condition: '特殊事項', note: '桌子少一張' });
  assert.equal(store.writes.length, 0);
});

test('checkOut：不是市集的代碼、查無代碼、密碼錯誤', async () => {
  const { service, store } = setup();
  assert.deepEqual(await service.handle({ action: 'checkOut', pin: 'pw1234', code: 'G-AAAAAA', condition: 'clear' }),
    { result: 'notMarket', code: 'G-AAAAAA', kind: 'team', name: '彩虹A團', team: '紅色' });
  assert.deepEqual(await service.handle({ action: 'checkOut', pin: 'pw1234', code: 'M-ZZZZZZ', condition: 'clear' }), { result: 'unknown', code: 'M-ZZZZZZ' });
  assert.deepEqual(await service.handle({ action: 'checkOut', pin: 'bad', code: 'M-AAAAAA', condition: 'clear' }), { result: 'pin' });
  assert.equal(store.writes.length, 0);
});

test('還沒建立花車、市集分頁時照常運作', async () => {
  const store = memoryStore([['G-AAAAAA', '彩虹A團', 'a@x.org', '紅色']]);
  const service = createService({ store, config: baseConfig });
  assert.deepEqual((await service.handle({ action: 'getStats', pin: 'pw1234' })).kinds.market, { done: 0, total: 0 });
  assert.equal((await service.handle({ action: 'checkIn', pin: 'pw1234', code: 'G-AAAAAA' })).result, 'ok');
});

test('備註以文字寫入且有長度上限', async () => {
  const { service, market } = setup();
  await service.handle({ action: 'checkOut', pin: 'pw1234', code: 'M-BBBBBB', condition: 'issue', note: '=1+1' + 'x'.repeat(600) });
  assert.equal(market[1][11].length, 500);
  assert.ok(market[1][11].startsWith('=1+1'));
});
