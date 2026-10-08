// 只授權存取這份試算表，讀不到帳號裡的其他檔案（例如 Google 表單回覆）
/** @OnlyCurrentDoc */

/**
 * 臺灣同志遊行｜團體報到系統
 * 團體頁：https://event.taiwanpride.lgbt/2026/checkin/（程式在 TWRCAA-Official/event）
 * 掃描頁：CONFIG.SCANNER_URL
 * 兩頁都透過 doPost JSON API 呼叫這裡
 * 備援：網頁應用程式網址（團體頁）、網頁應用程式網址 + ?page=scan（掃描頁）
 */

// 隊伍、花車、彩虹市集各一個分頁，代碼前綴不同，三個分頁之間不重複；市集多了 H～L 欄記錄簽退
const KINDS = {
  team:   { sheet: '報到名單', prefix: 'G-', headers: ['團體代碼', '團體名稱', '報名Email', '大隊', '報到狀態', '報到時間', '經手人'] },
  float:  { sheet: '花車報到', prefix: 'F-', headers: ['花車代碼', '團體名稱', '報名Email', '大隊', '報到狀態', '報到時間', '經手人'] },
  market: { sheet: '市集報到', prefix: 'M-', headers: ['攤位代碼', '攤商名稱', '報名Email', '攤位編號', '報到狀態', '報到時間', '經手人', '簽退狀態', '簽退時間', '簽退經手人', '場地狀況', '備註'] },
};
const CONDITIONS = { clear: '淨空無毀損', issue: '特殊事項' };

const CONFIG = {
  SHEET_NAME: KINDS.team.sheet,
  EVENT_NAME: '第 24 屆臺灣同志遊行',
  POLL_SECONDS: 5,        // 團體頁多久查詢一次報到狀態
  DONE_LABEL: '已報到',
  OUT_LABEL: '已簽退',
  TZ: 'Asia/Taipei',
  // 掃描頁；QR Code 會指向「SCANNER_URL?code=團體代碼」。留空則改回 Apps Script 掃描頁。
  SCANNER_URL: 'https://event.taiwanpride.lgbt/2026/checkin/scan/',
};
const COL = {
  CODE: 0, NAME: 1, EMAIL: 2, TEAM: 3, STATUS: 4, TIME: 5, STAFF: 6,
  OUT_STATUS: 7, OUT_TIME: 8, OUT_STAFF: 9, CONDITION: 10, NOTE: 11,
};
const NCOL = 12;
const CACHE_KEY = 'rows_v3';

/* ---------- 網頁路由 ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const isScan = p.page === 'scan';
  const t = HtmlService.createTemplateFromFile(isScan ? 'Scan' : 'Group');
  t.eventName = CONFIG.EVENT_NAME;
  t.prefillCode = String(p.code || '');
  t.pollSeconds = CONFIG.POLL_SECONDS;
  return t.evaluate()
    .setTitle(isScan ? '團體報到掃描' : '團體報到 QR Code')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ---------- JSON API（給 GitHub Pages 團體頁與掃描頁） ---------- */

// 前端以 Content-Type: text/plain 送出 JSON，避免 CORS 預檢
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (req.action) {
      case 'lookupGroup': out = lookupGroup(req.name, req.email, req.kind); break;
      case 'getStatus': out = getStatus(req.code); break;
      case 'verifyPin': out = { ok: verifyPin(req.pin) }; break;
      case 'getStats':  out = getStats(req.pin); break;
      case 'getRoster': out = getRoster(req.pin); break;
      case 'checkIn':   out = checkIn(req.pin, req.code, req.staff); break;
      case 'checkOut':  out = checkOut(req.pin, req.code, req.staff, req.condition, req.note); break;
      default:          out = { error: 'action' };
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    out = { error: msg === 'PIN' ? 'pin' : 'server', message: msg };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 試算表選單 ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('團體報到')
    .addItem('初始化工作表', 'setupSheet')
    .addItem('產生缺少的代碼（隊伍／花車／市集）', 'generateCodes')
    .addItem('設定工作人員密碼', 'setStaffPin')
    .addSeparator()
    .addItem('清除快取（手動改資料後）', 'clearCache')
    .addToUi();
}

