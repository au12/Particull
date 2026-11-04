// Particull server: one process, Node's built-in http and sqlite, no npm packages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Store } from './db.js';
import { Backups, stamp } from './backup.js';
import { parseParts } from './public/shared/parse.js';
import { findMatches, guessCategory } from './public/shared/match.js';
import { exportInventory, shoppingList, bomExport, BOM_FORMAT_HINT } from './export.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const env = process.env;
const PORT = Number(env.PORT || 8080);
const HOST = env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
const PASSWORD = env.PASSWORD || '';
const TRUST_PROXY = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
const SESSION_DAYS = 90;

// ---------- start as root just long enough to hand /data to PUID:PGID ----------
function dropPrivileges() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const uid = Number(env.PUID ?? 1000);
  const gid = Number(env.PGID ?? 1000);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const walk = p => {
    try { fs.lchownSync(p, uid, gid); } catch { /* read-only or foreign mount */ }
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
  };
  walk(DATA_DIR);
  process.setgid(gid);
  process.setuid(uid);
}
dropPrivileges();

const DB_FILE = path.join(DATA_DIR, 'particull.db');
let store = new Store(DB_FILE);
const backups = new Backups(path.join(DATA_DIR, 'backups'), () => store);

/** Swap the live database for a backup file. Takes a safety copy first. */
function restoreDatabase(file) {
  const counts = Backups.validate(file);
  backups.create('pre-restore');
  const tmp = `${DB_FILE}.restore`;
  fs.copyFileSync(file, tmp);
  store.close();
  for (const f of [`${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  fs.renameSync(tmp, DB_FILE);
  store = new Store(DB_FILE);
  return counts;
}

// ---------- sessions (only when PASSWORD is set) ----------
function sessionSecret() {
  const f = path.join(DATA_DIR, 'secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* create below */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = PASSWORD ? sessionSecret() : '';
const passwordTag = PASSWORD ? crypto.createHash('sha256').update(PASSWORD).digest('hex').slice(0, 12) : '';
const sign = v => crypto.createHmac('sha256', SECRET).update(`${v}.${passwordTag}`).digest('base64url');
const makeToken = () => { const ts = Date.now().toString(36); return `${ts}.${sign(ts)}`; };
function validToken(tok) {
  if (!tok) return false;
  const [ts, sig] = tok.split('.');
  if (!ts || !sig) return false;
  const expect = sign(ts);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  return Date.now() - parseInt(ts, 36) < SESSION_DAYS * 864e5;
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => {
  const i = c.indexOf('=');
  return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
}));
const isHttps = req => req.socket.encrypted || (TRUST_PROXY && /https/i.test(req.headers['x-forwarded-proto'] || ''));
const clientIp = req => (TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
const authed = req => !PASSWORD || validToken(cookies(req).particull_session);

const loginAttempts = new Map();
function loginAllowed(ip) {
  const t = Date.now();
  const list = (loginAttempts.get(ip) || []).filter(x => t - x < 15 * 60e3);
  loginAttempts.set(ip, list);
  return list.length < 10;
}

// ---------- http helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(req, res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  let data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const h = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers };
  if (data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !h['Content-Encoding']) {
    data = zlib.gzipSync(data);
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : data);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That file is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'The request was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

const download = (name, type) => ({ 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Type': type });
const slug = s => String(s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in the container's TZ

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return k === 'name' ? '([A-Za-z0-9._-]+)' : '(\\d+)'; }) + '/?$');
  routes.push({ method, re, keys, handler, ...opts });
};

route('GET', '/api/health', () => ({ ok: true, version: VERSION, build: BUILD }), { open: true });

route('GET', '/api/session', ({ req }) => ({
  version: VERSION,
  passwordRequired: Boolean(PASSWORD),
  signedIn: authed(req),
  settings: authed(req) ? store.getSettings() : null,
}), { open: true });

route('POST', '/api/login', async ({ req, res, body }) => {
  if (!PASSWORD) return { ok: true };
  const ip = clientIp(req);
  if (!loginAllowed(ip)) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.');
  const given = String(body.password || '');
  const ok = given.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PASSWORD));
  if (!ok) {
    loginAttempts.get(ip).push(Date.now());
    throw new HttpError(401, 'That password is not right.');
  }
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `particull_session=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  return { ok: true, settings: store.getSettings() };
}, { open: true });

route('POST', '/api/logout', ({ res }) => {
  res.setHeader('Set-Cookie', 'particull_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return { ok: true };
}, { open: true });

route('GET', '/api/settings', () => store.getSettings());
route('PUT', '/api/settings', ({ body }) => store.updateSettings(body));

// Parts
route('GET', '/api/parts', () => ({ parts: store.listParts(), groups: store.groups() }));
route('POST', '/api/parts', ({ body }) => store.createPart(body));
route('POST', '/api/parts/bulk', ({ body }) => store.bulkAdd(body.rows));
route('POST', '/api/parts/restore', ({ body }) => store.restorePart(body.part, body.lineIds));
route('POST', '/api/parts/bulk-update', ({ body }) => ({ parts: store.bulkUpdate(body.ids, body.patch) }));
route('POST', '/api/parts/bulk-delete', ({ body }) => ({ removed: store.bulkDelete(body.ids) }));
route('POST', '/api/parts/restore-many', ({ body }) => ({ parts: store.restoreMany(body.removed) }));
route('POST', '/api/parts/merge', ({ body }) => store.mergeParts(body.keepId, body.ids));
route('POST', '/api/parts/adjust', ({ body }) => ({
  parts: (body.changes || []).map(c => store.adjustQty(c.partId, c.delta)).filter(Boolean),
}));
route('GET', '/api/parts/:id', ({ params }) => store.getPart(params.id) || notFound('part'));
route('PUT', '/api/parts/:id', ({ params, body }) => store.updatePart(params.id, body) || notFound('part'));
route('POST', '/api/parts/:id/qty', ({ params, body }) => {
  if ('set' in body) return store.updatePart(params.id, { qty: body.set }) || notFound('part');
  return store.adjustQty(params.id, body.delta) || notFound('part');
});
route('DELETE', '/api/parts/:id', ({ params }) => {
  const lineIds = store.linesUsingPart(params.id);
  const part = store.deletePart(params.id) || notFound('part');
  return { part, lineIds };
});
route('POST', '/api/groups/rename', ({ body }) => ({ changed: store.renameGroup(body.field, body.from, body.to) }));

// Look for parts you already have, for rows about to be added ("Paste a list", "Add a kit").
function withMatches(rows) {
  const parts = store.listParts();
  const cache = new Map();
  return rows.slice(0, 2000).map(r => {
    const [best] = findMatches(r, parts, { limit: 1, min: 0.6, cache });
    return {
      ...r,
      category: r.category || guessCategory(r.name),
      match: best ? {
        id: best.part.id, name: best.part.name, qty: best.part.qty, stockLevel: best.part.stockLevel, unit: best.part.unit,
        score: best.score, exact: best.exact, notes: best.notes,
      } : null,
    };
  });
}
route('POST', '/api/parse', ({ body }) => {
  const { format, rows, skipped } = parseParts(body.text);
  return { format, skipped, rows: withMatches(rows) };
});
route('POST', '/api/match-rows', ({ body }) => ({ rows: withMatches(Array.isArray(body.rows) ? body.rows : []) }));

// Check a name while typing in "Add part".
route('POST', '/api/similar', ({ body }) => {
  const found = findMatches({ name: body.name, mpn: body.mpn, package: body.package }, store.listParts(), { limit: 3, min: 0.6 });
  return {
    category: guessCategory(body.name),
    matches: found.filter(f => f.part.id !== body.exclude).map(f => ({
      id: f.part.id, name: f.part.name, qty: f.part.qty, stockLevel: f.part.stockLevel, unit: f.part.unit, location: f.part.location,
      score: f.score, exact: f.exact, notes: f.notes,
    })),
  };
});

// Projects
route('GET', '/api/projects', () => ({ projects: store.listProjects() }));
route('POST', '/api/projects', ({ body }) => {
  const p = store.createProject(body);
  if (body.bom) {
    const { rows } = parseParts(body.bom);
    store.importBom(p.id, rows);
  }
  return store.getProject(p.id);
});
route('GET', '/api/projects/:id', ({ params }) => store.getProject(params.id) || notFound('project'));
route('PUT', '/api/projects/:id', ({ params, body }) => store.updateProject(params.id, body) && store.getProject(params.id) || notFound('project'));
route('DELETE', '/api/projects/:id', ({ params }) => ({ ok: store.deleteProject(params.id) || notFound('project') }));
route('POST', '/api/projects/:id/bom', ({ params, body }) => {
  const { format, rows, skipped } = parseParts(body.text);
  if (!rows.length) throw new HttpError(400, 'No parts found in that text. Paste a table, a CSV file or one part per line.');
  const added = store.importBom(params.id, rows, { replace: Boolean(body.replace) });
  if (added == null) notFound('project');
  return { added, format, skipped, project: store.getProject(params.id) };
});
route('POST', '/api/projects/:id/lines', ({ params, body }) => {
  if (store.addLine(params.id, body) == null) notFound('project');
  return store.getProject(params.id);
});
route('POST', '/api/projects/:id/rematch', ({ params, body }) => {
  const changed = store.rematch(params.id, { all: Boolean(body.all) });
  return { changed, project: store.getProject(params.id) || notFound('project') };
});
route('POST', '/api/projects/:id/accept-all', ({ params, body }) => {
  const accepted = store.acceptAll(params.id, { remember: body.remember !== false });
  return { accepted, project: store.getProject(params.id) || notFound('project') };
});
route('POST', '/api/projects/:id/build', ({ params, body }) => {
  const r = store.buildProject(params.id, body.count) || notFound('project');
  return { ...r, project: store.getProject(params.id) };
});
route('POST', '/api/builds/:id/undo', ({ params }) => {
  const n = store.undoBuild(params.id);
  if (n == null) notFound('build');
  return { restored: n };
});
route('POST', '/api/projects/:id/receive', ({ params, body }) => {
  const r = store.receiveShortfall(params.id, { category: body.category }, guessCategory) || notFound('project');
  return { ...r, project: store.getProject(params.id) };
});
route('GET', '/api/lines/:id/candidates', ({ params }) => ({ candidates: store.candidatesFor(params.id) || notFound('line') }));
route('PUT', '/api/lines/:id', ({ params, body }) => {
  const l = store.updateLine(params.id, body, { remember: Boolean(body.remember) }) || notFound('line');
  return store.getProject(l.project_id);
});
route('DELETE', '/api/lines/:id', ({ params }) => {
  const l = store.getLine(params.id) || notFound('line');
  store.deleteLine(l.id);
  return store.getProject(l.project_id);
});

// Exports
route('GET', '/api/export/inventory', ({ query }) => {
  const s = store.getSettings();
  const format = ['md', 'csv', 'json'].includes(query.get('format')) ? query.get('format') : 'md';
  const flag = (k, d) => (query.has(k) ? query.get(k) === '1' : d);
  const body = exportInventory(store.listParts(), {
    format,
    locations: flag('locations', s.exportIncludeLocations),
    notes: flag('notes', s.exportIncludeNotes),
    empty: flag('empty', s.exportIncludeEmpty),
    compact: format === 'md' && flag('compact', s.exportCompact),
    cost: s.costTracking && flag('cost', false),
    currency: s.currency,
  });
  const type = { md: 'text/markdown', csv: 'text/csv', json: 'application/json' }[format];
  const headers = query.get('download') === '1' ? download(`particull-inventory-${today()}.${format}`, `${type}; charset=utf-8`) : {};
  return { raw: body, type: `${type}; charset=utf-8`, headers };
});
route('GET', '/api/projects/:id/export', ({ params, query }) => {
  const p = store.getProject(params.id) || notFound('project');
  const s = store.getSettings();
  const kind = query.get('kind') === 'bom' ? 'bom' : 'shopping';
  const format = query.get('format') === 'csv' ? 'csv' : 'md';
  const body = kind === 'bom' ? bomExport(p, { format }) : shoppingList(p, { format, cost: s.costTracking, currency: s.currency });
  const type = format === 'csv' ? 'text/csv' : 'text/markdown';
  const headers = query.get('download') === '1' ? download(`${slug(p.name)}-${kind === 'bom' ? 'bom' : 'shopping-list'}.${format}`, `${type}; charset=utf-8`) : {};
  return { raw: body, type: `${type}; charset=utf-8`, headers };
});
route('GET', '/api/bom-format', () => ({ text: BOM_FORMAT_HINT }));

route('GET', '/api/backup', () => ({
  raw: JSON.stringify(store.exportAll(), null, 2),
  type: 'application/json; charset=utf-8',
  headers: download(`particull-backup-${today()}.json`, 'application/json; charset=utf-8'),
}));
route('POST', '/api/restore', ({ body }) => {
  if (!body || body.app !== 'particull') throw new HttpError(400, 'This file is not a Particull backup.');
  backups.create('pre-restore');
  return store.importAll(body);
}, { limit: 100 * 1024 * 1024 });

// Database snapshots
route('GET', '/api/backups', () => ({ backups: backups.list(), next: backups.next(), lastError: backups.lastError }));
route('POST', '/api/backups', () => ({ backup: backups.create('manual'), backups: backups.list() }));
route('GET', '/api/backups/:name', ({ params }) => ({
  raw: fs.readFileSync(backups.pathFor(params.name)),
  type: 'application/vnd.sqlite3',
  headers: download(params.name, 'application/vnd.sqlite3'),
}));
route('DELETE', '/api/backups/:name', ({ params }) => { backups.delete(params.name); return { backups: backups.list() }; });
route('POST', '/api/backups/:name/restore', ({ params }) => {
  const counts = restoreDatabase(backups.pathFor(params.name));
  return { ...counts, backups: backups.list() };
});
// Restore from a .db file you upload (base64 in JSON keeps the server free of multipart parsing).
route('POST', '/api/backups/upload', ({ body }) => {
  const data = Buffer.from(String(body.data || ''), 'base64');
  if (data.length < 512 || data.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new HttpError(400, 'That file is not a Particull database.');
  backups.ensureDir();
  const file = path.join(backups.dir, `particull-upload-${Date.now()}.tmp`);
  fs.writeFileSync(file, data);
  try {
    Backups.validate(file);
    const kept = path.join(backups.dir, `particull-${stamp()}-upload.db`);
    fs.renameSync(file, kept);
    const counts = restoreDatabase(kept);
    return { ...counts, backups: backups.list() };
  } finally {
    try { fs.unlinkSync(file); } catch { /* moved */ }
  }
}, { limit: 150 * 1024 * 1024 });

function notFound(what) {
  throw new HttpError(404, `That ${what} doesn't exist anymore.`);
}

// ---------- static files ----------
// A hash of everything in public/ names this build: it busts browser caches and tells the
// service worker when to fetch a fresh copy of the app.
function listPublic(dir = PUBLIC) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listPublic(full) : [full];
  });
}
const PUBLIC_FILES = listPublic().filter(f => !/\.(txt|md)$/.test(f)).sort();
const BUILD = (() => {
  const hash = crypto.createHash('sha1').update(VERSION);
  for (const f of PUBLIC_FILES) hash.update(f).update(fs.readFileSync(f));
  return hash.digest('hex').slice(0, 10);
})();
const SHELL_ASSETS = ['/', `/css/app.css?v=${BUILD}`, `/js/app.js?v=${BUILD}`, ...PUBLIC_FILES
  .map(f => `/${path.relative(PUBLIC, f).split(path.sep).join('/')}`)
  .filter(u => u !== '/index.html' && u !== '/sw.js' && u !== '/css/app.css' && u !== '/js/app.js' && !/^\/icons\/(icon-512|icon-maskable|apple-touch)/.test(u))];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
