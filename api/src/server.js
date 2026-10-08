// HTTP 伺服器：POST / 接收 JSON（Content-Type 為 text/plain，避免 CORS 預檢），格式與 Apps Script 的 doPost 相同。
// GET /health 給 App Service 健康檢查用；GET /health?deep=1 會實際讀一次試算表，用來確認 Google 權限設定正確。

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createService } from './service.js';
import { createSheetStore } from './sheets.js';
import { createTokenProvider } from './google-auth.js';

const MAX_BODY = 16 * 1024;

export function createServer({ service, allowedOrigins }) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin && allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Max-Age'] = '86400';
    }
    const send = (status, body) => { res.writeHead(status, headers); res.end(JSON.stringify(body)); };

    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }

      if (req.method === 'GET' && url.pathname === '/health') {
        if (url.searchParams.get('deep') !== '1') return send(200, { ok: true });
        const { rows } = await service.loadRows({ fresh: true });
        return send(200, { ok: true, groups: rows.length });
      }

      if (req.method !== 'POST' || url.pathname !== '/') return send(404, { error: 'not_found' });

      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return send(413, { error: 'too_large' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return send(400, { error: 'server', message: 'JSON 格式錯誤' }); }

      send(200, await service.handle(body));
    } catch (err) {
      console.error('[checkin-api]', err && err.stack || err);
      send(500, { error: 'server', message: String(err && err.message || err) });
    }
  });
}

// 直接執行時才啟動（測試會自己組裝）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tokenProvider = createTokenProvider(config.google);
  const store = createSheetStore({ spreadsheetId: config.spreadsheetId, tokenProvider });
  const service = createService({ store, config });
  createServer({ service, allowedOrigins: config.allowedOrigins }).listen(config.port, () => {
    console.log(`[checkin-api] listening on ${config.port}`);
  });
}
