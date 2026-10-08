// 取得 Google API 的 access token，不使用任何金鑰檔：
//   1. 向 App Service 的 Managed Identity 要一張 Entra token
//   2. 用 Google STS 換成 Workload Identity Federation 的聯合憑證
//   3. 以聯合憑證模擬（impersonate）服務帳號，取得可讀寫試算表的 access token
// 本機開發可設定 GOOGLE_ACCESS_TOKEN 直接略過。

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

async function asJson(res, step) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${step} 失敗（HTTP ${res.status}）：${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function azureManagedIdentityToken(resource) {
  const endpoint = process.env.IDENTITY_ENDPOINT, header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) throw new Error('找不到 Managed Identity：請在 App Service 開啟「系統指派的身分識別」');
  const url = `${endpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
  const json = await asJson(await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } }), 'Managed Identity 取得 token');
  return json.access_token;
}

async function googleStsExchange(subjectToken, audience) {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    audience,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    subject_token: subjectToken,
  });
  const json = await asJson(await fetch('https://sts.googleapis.com/v1/token', { method: 'POST', body }), 'Google STS 交換憑證');
  return json.access_token;
}

async function impersonate(federatedToken, serviceAccount) {
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${federatedToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: [SHEETS_SCOPE], lifetime: '3600s' }),
  });
  const json = await asJson(res, '模擬服務帳號');
  return { token: json.accessToken, expiresAt: Date.parse(json.expireTime) };
}

export function createTokenProvider(google) {
  if (google.accessToken) return { token: async () => google.accessToken, reset() {} };

  const missing = ['azureResource', 'wifAudience', 'serviceAccount'].filter(k => !google[k]);

  let current = null, pending = null;
  return {
    async token() {
      // 設定不完整時不讓伺服器啟動失敗，而是在呼叫時回報，方便從 /health?deep=1 看出原因
      if (missing.length) throw new Error('缺少 Google 驗證設定：' + missing.join('、'));
      // 到期前 5 分鐘換新
      if (current && current.expiresAt - Date.now() > 5 * 60000) return current.token;
      if (!pending) {
        pending = (async () => {
          const entra = await azureManagedIdentityToken(google.azureResource);
          const federated = await googleStsExchange(entra, google.wifAudience);
          current = await impersonate(federated, google.serviceAccount);
          return current.token;
        })().finally(() => { pending = null; });
      }
      return pending;
    },
    reset() { current = null; },
  };
}
