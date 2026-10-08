// 用 Google Sheets API 讀寫報到分頁（報到名單、花車報到、市集報到）。
// 讀取用 UNFORMATTED_VALUE + SERIAL_NUMBER（日期時間是序號）；寫入用 RAW（經手人名字、備註不會被當成公式）。

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const LAST_COL = 'L';

export function createSheetStore({ spreadsheetId, tokenProvider }) {
  let timeZone = null;

  async function call(path, init = {}, attempt = 1) {
    if (!spreadsheetId) throw new Error('缺少 SPREADSHEET_ID');
    const token = await tokenProvider.token();
    const res = await fetch(API + '/' + spreadsheetId + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (res.status === 401 && attempt === 1) { tokenProvider.reset(); return call(path, init, 2); }
    // 超過次數限制或 Google 暫時錯誤：稍等再試一次
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise(r => setTimeout(r, 400 * attempt));
      return call(path, init, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}：${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  const a1 = (sheet, cells) => `'${sheet.replace(/'/g, "''")}'!${cells}`;
  const READ = 'valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';

  return {
    async timeZone() {
      if (!timeZone) {
        const json = await call('?fields=properties.timeZone');
        timeZone = json.properties && json.properties.timeZone || 'Asia/Taipei';
      }
      return timeZone;
    },
    // 一次讀多個分頁的第 2 列以下：{ 分頁名稱: 列[] }。還沒建立的分頁當成空的
    async readSheets(names) {
      const meta = await call('?fields=sheets.properties.title');
      const titles = new Set((meta.sheets || []).map(s => s.properties.title));
      const present = names.filter(n => titles.has(n));
      const out = Object.fromEntries(names.map(n => [n, []]));
      if (!present.length) return out;
      const ranges = present.map(n => 'ranges=' + encodeURIComponent(a1(n, `A2:${LAST_COL}`))).join('&');
      const json = await call('/values:batchGet?' + ranges + '&' + READ);
      (json.valueRanges || []).forEach((v, i) => { out[present[i]] = v.values || []; });
      return out;
    },
    async readRow(sheet, row) {
      const json = await call('/values/' + encodeURIComponent(a1(sheet, `A${row}:${LAST_COL}${row}`)) + '?' + READ);
      return (json.values && json.values[0]) || [];
    },
    // 從第 col 欄（0 起算）開始寫入一列
    async writeCells(sheet, row, col, values) {
      const from = String.fromCharCode(65 + col), to = String.fromCharCode(65 + col + values.length - 1);
      await call('/values/' + encodeURIComponent(a1(sheet, `${from}${row}:${to}${row}`)) + '?valueInputOption=RAW', {
        method: 'PUT',
        body: JSON.stringify({ majorDimension: 'ROWS', values: [values] }),
      });
    },
  };
}
