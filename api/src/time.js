// 試算表的日期時間是「序號」：1899-12-30 起算的天數，小數是一天中的時間，以試算表的時區為準。

const DAY_MS = 86400000;
const EPOCH_SERIAL = 25569; // 1970-01-01 的序號

// 某個時區在某個時間點的 UTC 偏移（分鐘），例如 Asia/Taipei → 480
export function tzOffsetMinutes(timeZone, date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date).find(p => p.type === 'timeZoneName').value; // "GMT+08:00" 或 "GMT"
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

export function serialToDate(serial, sheetTimeZone) {
  const wall = (serial - EPOCH_SERIAL) * DAY_MS; // 把試算表的當地時間當成 UTC
  const offset = tzOffsetMinutes(sheetTimeZone, new Date(wall));
  // 序號是浮點數，四捨五入到秒，避免 12:30:00 變成 12:29:59.999
  return new Date(Math.round((wall - offset * 60000) / 1000) * 1000);
}

export function dateToSerial(date, sheetTimeZone) {
  const offset = tzOffsetMinutes(sheetTimeZone, date);
  return (date.getTime() + offset * 60000) / DAY_MS + EPOCH_SERIAL;
}

export function formatHM(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

// 對應 Code.gs 的 fmtTime_：日期時間 → HH:mm，其他原樣轉成字串
export function fmtTime(value, sheetTimeZone, displayTimeZone) {
  if (typeof value === 'number' && isFinite(value)) return formatHM(serialToDate(value, sheetTimeZone), displayTimeZone);
  if (value instanceof Date) return formatHM(value, displayTimeZone);
  return String(value ?? '');
}
