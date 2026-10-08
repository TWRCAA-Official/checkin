// 用 Google Sheets API 讀寫「報到名單」分頁。
// 讀取用 UNFORMATTED_VALUE + SERIAL_NUMBER（日期時間是序號）；寫入用 RAW（經手人名字不會被當成公式）。

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export function createSheetStore({ spreadsheetId, sheetName, tokenProvider }) {
  const quoted = `'${sheetName.replace(/'/g, "''")}'`;
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

  const range = a1 => '/values/' + encodeURIComponent(`${quoted}!${a1}`);
  const READ = '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';

  return {
    async timeZone() {
      if (!timeZone) {
        const json = await call('?fields=properties.timeZone');
        timeZone = json.properties && json.properties.timeZone || 'Asia/Taipei';
      }
      return timeZone;
    },
    async readAll() {
      const json = await call(range('A2:G') + READ);
      return json.values || [];
    },
    async readRow(row) {
      const json = await call(range(`A${row}:G${row}`) + READ);
      return (json.values && json.values[0]) || [];
    },
    // 寫入 E～G：報到狀態、報到時間（序號）、經手人
    async writeCheckIn(row, values) {
      await call(range(`E${row}:G${row}`) + '?valueInputOption=RAW', {
        method: 'PUT',
        body: JSON.stringify({ majorDimension: 'ROWS', values: [values] }),
      });
    },
  };
}
