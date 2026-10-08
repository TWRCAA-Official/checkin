// 所有設定都來自環境變數（App Service 的「應用程式設定」）。機密只有 STAFF_PIN。

const env = process.env;

function list(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

export const config = {
  port: Number(env.PORT) || 8080,

  // 試算表
  spreadsheetId: env.SPREADSHEET_ID || '',
  // 三種報到各一個分頁，代碼前綴分別是 G-、F-、M-（由 Apps Script 選單產生）
  sheets: {
    team: env.SHEET_NAME || '報到名單',
    float: env.FLOAT_SHEET_NAME || '花車報到',
    market: env.MARKET_SHEET_NAME || '市集報到',
  },
  doneLabel: env.DONE_LABEL || '已報到',
  outLabel: env.OUT_LABEL || '已簽退',
  timeZone: env.TIME_ZONE || 'Asia/Taipei',
  // 名單在記憶體快取多久（秒）。直接在試算表手動修改的內容，最晚這麼久之後生效
  cacheSeconds: Number(env.CACHE_SECONDS) || 15,

  // 工作人員密碼（機密，只放在應用程式設定）
  staffPin: env.STAFF_PIN || '',

  // QR Code 內容：SCANNER_URL?code=團體代碼
  scannerUrl: env.SCANNER_URL || 'https://event.taiwanpride.lgbt/2026/checkin/scan/',

  // 允許呼叫的網頁來源（CORS）
  allowedOrigins: list(env.ALLOWED_ORIGINS || 'https://event.taiwanpride.lgbt'),

  // Google 驗證：Azure Managed Identity → Workload Identity Federation → 服務帳號
  google: {
    // 本機開發用：直接給一個 Google access token（例如 gcloud auth print-access-token），會略過 WIF
    accessToken: env.GOOGLE_ACCESS_TOKEN || '',
    // Managed Identity 取 Entra token 時的 resource（Entra app registration 的 Application ID URI）
    azureResource: env.AZURE_TOKEN_RESOURCE || '',
    // //iam.googleapis.com/projects/<專案編號>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
    wifAudience: env.GOOGLE_WIF_AUDIENCE || '',
    serviceAccount: env.GOOGLE_SERVICE_ACCOUNT || '',
  },
};

export const KINDS = ['team', 'float', 'market'];
// A～G 三個分頁相同（市集的 D 欄是攤位編號）；H～L 只有市集用來記錄簽退
export const COL = {
  CODE: 0, NAME: 1, EMAIL: 2, TEAM: 3, STATUS: 4, TIME: 5, STAFF: 6,
  OUT_STATUS: 7, OUT_TIME: 8, OUT_STAFF: 9, CONDITION: 10, NOTE: 11,
};
// 簽退時的場地狀況
export const CONDITIONS = { clear: '淨空無毀損', issue: '特殊事項' };