function onEdit() { clearCache(); }

function setupSheet() {
  if (!fromMenu_()) return;
  const ss = SpreadsheetApp.getActive();
  Object.keys(KINDS).forEach(k => {
    const def = KINDS[k];
    let sh = ss.getSheetByName(def.sheet);
    if (!sh) sh = ss.insertSheet(def.sheet);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('F:F').setNumberFormat('yyyy/mm/dd hh:mm:ss');
    if (k === 'market') sh.getRange('I:I').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  });
  clearCache();
  SpreadsheetApp.getUi().alert('完成。三個分頁（' + Object.keys(KINDS).map(k => KINDS[k].sheet).join('、') + '）都請在 B 欄貼上名稱、C 欄貼上報名 Email（多個請用逗號分隔）、D 欄填入大隊（市集填攤位編號），再執行「產生缺少的代碼」。');
}

function generateCodes() {
  if (!fromMenu_()) return;
  const ss = SpreadsheetApp.getActive();
  // 先收集三個分頁已用過的代碼，確保不重複
  const used = new Set();
  const sheets = Object.keys(KINDS).map(k => {
    const sh = ss.getSheetByName(KINDS[k].sheet);
    const last = sh ? sh.getLastRow() : 0;
    const vals = last < 2 ? [] : sh.getRange(2, 1, last - 1, 2).getValues();
    vals.forEach(r => { const c = String(r[0]).trim(); if (c) used.add(c.toUpperCase()); });
    return { def: KINDS[k], sh: sh, vals: vals };
  });
  const made = [];
  sheets.forEach(x => {
    let n = 0;
    x.vals.forEach(r => {
      if (!String(r[0]).trim() && String(r[1]).trim()) {
        let c;
        do { c = x.def.prefix + randomCode_(6); } while (used.has(c));
        used.add(c);
        r[0] = c;
        n++;
      }
    });
    if (n) x.sh.getRange(2, 1, x.vals.length, 1).setValues(x.vals.map(r => [r[0]]));
    if (x.sh) made.push(x.def.sheet + ' ' + n + ' 組');
  });
  clearCache();
  SpreadsheetApp.getUi().alert('已產生代碼：' + made.join('、') + '。');
}

