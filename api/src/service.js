// 報到的商業邏輯，對應 apps-script/Code.gs（團體頁 API、掃描頁 API、內部工具）。
// 隊伍、花車、彩虹市集各一個分頁（config.sheets），代碼在三個分頁之間不重複；市集另外要簽退。
// 試算表的讀寫交給 store（見 sheets.js；測試時用記憶體版本）。

import { timingSafeEqual } from 'node:crypto';
import { COL, CONDITIONS, KINDS } from './config.js';
import { dateToSerial, fmtTime } from './time.js';

const NOTE_MAX = 500;

export function createService({ store, config, now = () => new Date() }) {
  let cache = null;        // { rows, at, timeZone }
  let loading = null;      // 進行中的讀取，避免同時讀很多次
  let lockTail = Promise.resolve();
  let lastMissReload = 0;  // 因為查無代碼而重讀試算表的時間

  /* ---------- 內部工具 ---------- */

  // 對應 LockService：同一時間只處理一筆報到／簽退
  function withLock(fn) {
    const run = lockTail.then(fn, fn);
    lockTail = run.catch(() => {});
    return run;
  }

  const cell = (r, i) => String(r[i] ?? '').trim();

  // 對應 loadRows_：讀三個分頁，在記憶體快取 cacheSeconds 秒
  async function loadRows({ fresh = false } = {}) {
    const age = cache ? Date.now() - cache.at : Infinity;
    if (cache && !fresh && age <= config.cacheSeconds * 1000) return cache;
    if (!loading) {
      loading = (async () => {
        const names = KINDS.map(k => config.sheets[k]);
        const [data, timeZone] = await Promise.all([store.readSheets(names), store.timeZone()]);
        const rows = [], seen = new Set();
        for (const kind of KINDS) {
          const sheet = config.sheets[kind];
          (data[sheet] || []).forEach((r, i) => {
            const g = {
              kind, sheet,
              row: i + 2,
              code: cell(r, COL.CODE).toUpperCase(),
              name: cell(r, COL.NAME),
              team: cell(r, COL.TEAM),
              emails: String(r[COL.EMAIL] ?? '').split(/[,;，；、\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean),
              done: cell(r, COL.STATUS) === config.doneLabel,
              time: fmtTime(r[COL.TIME], timeZone, config.timeZone),
            };
            if (kind === 'market') Object.assign(g, outFields(r, timeZone));
            if (kind === 'team') g.people = cell(r, COL.PEOPLE);
            // 同一個代碼出現在兩個分頁時以先讀到的為準（代碼由選單產生，正常不會重複）
            if (g.code && g.name && !seen.has(g.code)) { seen.add(g.code); rows.push(g); }
          });
        }
        cache = { rows, at: Date.now(), timeZone };
        return cache;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  function outFields(r, timeZone) {
    return {
      out: cell(r, COL.OUT_STATUS) === config.outLabel,
      outTime: fmtTime(r[COL.OUT_TIME], timeZone, config.timeZone),
      condition: cell(r, COL.CONDITION),
    };
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

  function kindOf(kind) { return KINDS.includes(kind) ? kind : 'team'; }

  // 某一種報到的已報到數／總數（簽退時算已簽退數）
  function tally(rows, kind, field = 'done') {
    const list = rows.filter(r => r.kind === kind);
    return { done: list.filter(r => r[field]).length, total: list.length };
  }

  // 找到代碼所在的列並讀出最新內容。快取的列號若已過期（例如排序過），或找不到代碼（可能剛新增），重新讀取一次。
  // 查無代碼造成的重讀 3 秒最多一次，避免被亂掃的代碼拖慢（也避免超過 Google API 次數限制）
  async function findRow(code) {
    let data = await loadRows();
    let hit = data.rows.find(r => r.code === code);
    let vals = hit ? await store.readRow(hit.sheet, hit.row) : null;
    const stale = hit && cell(vals, COL.CODE).toUpperCase() !== code;
    if (stale || (!hit && Date.now() - lastMissReload > 3000)) {
      if (!hit) lastMissReload = Date.now();
      data = await loadRows({ fresh: true });
      hit = data.rows.find(r => r.code === code);
      vals = hit ? await store.readRow(hit.sheet, hit.row) : null;
    }
    if (!hit || cell(vals, COL.CODE).toUpperCase() !== code) return { data };
    return { data, hit, vals };
  }

  // 隊伍的報到結果多帶人數（發手冊用）
  function peopleOf(hit) { return hit.kind === 'team' ? { people: hit.people } : {}; }

  // 寫入後直接更新快取，團體頁輪詢馬上看得到（寫入期間若快取被重讀，新的那份也要更新）
  function patchCache(hit, fields) {
    Object.assign(hit, fields);
    const current = cache && cache.rows.find(r => r.code === hit.code);
    if (current && current !== hit) Object.assign(current, fields);
  }

  /* ---------- 團體頁 API ---------- */

  async function lookupGroup(name, email, kind) {
    const k = kindOf(kind);
    const n = norm(name), m = String(email ?? '').trim().toLowerCase();
    if (!n || !m) return { ok: false };
    const { rows } = await loadRows();
    const hit = rows.find(r => r.kind === k && norm(r.name) === n && r.emails.includes(m));
    if (!hit) return { ok: false };
    const res = { ok: true, kind: k, code: hit.code, name: hit.name, team: hit.team, done: hit.done, time: hit.time, qrText: scanUrl(hit.code) };
    if (k === 'market') Object.assign(res, { out: hit.out, outTime: hit.outTime });
    return res;
  }

  async function getStatus(code) {
    const c = String(code ?? '').trim().toUpperCase();
    const { rows } = await loadRows();
    const hit = c && rows.find(r => r.code === c);
    if (!hit) return { done: false };
    return hit.kind === 'market' ? { done: hit.done, time: hit.time, out: hit.out, outTime: hit.outTime } : { done: hit.done, time: hit.time };
  }

  /* ---------- 掃描頁 API ---------- */

  function verifyPin(pin) { return checkPin(pin); }

  // done／total 是三種合計；kinds 是各自的數字
  async function getStats(pin) {
    if (!checkPin(pin)) return { error: 'pin', message: 'PIN' };
    const { rows } = await loadRows();
    const kinds = Object.fromEntries(KINDS.map(k => [k, tally(rows, k)]));
    kinds.marketOut = tally(rows, 'market', 'out');
    return { done: rows.filter(r => r.done).length, total: rows.length, kinds };
  }

  // 不含 Email
  async function getRoster(pin) {
    if (!checkPin(pin)) return { error: 'pin', message: 'PIN' };
    const { rows } = await loadRows();
    return {
      rows: rows.map(r => {
        const g = { code: r.code, kind: r.kind, name: r.name, team: r.team, done: r.done, time: r.time };
        if (r.kind === 'market') Object.assign(g, { out: r.out, outTime: r.outTime, condition: r.condition });
        if (r.kind === 'team') g.people = r.people;
        return g;
      }),
    };
  }

  async function checkIn(pin, raw, staff) {
    if (!checkPin(pin)) return { result: 'pin' };
    const code = parseCode(raw);
    if (!code) return { result: 'unknown', code: '' };

    return withLock(async () => {
      const { data, hit, vals } = await findRow(code);
      if (!hit) return { result: 'unknown', code };

      if (cell(vals, COL.STATUS) === config.doneLabel) {
        const time = fmtTime(vals[COL.TIME], data.timeZone, config.timeZone);
        patchCache(hit, { done: true, time });
        return { result: 'dup', kind: hit.kind, name: hit.name, team: hit.team, time, ...peopleOf(hit) };
      }

      const at = now();
      await store.writeCells(hit.sheet, hit.row, COL.STATUS, [config.doneLabel, dateToSerial(at, data.timeZone), String(staff ?? '')]);
      const time = fmtTime(at, data.timeZone, config.timeZone);
      patchCache(hit, { done: true, time });
      return { result: 'ok', kind: hit.kind, name: hit.name, team: hit.team, time, ...peopleOf(hit), ...tally(data.rows, hit.kind) };
    });
  }

  // 彩虹市集簽退：condition 是 clear（已完成現場攤位淨空無毀損）或 issue（特殊事項，必須填備註）
  async function checkOut(pin, raw, staff, condition, note) {
    if (!checkPin(pin)) return { result: 'pin' };
    const code = parseCode(raw);
    if (!code) return { result: 'unknown', code: '' };
    const label = CONDITIONS[condition];
    const memo = String(note ?? '').trim().slice(0, NOTE_MAX);
    if (!label || (condition === 'issue' && !memo)) return { result: 'invalid', code };

    return withLock(async () => {
      const { data, hit, vals } = await findRow(code);
      if (!hit) return { result: 'unknown', code };
      if (hit.kind !== 'market') return { result: 'notMarket', code, kind: hit.kind, name: hit.name, team: hit.team };

      const checkedIn = cell(vals, COL.STATUS) === config.doneLabel;
      if (cell(vals, COL.OUT_STATUS) === config.outLabel) {
        const prev = outFields(vals, data.timeZone);
        patchCache(hit, prev);
        return { result: 'dup', kind: 'market', name: hit.name, team: hit.team, time: prev.outTime, condition: prev.condition, note: cell(vals, COL.NOTE) };
      }

      const at = now();
      await store.writeCells(hit.sheet, hit.row, COL.OUT_STATUS,
        [config.outLabel, dateToSerial(at, data.timeZone), String(staff ?? ''), label, memo]);
      const time = fmtTime(at, data.timeZone, config.timeZone);
      patchCache(hit, { out: true, outTime: time, condition: label });
      return { result: 'ok', kind: 'market', name: hit.name, team: hit.team, time, condition: label, checkedIn, ...tally(data.rows, 'market', 'out') };
    });
  }

  /* ---------- 路由（對應 doPost） ---------- */

  async function handle(req) {
    try {
      switch (req && req.action) {
        case 'lookupGroup': return await lookupGroup(req.name, req.email, req.kind);
        case 'getStatus': return await getStatus(req.code);
        case 'verifyPin': return { ok: verifyPin(req.pin) };
        case 'getStats': return await getStats(req.pin);
        case 'getRoster': return await getRoster(req.pin);
        case 'checkIn': return await checkIn(req.pin, req.code, req.staff);
        case 'checkOut': return await checkOut(req.pin, req.code, req.staff, req.condition, req.note);
        default: return { error: 'action' };
      }
    } catch (err) {
      console.error('[checkin-api]', req && req.action, err && err.stack || err);
      return { error: 'server', message: String(err && err.message || err) };
    }
  }

  return { handle, loadRows };
}
