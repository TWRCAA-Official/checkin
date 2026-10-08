// 報到的商業邏輯，對應 apps-script/Code.gs（團體頁 API、掃描頁 API、內部工具）。
// 試算表的讀寫交給 store（見 sheets.js；測試時用記憶體版本）。

import { timingSafeEqual } from 'node:crypto';
import { COL } from './config.js';
import { dateToSerial, fmtTime } from './time.js';

export function createService({ store, config, now = () => new Date() }) {
  let cache = null;        // { rows, at, timeZone }
  let loading = null;      // 進行中的讀取，避免同時讀很多次
  let lockTail = Promise.resolve();
  let lastMissReload = 0;  // 因為查無代碼而重讀試算表的時間

  /* ---------- 內部工具 ---------- */

  // 對應 LockService：同一時間只處理一筆報到
  function withLock(fn) {
    const run = lockTail.then(fn, fn);
    lockTail = run.catch(() => {});
    return run;
  }

  // 對應 loadRows_：讀整張表，在記憶體快取 cacheSeconds 秒
  async function loadRows({ fresh = false } = {}) {
    const age = cache ? Date.now() - cache.at : Infinity;
    if (cache && !fresh && age <= config.cacheSeconds * 1000) return cache;
    if (!loading) {
      loading = (async () => {
        const [values, timeZone] = await Promise.all([store.readAll(), store.timeZone()]);
        const rows = values.map((r, i) => ({
          row: i + 2,
          code: String(r[COL.CODE] ?? '').trim().toUpperCase(),
          name: String(r[COL.NAME] ?? '').trim(),
          team: String(r[COL.TEAM] ?? '').trim(),
          emails: String(r[COL.EMAIL] ?? '').split(/[,;，；、\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean),
          done: String(r[COL.STATUS] ?? '').trim() === config.doneLabel,
          time: fmtTime(r[COL.TIME], timeZone, config.timeZone),
        })).filter(r => r.code && r.name);
        cache = { rows, at: Date.now(), timeZone };
        return cache;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  function checkPin(pin) {
    const real = String(config.staffPin || '');
    const given = String(pin ?? '').trim();
    if (!real) return false;
    const a = Buffer.from(given), b = Buffer.from(real);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // 對應 parseCode_：新網址 ?code=、舊網址 ?page=scan&code=、純代碼
  function parseCode(raw) {
    const s = String(raw ?? '').trim();
    const m = s.match(/[?&]code=([^&#]+)/);
    let v = m ? m[1] : s;
    if (m) { try { v = decodeURIComponent(v); } catch { /* 保留原字串 */ } }
    return v.trim().toUpperCase();
  }

  function norm(s) {
    return String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  }

  function scanUrl(code) {
    return config.scannerUrl + '?code=' + encodeURIComponent(code);
  }

  /* ---------- 團體頁 API ---------- */

  async function lookupGroup(name, email) {
    const n = norm(name), m = String(email ?? '').trim().toLowerCase();
    if (!n || !m) return { ok: false };
    const { rows } = await loadRows();
    const hit = rows.find(r => norm(r.name) === n && r.emails.includes(m));
    if (!hit) return { ok: false };
    return { ok: true, code: hit.code, name: hit.name, team: hit.team, done: hit.done, time: hit.time, qrText: scanUrl(hit.code) };
  }

  async function getStatus(code) {
    const c = String(code ?? '').trim().toUpperCase();
    const { rows } = await loadRows();
    const hit = c && rows.find(r => r.code === c);
    return hit ? { done: hit.done, time: hit.time } : { done: false };
  }

  /* ---------- 掃描頁 API ---------- */

  function verifyPin(pin) { return checkPin(pin); }

  async function getStats(pin) {
    if (!checkPin(pin)) return { error: 'pin', message: 'PIN' };
    const { rows } = await loadRows();
    return { done: rows.filter(r => r.done).length, total: rows.length };
  }

  // 不含 Email
  async function getRoster(pin) {
    if (!checkPin(pin)) return { error: 'pin', message: 'PIN' };
    const { rows } = await loadRows();
    return { rows: rows.map(r => ({ code: r.code, name: r.name, team: r.team, done: r.done, time: r.time })) };
  }

  async function checkIn(pin, raw, staff) {
    if (!checkPin(pin)) return { result: 'pin' };
    const code = parseCode(raw);
    if (!code) return { result: 'unknown', code: '' };

    return withLock(async () => {
      let data = await loadRows();
      let hit = data.rows.find(r => r.code === code);
      let rowVals = hit ? await store.readRow(hit.row) : null;

      // 快取的列號若已過期（例如排序過），或找不到代碼（可能剛新增團體），重新讀取一次。
      // 查無代碼造成的重讀 3 秒最多一次，避免被亂掃的代碼拖慢（也避免超過 Google API 次數限制）
      const stale = hit && String(rowVals[COL.CODE] ?? '').trim().toUpperCase() !== code;
      if (stale || (!hit && Date.now() - lastMissReload > 3000)) {
        if (!hit) lastMissReload = Date.now();
        data = await loadRows({ fresh: true });
        hit = data.rows.find(r => r.code === code);
        rowVals = hit ? await store.readRow(hit.row) : null;
      }
      if (!hit || String(rowVals[COL.CODE] ?? '').trim().toUpperCase() !== code) return { result: 'unknown', code };

      if (String(rowVals[COL.STATUS] ?? '').trim() === config.doneLabel) {
        const time = fmtTime(rowVals[COL.TIME], data.timeZone, config.timeZone);
        hit.done = true; hit.time = time;
        return { result: 'dup', name: hit.name, team: hit.team, time };
      }

      const at = now();
      await store.writeCheckIn(hit.row, [config.doneLabel, dateToSerial(at, data.timeZone), String(staff ?? '')]);
      const time = fmtTime(at, data.timeZone, config.timeZone);
      // 直接更新快取，團體頁輪詢馬上看得到（寫入期間若快取被重讀，新的那份也要更新）
      hit.done = true; hit.time = time;
      const current = cache && cache.rows.find(r => r.code === code);
      if (current) { current.done = true; current.time = time; }
      const done = data.rows.filter(r => r.done).length;
      return { result: 'ok', name: hit.name, team: hit.team, time, done, total: data.rows.length };
    });
  }

  /* ---------- 路由（對應 doPost） ---------- */

  async function handle(req) {
    try {
      switch (req && req.action) {
        case 'lookupGroup': return await lookupGroup(req.name, req.email);
        case 'getStatus': return await getStatus(req.code);
        case 'verifyPin': return { ok: verifyPin(req.pin) };
        case 'getStats': return await getStats(req.pin);
        case 'getRoster': return await getRoster(req.pin);
        case 'checkIn': return await checkIn(req.pin, req.code, req.staff);
        default: return { error: 'action' };
      }
    } catch (err) {
      console.error('[checkin-api]', req && req.action, err && err.stack || err);
      return { error: 'server', message: String(err && err.message || err) };
    }
  }

  return { handle, loadRows };
}