function setStaffPin() {
  if (!fromMenu_()) return;
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('設定工作人員密碼', '掃描頁登入時使用，建議 6 碼以上數字。', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const pin = res.getResponseText().trim();
  if (pin.length < 4) { ui.alert('密碼至少 4 碼。'); return; }
  PropertiesService.getScriptProperties().setProperty('STAFF_PIN', pin);
  ui.alert('已設定。');
}

function clearCache() { CacheService.getScriptCache().remove(CACHE_KEY); }

// 管理功能只能從試算表選單執行；從網頁（google.script.run）呼叫時沒有試算表 UI，直接略過
function fromMenu_() {
  try { SpreadsheetApp.getUi(); return true; } catch (err) { return false; }
}

/* ---------- 團體頁 API ---------- */

function lookupGroup(name, email, kind) {
  const k = KINDS[kind] ? kind : 'team';
  const n = norm_(name), m = String(email || '').trim().toLowerCase();
  if (!n || !m) return { ok: false };
  const hit = loadRows_().find(r => r.kind === k && norm_(r.name) === n && r.emails.indexOf(m) !== -1);
  if (!hit) return { ok: false };
  const res = {
    ok: true,
    kind: k,
    code: hit.code,
    name: hit.name,
    team: hit.team,
    done: hit.done,
    time: hit.time,
    qrText: scanUrl_(hit.code),
  };
  if (k === 'market') { res.out = hit.out; res.outTime = hit.outTime; }
  return res;
}

function getStatus(code) {
  const hit = loadRows_().find(r => r.code === String(code || '').trim().toUpperCase());
  if (!hit) return { done: false };
  return hit.kind === 'market' ? { done: hit.done, time: hit.time, out: hit.out, outTime: hit.outTime } : { done: hit.done, time: hit.time };
}

/* ---------- 掃描頁 API ---------- */

function verifyPin(pin) { return checkPin_(pin); }

// done／total 是三種合計；kinds 是各自的數字
function getStats(pin) {
  if (!checkPin_(pin)) throw new Error('PIN');
  const rows = loadRows_();
  const kinds = {};
  Object.keys(KINDS).forEach(k => { kinds[k] = tally_(rows, k, 'done'); });
  kinds.marketOut = tally_(rows, 'market', 'out');
  return { done: rows.filter(r => r.done).length, total: rows.length, kinds: kinds };
}

// 掃描頁登入後下載名單，在手機上即時比對（不含 Email）
function getRoster(pin) {
  if (!checkPin_(pin)) throw new Error('PIN');
  return {
    rows: loadRows_().map(r => {
      const g = { code: r.code, kind: r.kind, name: r.name, team: r.team, done: r.done, time: r.time };
      if (r.kind === 'market') { g.out = r.out; g.outTime = r.outTime; g.condition = r.condition; }
      return g;
    }),
  };
}

function checkIn(pin, raw, staff) {
  if (!checkPin_(pin)) return { result: 'pin' };
  const code = parseCode_(raw);
  if (!code) return { result: 'unknown', code: '' };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const f = findRow_(code);
    if (!f) return { result: 'unknown', code: code };
    const hit = f.hit, rowVals = f.vals;

    if (String(rowVals[COL.STATUS]).trim() === CONFIG.DONE_LABEL) {
      return { result: 'dup', kind: hit.kind, name: hit.name, team: hit.team, time: fmtTime_(rowVals[COL.TIME]) };
    }

    const now = new Date();
    f.sh.getRange(hit.row, COL.STATUS + 1, 1, 3).setValues([[CONFIG.DONE_LABEL, now, staff || '']]);
    SpreadsheetApp.flush();
    clearCache();
    // 用寫入前讀到的名單計算已報到數，不必整張表重讀一次
    hit.done = true;
    const t = tally_(f.rows, hit.kind, 'done');
    return { result: 'ok', kind: hit.kind, name: hit.name, team: hit.team, time: fmtTime_(now), done: t.done, total: t.total };
  } finally {
    lock.releaseLock();
  }
}

// 彩虹市集簽退：condition 是 clear（已完成現場攤位淨空無毀損）或 issue（特殊事項，必須填備註）
function checkOut(pin, raw, staff, condition, note) {
  if (!checkPin_(pin)) return { result: 'pin' };
  const code = parseCode_(raw);
  if (!code) return { result: 'unknown', code: '' };
  const label = CONDITIONS[condition];
  const memo = String(note || '').trim().slice(0, 500);
  if (!label || (condition === 'issue' && !memo)) return { result: 'invalid', code: code };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const f = findRow_(code);
    if (!f) return { result: 'unknown', code: code };
    const hit = f.hit, v = f.vals;
    if (hit.kind !== 'market') return { result: 'notMarket', code: code, kind: hit.kind, name: hit.name, team: hit.team };

    if (String(v[COL.OUT_STATUS]).trim() === CONFIG.OUT_LABEL) {
      return { result: 'dup', kind: 'market', name: hit.name, team: hit.team, time: fmtTime_(v[COL.OUT_TIME]),
        condition: String(v[COL.CONDITION]).trim(), note: String(v[COL.NOTE]).trim() };
    }

    const now = new Date();
    // 備註前面加 ' 避免被當成公式
    const safe = /^[=+\-@]/.test(memo) ? "'" + memo : memo;
    f.sh.getRange(hit.row, COL.OUT_STATUS + 1, 1, 5).setValues([[CONFIG.OUT_LABEL, now, staff || '', label, safe]]);
    SpreadsheetApp.flush();
    clearCache();
    hit.out = true;
    const t = tally_(f.rows, 'market', 'out');
    return { result: 'ok', kind: 'market', name: hit.name, team: hit.team, time: fmtTime_(now), condition: label,
      checkedIn: String(v[COL.STATUS]).trim() === CONFIG.DONE_LABEL, done: t.done, total: t.total };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 內部工具 ---------- */

function sheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) throw new Error('找不到工作表「' + CONFIG.SHEET_NAME + '」，請先執行「初始化工作表」。');
  return sh;
}

