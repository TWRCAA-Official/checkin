// 只授權存取這份試算表，讀不到帳號裡的其他檔案（例如 Google 表單回覆）
/** @OnlyCurrentDoc */

/**
 * 臺灣同志遊行｜團體報到系統
 * 團體頁：https://event.taiwanpride.lgbt/2026/checkin/（程式在 TWRCAA-Official/event）
 * 掃描頁：CONFIG.SCANNER_URL
 * 兩頁都透過 doPost JSON API 呼叫這裡
 * 備援：網頁應用程式網址（團體頁）、網頁應用程式網址 + ?page=scan（掃描頁）
 */

const CONFIG = {
  SHEET_NAME: '報到名單',
  HEADERS: ['團體代碼', '團體名稱', '報名Email', '大隊', '報到狀態', '報到時間', '經手人'],
  EVENT_NAME: '第 24 屆臺灣同志遊行',
  POLL_SECONDS: 5,        // 團體頁多久查詢一次報到狀態
  DONE_LABEL: '已報到',
  TZ: 'Asia/Taipei',
  // 掃描頁；QR Code 會指向「SCANNER_URL?code=團體代碼」。留空則改回 Apps Script 掃描頁。
  SCANNER_URL: 'https://event.taiwanpride.lgbt/2026/checkin/scan/',
};
const COL = { CODE: 0, NAME: 1, EMAIL: 2, TEAM: 3, STATUS: 4, TIME: 5, STAFF: 6 };
const CACHE_KEY = 'rows_v2';

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
      case 'lookupGroup': out = lookupGroup(req.name, req.email); break;
      case 'getStatus': out = getStatus(req.code); break;
      case 'verifyPin': out = { ok: verifyPin(req.pin) }; break;
      case 'getStats':  out = getStats(req.pin); break;
      case 'getRoster': out = getRoster(req.pin); break;
      case 'checkIn':   out = checkIn(req.pin, req.code, req.staff); break;
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
    .addItem('產生缺少的團體代碼', 'generateCodes')
    .addItem('設定工作人員密碼', 'setStaffPin')
    .addSeparator()
    .addItem('清除快取（手動改資料後）', 'clearCache')
    .addToUi();
}

function onEdit() { clearCache(); }

function setupSheet() {
  if (!fromMenu_()) return;
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEET_NAME);
  sh.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('F:F').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  clearCache();
  SpreadsheetApp.getUi().alert('完成。請在 B 欄貼上團體名稱、C 欄貼上報名 Email（多個請用逗號分隔）、D 欄填入大隊（例如：紅色大隊 Team Red），再執行「產生缺少的團體代碼」。');
}

function generateCodes() {
  if (!fromMenu_()) return;
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  const range = sh.getRange(2, 1, last - 1, 2);
  const vals = range.getValues();
  const used = new Set(vals.map(r => String(r[0]).trim()).filter(Boolean));
  let made = 0;
  vals.forEach(r => {
    if (!String(r[0]).trim() && String(r[1]).trim()) {
      let c;
      do { c = 'G-' + randomCode_(6); } while (used.has(c));
      used.add(c);
      r[0] = c;
      made++;
    }
  });
  sh.getRange(2, 1, vals.length, 1).setValues(vals.map(r => [r[0]]));
  clearCache();
  SpreadsheetApp.getUi().alert('已產生 ' + made + ' 組團體代碼。');
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

function lookupGroup(name, email) {
  const n = norm_(name), m = String(email || '').trim().toLowerCase();
  const hit = loadRows_().find(r => norm_(r.name) === n && r.emails.indexOf(m) !== -1);
  if (!hit) return { ok: false };
  return {
    ok: true,
    code: hit.code,
    name: hit.name,
    team: hit.team,
    done: hit.done,
    time: hit.time,
    qrText: scanUrl_(hit.code),
  };
}

function getStatus(code) {
  const hit = loadRows_().find(r => r.code === String(code || '').trim().toUpperCase());
  return hit ? { done: hit.done, time: hit.time } : { done: false };
}

/* ---------- 掃描頁 API ---------- */

function verifyPin(pin) { return checkPin_(pin); }

function getStats(pin) {
  if (!checkPin_(pin)) throw new Error('PIN');
  const rows = loadRows_();
  return { done: rows.filter(r => r.done).length, total: rows.length };
}

// 掃描頁登入後下載名單，在手機上即時比對（不含 Email）
function getRoster(pin) {
  if (!checkPin_(pin)) throw new Error('PIN');
  return { rows: loadRows_().map(r => ({ code: r.code, name: r.name, team: r.team, done: r.done, time: r.time })) };
}

function checkIn(pin, raw, staff) {
  if (!checkPin_(pin)) return { result: 'pin' };
  const code = parseCode_(raw);
  if (!code) return { result: 'unknown', code: '' };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_();
    let rows = loadRows_();
    let hit = rows.find(r => r.code === code);
    let rowVals = hit ? sh.getRange(hit.row, 1, 1, CONFIG.HEADERS.length).getValues()[0] : null;

    // 快取的列號若已過期（例如排序過），重新讀取一次
    if (!hit || String(rowVals[COL.CODE]).trim().toUpperCase() !== code) {
      clearCache();
      rows = loadRows_();
      hit = rows.find(r => r.code === code);
      if (!hit) return { result: 'unknown', code: code };
      rowVals = sh.getRange(hit.row, 1, 1, CONFIG.HEADERS.length).getValues()[0];
    }

    if (String(rowVals[COL.STATUS]).trim() === CONFIG.DONE_LABEL) {
      return { result: 'dup', name: hit.name, team: hit.team, time: fmtTime_(rowVals[COL.TIME]) };
    }

    const now = new Date();
    sh.getRange(hit.row, COL.STATUS + 1, 1, 3).setValues([[CONFIG.DONE_LABEL, now, staff || '']]);
    SpreadsheetApp.flush();
    clearCache();
    // 用寫入前讀到的名單計算已報到數，不必整張表重讀一次
    const done = rows.filter(r => r.done && r.code !== code).length + 1;
    return { result: 'ok', name: hit.name, team: hit.team, time: fmtTime_(now), done: done, total: rows.length };
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

function loadRows_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY);
  if (hit) return JSON.parse(hit);
  const sh = sheet_();
  const last = sh.getLastRow();
  const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, CONFIG.HEADERS.length).getValues()
    .map((r, i) => ({
      row: i + 2,
      code: String(r[COL.CODE]).trim().toUpperCase(),
      name: String(r[COL.NAME]).trim(),
      team: String(r[COL.TEAM]).trim(),
      emails: String(r[COL.EMAIL]).split(/[,;，；、\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean),
      done: String(r[COL.STATUS]).trim() === CONFIG.DONE_LABEL,
      time: fmtTime_(r[COL.TIME]),
    }))
    .filter(r => r.code && r.name);
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