const fileCache = new Map();

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(req, res, 403, 'Forbidden', 'text/plain');
  let entry = fileCache.get(file);
  if (!entry) {
    let data;
    try { data = fs.readFileSync(file); } catch { return send(req, res, 404, 'Not found', 'text/plain'); }
    if (file.endsWith('index.html') || file.endsWith('sw.js')) {
      data = Buffer.from(data.toString('utf8')
        .replaceAll('{{VERSION}}', VERSION)
        .replaceAll('{{BUILD}}', BUILD)
        .replaceAll('{{ASSETS}}', JSON.stringify(SHELL_ASSETS)));
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const gz = /^(text|application\/(json|manifest)|image\/svg)/.test(type) ? zlib.gzipSync(data) : null;
    entry = { data, gz, type, etag: `"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 16)}"` };
    if (env.NODE_ENV === 'production') fileCache.set(file, entry);
  }
  const headers = { 'Content-Type': entry.type, ETag: entry.etag, 'X-Content-Type-Options': 'nosniff' };
  const versioned = new URL(req.url, 'http://x').searchParams.has('v');
  headers['Cache-Control'] = versioned ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (entry.type.startsWith('text/html')) {
    headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'";
    headers['Referrer-Policy'] = 'same-origin';
  }
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
  let data = entry.data;
  if (entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    data = entry.gz;
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

// ---------- dispatch ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, pathname);
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let matched = null, params = {};
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) { matched = r; r.keys.forEach((k, i) => { params[k] = m[i + 1]; }); break; }
    }
    if (!matched) return send(req, res, 404, { error: 'No such endpoint.' });
    if (!matched.open && !authed(req)) return send(req, res, 401, { error: 'Sign in to continue.' });
    if (method !== 'GET' && !matched.open) {
      // Same-origin check for state-changing requests.
      const origin = req.headers.origin;
      const host = req.headers['x-forwarded-host'] && TRUST_PROXY ? req.headers['x-forwarded-host'] : req.headers.host;
      if (origin && new URL(origin).host !== host) return send(req, res, 403, { error: 'Cross-site request refused.' });
    }
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req, matched.limit);
    const out = await matched.handler({ req, res, params, body, query: url.searchParams });
    if (out && typeof out === 'object' && 'raw' in out) return send(req, res, 200, out.raw, out.type, out.headers);
    return send(req, res, 200, out ?? { ok: true });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    return send(req, res, status, { error: status >= 500 ? 'Something went wrong on the server. Check the container log.' : e.message });
  }
});

backups.start();
server.listen(PORT, HOST, () => {
  console.log(`Particull ${VERSION} listening on http://${HOST}:${PORT} (data in ${DATA_DIR}${PASSWORD ? ', password on' : ''})`);
});

const shutdown = () => { backups.stop(); server.close(); try { store.close(); } catch { /* already closed */ } process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