// 找到代碼所在的列並讀出最新內容；快取的列號若已過期（例如排序過），重新讀取一次
function findRow_(code) {
  const ss = SpreadsheetApp.getActive();
  let rows = loadRows_();
  let hit = rows.find(r => r.code === code);
  const read = h => {
    const sh = ss.getSheetByName(KINDS[h.kind].sheet);
    return { sh: sh, vals: sh.getRange(h.row, 1, 1, NCOL).getValues()[0] };
  };
  let got = hit ? read(hit) : null;
  if (!hit || String(got.vals[COL.CODE]).trim().toUpperCase() !== code) {
    clearCache();
    rows = loadRows_();
    hit = rows.find(r => r.code === code);
    if (!hit) return null;
    got = read(hit);
  }
  return { rows: rows, hit: hit, sh: got.sh, vals: got.vals };
}

function tally_(rows, kind, field) {
  const list = rows.filter(r => r.kind === kind);
  return { done: list.filter(r => r[field]).length, total: list.length };
}

function loadRows_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName(CONFIG.SHEET_NAME)) sheet_();   // 連隊伍分頁都沒有：提示先初始化
  const rows = [], seen = {};
  Object.keys(KINDS).forEach(kind => {
    const sh = ss.getSheetByName(KINDS[kind].sheet);
    const last = sh ? sh.getLastRow() : 0;
    if (last < 2) return;
    sh.getRange(2, 1, last - 1, NCOL).getValues().forEach((r, i) => {
      const g = {
        kind: kind,
        row: i + 2,
        code: String(r[COL.CODE]).trim().toUpperCase(),
        name: String(r[COL.NAME]).trim(),
        team: String(r[COL.TEAM]).trim(),
        emails: String(r[COL.EMAIL]).split(/[,;，；、\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean),
        done: String(r[COL.STATUS]).trim() === CONFIG.DONE_LABEL,
        time: fmtTime_(r[COL.TIME]),
      };
      if (kind === 'market') {
        g.out = String(r[COL.OUT_STATUS]).trim() === CONFIG.OUT_LABEL;
        g.outTime = fmtTime_(r[COL.OUT_TIME]);
        g.condition = String(r[COL.CONDITION]).trim();
      }
      if (g.code && g.name && !seen[g.code]) { seen[g.code] = true; rows.push(g); }
    });
  });
  try { cache.put(CACHE_KEY, JSON.stringify(rows), 120); } catch (err) { /* 資料過大時略過快取 */ }
  return rows;
}

function checkPin_(pin) {
  const real = PropertiesService.getScriptProperties().getProperty('STAFF_PIN');
  return !!real && String(pin || '').trim() === real;
}

function parseCode_(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/[?&]code=([^&#]+)/);
  return (m ? decodeURIComponent(m[1]) : s).trim().toUpperCase();
}

function scanUrl_(code) {
  const c = encodeURIComponent(code);
  return CONFIG.SCANNER_URL
    ? CONFIG.SCANNER_URL + '?code=' + c
    : ScriptApp.getService().getUrl() + '?page=scan&code=' + c;
}

function norm_(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function fmtTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TZ, 'HH:mm');
  return String(v || '');
}

function randomCode_(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
