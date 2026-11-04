// Database snapshots in DATA_DIR/backups: on a schedule, on demand, and before every restore.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const NAME_RE = /^particull-(\d{8}-\d{6})-(auto|manual|pre-restore|upload)\.db$/;
const KIND_LABELS = { auto: 'Scheduled', manual: 'Made by hand', 'pre-restore': 'Before a restore', upload: 'Uploaded' };

export function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * The most recent moment a scheduled backup should have happened, or null when backups are off.
 * Daily and weekly runs happen at `hour` local time (weekly on Sundays).
 */
export function lastSlot(frequency, hour, at = new Date()) {
  if (frequency === '6h') return new Date(at.getTime() - 6 * 3600e3);
  if (frequency !== 'daily' && frequency !== 'weekly') return null;
  const s = new Date(at);
  s.setHours(hour, 0, 0, 0);
  if (s > at) s.setDate(s.getDate() - 1);
  if (frequency === 'weekly') s.setDate(s.getDate() - s.getDay());
  return s;
}

export class Backups {
  /**
   * @param {string} dir where backups live
   * @param {() => import('./db.js').Store} getStore
   */
  constructor(dir, getStore) {
    this.dir = dir;
    this.getStore = getStore;
    this.timer = null;
    this.lastError = null;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return []; }
    return files.map(name => {
      const m = name.match(NAME_RE);
      if (!m) return null;
      let st;
      try { st = fs.statSync(path.join(this.dir, name)); } catch { return null; }
      return { name, kind: m[2], label: KIND_LABELS[m[2]], size: st.size, createdAt: st.mtime.toISOString() };
    }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  }

  pathFor(name) {
    if (!NAME_RE.test(String(name))) throw Object.assign(new Error('No such backup.'), { status: 404 });
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) throw Object.assign(new Error('No such backup.'), { status: 404 });
    return file;
  }

  /** Write a consistent copy of the live database with VACUUM INTO. */
  create(kind = 'manual') {
    this.ensureDir();
    let name = `particull-${stamp()}-${kind}.db`;
    for (let i = 1; fs.existsSync(path.join(this.dir, name)); i++) name = `particull-${stamp(new Date(Date.now() + i * 1000))}-${kind}.db`;
    const file = path.join(this.dir, name);
    this.getStore().db.prepare('VACUUM INTO ?').run(file);
    return this.list().find(b => b.name === name);
  }

  delete(name) {
    fs.unlinkSync(this.pathFor(name));
  }

  /** Keep the newest `keep` scheduled backups. Hand-made ones stay until you delete them. */
  prune(keep) {
    const autos = this.list().filter(b => b.kind === 'auto');
    for (const b of autos.slice(Math.max(1, keep))) {
      try { fs.unlinkSync(path.join(this.dir, b.name)); } catch { /* already gone */ }
    }
  }

  /** Check that a file is a Particull database before it replaces the live one. */
  static validate(file) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const v = db.prepare('PRAGMA user_version').get().user_version;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
      if (!v || !tables.includes('parts') || !tables.includes('projects')) throw new Error('not particull');
      return { parts: db.prepare('SELECT COUNT(*) AS n FROM parts').get().n, projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get().n };
    } catch {
      throw Object.assign(new Error('That file is not a Particull database.'), { status: 400 });
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  next() {
    const s = this.getStore().getSettings();
    if (s.backupFrequency === 'off') return null;
    const last = this.list().find(b => b.kind === 'auto');
    const slot = lastSlot(s.backupFrequency, s.backupHour);
    if (!last || new Date(last.createdAt) < slot) return new Date();
    if (s.backupFrequency === '6h') return new Date(new Date(last.createdAt).getTime() + 6 * 3600e3);
    const n = new Date(slot);
    n.setDate(n.getDate() + (s.backupFrequency === 'weekly' ? 7 : 1));
    return n;
  }

  /** Run a scheduled backup if one is due. */
  tick() {
    try {
      const s = this.getStore().getSettings();
      if (s.backupFrequency === 'off') return null;
      const slot = lastSlot(s.backupFrequency, s.backupHour);
      const last = this.list().find(b => b.kind === 'auto');
      if (last && new Date(last.createdAt) >= slot) return null;
      const made = this.create('auto');
      this.prune(s.backupKeep);
      this.lastError = null;
      return made;
    } catch (e) {
      this.lastError = e.message;
      console.error('Scheduled backup failed:', e.message);
      return null;
    }
  }

  start() {
    setTimeout(() => this.tick(), 15e3).unref();
    this.timer = setInterval(() => this.tick(), 5 * 60e3);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}
