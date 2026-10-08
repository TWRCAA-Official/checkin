import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

const ORIGIN = 'https://twrcaa-official.github.io';
let server, base;

before(async () => {
  const service = {
    async handle(req) { return req.action === 'echo' ? { got: req } : { error: 'action' }; },
    async loadRows() { return { rows: [1, 2, 3] }; },
  };
  server = createServer({ service, allowedOrigins: [ORIGIN] });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(r => server.close(r)));

test('POST text/plain JSON（與前端相同的呼叫方式），允許的來源有 CORS 標頭', async () => {
  const res = await fetch(base + '/', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8', Origin: ORIGIN }, body: JSON.stringify({ action: 'echo', name: '彩虹' }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(await res.json(), { got: { action: 'echo', name: '彩虹' } });
});

test('其他來源沒有 CORS 標頭（瀏覽器會擋）', async () => {
  const res = await fetch(base + '/', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{"action":"echo"}' });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('OPTIONS 預檢', async () => {
  const res = await fetch(base + '/', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('JSON 格式錯誤、太大、不存在的路徑', async () => {
  assert.equal((await fetch(base + '/', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await fetch(base + '/', { method: 'POST', body: 'x'.repeat(20000) })).status, 413);
  assert.equal((await fetch(base + '/nope')).status, 404);
});

test('健康檢查', async () => {
  assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true });
  assert.deepEqual(await (await fetch(base + '/health?deep=1')).json(), { ok: true, groups: 3 });
});
