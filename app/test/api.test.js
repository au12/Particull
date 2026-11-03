import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, dir, cookie = '';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'particull-'));
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir, PASSWORD: 'hunter2', PUID: '0' }, stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (p, { method = 'GET', body } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, json, text, headers: r.headers };
};

test('password protects the API', async () => {
  assert.equal((await call('/api/parts')).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const ok = await call('/api/login', { method: 'POST', body: { password: 'hunter2' } });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/parts')).status, 200);
});

test('serves the app shell with a version for cache busting', async () => {
  const r = await call('/');
  assert.match(r.text, /app\.js\?v=\d+\.\d+\.\d+/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
});

test('parts, BOM import, review and exports', async () => {
  const bulk = await call('/api/parts/bulk', { method: 'POST', body: { rows: [{ name: '10k resistor', package: '0805', qty: 40, category: 'Resistors' }, { name: 'Teensy 4.1', qty: 1 }] } });
  assert.equal(bulk.json.created, 2);
  const proj = await call('/api/projects', { method: 'POST', body: { name: 'iPod', bom: '- 4x 10K ohm res 0805\n- 1x Teensy 4.1\n- 1x 2in IPS display' } });
  assert.equal(proj.status, 200);
  assert.deepEqual(proj.json.lines.map(l => l.status), ['review', 'ok', 'missing']);
  const acc = await call(`/api/projects/${proj.json.id}/accept-all`, { method: 'POST', body: {} });
  assert.equal(acc.json.accepted, 1);
  const shop = await call(`/api/projects/${proj.json.id}/export?kind=shopping`);
  assert.match(shop.text, /- 1 × 2in IPS display/);
  const inv = await call('/api/export/inventory?format=md');
  assert.match(inv.text, /40 × 10k resistor \(0805\)/);
  const parse = await call('/api/parse', { method: 'POST', body: { text: '5x 10k resistor 0805\n2 x WS2812B' } });
  assert.equal(parse.json.rows[0].match.name, '10k resistor');
  assert.equal(parse.json.rows[1].category, 'LEDs');
});

test('rejects cross-site writes and bad input', async () => {
  const r = await fetch(`${BASE}/api/parts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.example' }, body: '{"name":"x"}' });
  assert.equal(r.status, 403);
  assert.equal((await call('/api/parts', { method: 'POST', body: { name: '  ' } })).status, 400);
  assert.equal((await call('/api/projects/999')).status, 404);
});
