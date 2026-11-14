// SQLite storage for parts, projects and BOM lines (node:sqlite, no npm packages).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findMatches, MATCH_SUGGEST, compact } from './public/shared/match.js';
import { LEVELS, roundQty } from './public/shared/stock.js';

export const DEFAULT_SETTINGS = {
  costTracking: false,
  currency: '$',
  theme: 'system',
  exportIncludeLocations: false,
  exportIncludeNotes: true,
  exportIncludeEmpty: false,
  exportCompact: true,
  backupFrequency: 'daily',
  backupKeep: 14,
  backupHour: 3,
  rememberMatches: true,
  labelBaseUrl: '',
};

export const BACKUP_FREQUENCIES = ['off', '6h', 'daily', 'weekly'];
export const PROJECT_STATUSES = ['idea', 'planned', 'building', 'done'];

const SCHEMA = [
  // v1
  `
  CREATE TABLE parts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    mpn TEXT NOT NULL DEFAULT '',
    package TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '[]',
    min_qty INTEGER,
    cost REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX parts_category ON parts(category);
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    builds INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE bom_lines (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    qty INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    mpn TEXT NOT NULL DEFAULT '',
    package TEXT NOT NULL DEFAULT '',
    refs TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'none',
    score REAL,
    match_notes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE INDEX bom_project ON bom_lines(project_id, position);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE builds (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    count INTEGER NOT NULL,
    changes TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // v2: rough stock levels, units, project status and archiving
  `
  ALTER TABLE parts ADD COLUMN stock_level TEXT;
  ALTER TABLE parts ADD COLUMN unit TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'planned';
  ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  `,
  // v3: a log of every change to a part, for history and undo
  `
  CREATE TABLE part_events (
    id INTEGER PRIMARY KEY,
    part_id INTEGER,
    part_name TEXT NOT NULL,
    batch TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    changes TEXT NOT NULL DEFAULT '{}',
    data TEXT NOT NULL DEFAULT '',
    ref TEXT NOT NULL DEFAULT '',
    undone INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX part_events_part ON part_events(part_id, id);
  CREATE INDEX part_events_batch ON part_events(batch);
  `,
];

// What a change to a part was, for its history:
//   edit     changed in the editor, the list or several at once
//   create   added (one at a time, from a list, a kit or a received order)
//   add      stock added to a part you already had (from a list or kit)
//   build    taken out by building a project
//   receive  added when an order for a project arrived
//   delete   deleted
//   restore  put back after a delete
//   merge    combined with a duplicate
//   undo     an undo of an earlier change
export const UNDOABLE = ['edit', 'create', 'add', 'build', 'receive', 'delete'];
const TRACKED_FIELDS = ['name', 'qty', 'stockLevel', 'unit', 'category', 'location', 'mpn', 'package', 'notes', 'link', 'aliases', 'minQty', 'cost'];
const newBatch = () => crypto.randomBytes(6).toString('hex');

// Line states:
//   auto      matched on its own (same name, part number or a remembered alias)
//   confirmed you approved or picked the part
//   review    a likely match that needs your OK
//   none      nothing in inventory looks like it
//   skip      you don't track this one (wire, solder, glue)
export const LINE_STATES = ['auto', 'confirmed', 'review', 'none', 'skip'];

const now = () => new Date().toISOString();
const str = (v, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
const int = (v, d = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const optNum = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
const qtyNum = (v, d = 0) => {
  const n = roundQty(v);
  return Number.isFinite(n) ? Math.max(0, n) : d;
};
const lineQty = v => {
  const n = roundQty(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
};
const levelOf = v => (LEVELS.includes(v) ? v : null);
const ids = list => [...new Set((Array.isArray(list) ? list : []).map(x => int(x)).filter(x => x > 0))];

function cleanAliases(list, name) {
  const seen = new Set([compact(name)]);
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const s = str(a, 200);
    const c = compact(s);
    if (!s || !c || seen.has(c)) continue;
    seen.add(c);
    out.push(s);
  }
  return out.slice(0, 50);
}

export class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
    this.matchCache = new Map();
    this.action = null;
  }

  // ---------- change log ----------
  /**
   * Run fn as one action: every part change inside it is logged with the same batch,
   * kind and reason, so one undo reverses all of it.
   */
  withAction(action, fn) {
    const prev = this.action;
    this.action = { batch: prev?.batch || newBatch(), kind: 'edit', reason: '', ref: '', ...prev, ...action };
    try {
      return this.tx(fn);
    } finally {
      this.action = prev;
    }
  }

  logEvent(part, kind, changes = {}, { data = '', reason } = {}) {
    const a = this.action || { batch: newBatch(), kind: 'edit', reason: '', ref: '' };
    this.db.prepare(`INSERT INTO part_events (part_id, part_name, batch, kind, reason, changes, data, ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(part.id, part.name, a.batch, kind, reason ?? a.reason ?? '', JSON.stringify(changes), data ? JSON.stringify(data) : '', a.ref || '', now());
  }

  rowToEvent(r) {
    let changes = {};
    try { changes = JSON.parse(r.changes); } catch { /* ignore */ }
    return { id: r.id, partId: r.part_id, partName: r.part_name, batch: r.batch, kind: r.kind, reason: r.reason, changes, ref: r.ref, undone: Boolean(r.undone), at: r.created_at };
  }

  partHistory(partId, limit = 40) {
    return this.db.prepare('SELECT * FROM part_events WHERE part_id = ? ORDER BY id DESC LIMIT ?').all(int(partId), limit).map(r => this.rowToEvent(r));
  }

  /** The most recent change that could be undone, if the latest change allows it. */
  lastChange() {
    const row = this.db.prepare(`SELECT batch FROM part_events WHERE undone = 0 AND kind NOT IN ('undo', 'restore') ORDER BY id DESC LIMIT 1`).get();
    if (!row) return null;
    const events = this.db.prepare('SELECT * FROM part_events WHERE batch = ? AND undone = 0 ORDER BY id').all(row.batch).map(r => this.rowToEvent(r));
    const undoable = events.every(e => UNDOABLE.includes(e.kind));
    return { batch: row.batch, events, undoable, summary: describeBatch(events), at: events[events.length - 1].at };
  }

  /** Undo the most recent change: amounts and fields go back, added parts go away, deleted parts come back. */
  undoLast() {
    const last = this.lastChange();
    if (!last) throw Object.assign(new Error('There’s nothing to undo.'), { status: 409 });
    if (!last.undoable) throw Object.assign(new Error(`${last.summary} can’t be undone. Restore a backup to go back further.`), { status: 409 });
    const touched = new Set();
    this.withAction({ batch: newBatch(), kind: 'undo', reason: `Undid: ${last.summary}`, ref: '' }, () => {
      const build = last.events.find(e => e.ref.startsWith('build:'));
      if (build) {
        this.undoBuild(Number(build.ref.split(':')[1]));
        last.events.forEach(e => touched.add(e.partId));
        return;
      }
      for (const e of [...last.events].reverse()) {
        if (e.kind === 'delete') {
          const row = this.db.prepare('SELECT data FROM part_events WHERE id = ?').get(e.id);
          const { part, lineIds } = JSON.parse(row.data || '{}');
          if (part && !this.getPart(part.id)) this.restorePart(part, lineIds || []);
        } else if (e.kind === 'create') {
          if (this.getPart(e.partId)) this.deletePart(e.partId, { log: false });
        } else {
          const patch = {};
          for (const [field, [old]] of Object.entries(e.changes)) patch[field] = old;
          if (Object.keys(patch).length && this.getPart(e.partId)) this.updatePart(e.partId, patch);
        }
        touched.add(e.partId);
      }
      const mark = this.db.prepare('UPDATE part_events SET undone = 1 WHERE id = ?');
      for (const e of last.events) mark.run(e.id);
    });
    return { summary: last.summary, partIds: [...touched] };
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let i = v; i < SCHEMA.length; i++) {
      this.tx(() => {
        this.db.exec(SCHEMA[i]);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  /** Run fn in a transaction. Nested calls join the outer transaction. */
  tx(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN');
    this.inTx = true;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  close() { this.db.close(); }

  // ---------- settings ----------
  getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const r of this.db.prepare('SELECT key, value FROM settings').all()) {
      if (r.key in DEFAULT_SETTINGS) {
        try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ }
      }
    }
    return out;
  }

  updateSettings(patch) {
    const stmt = this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      const def = DEFAULT_SETTINGS[k];
      let val = v;
      if (typeof def === 'boolean') val = Boolean(v);
      else if (k === 'theme') val = ['system', 'light', 'dark'].includes(v) ? v : 'system';
      else if (k === 'currency') val = str(v, 4) || '$';
      else if (k === 'backupFrequency') val = BACKUP_FREQUENCIES.includes(v) ? v : 'daily';
      else if (k === 'backupKeep') val = Math.min(365, Math.max(1, int(v, 14)));
      else if (k === 'backupHour') val = Math.min(23, Math.max(0, int(v, 3)));
      else if (k === 'labelBaseUrl') {
        const u = str(v, 200).replace(/\/+$/, '');
        val = /^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(u) ? u : '';
      }
      stmt.run(k, JSON.stringify(val));
    }
    return this.getSettings();
  }

  // ---------- parts ----------
  rowToPart(r) {
    if (!r) return null;
    let aliases = [];
    try { aliases = JSON.parse(r.aliases); } catch { /* ignore */ }
    return {
      id: r.id, name: r.name, qty: r.qty, category: r.category, location: r.location,
      mpn: r.mpn, package: r.package, notes: r.notes, link: r.link, aliases,
      minQty: r.min_qty, cost: r.cost, stockLevel: r.stock_level || null, unit: r.unit || '',
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  listParts() {
    return this.db.prepare('SELECT * FROM parts ORDER BY name COLLATE NOCASE').all().map(r => this.rowToPart(r));
  }

  getPart(id) {
    return this.rowToPart(this.db.prepare('SELECT * FROM parts WHERE id = ?').get(int(id)));
  }

  normalizePart(p, existing = {}) {
    const name = str(p.name ?? existing.name, 200);
    if (!name) throw Object.assign(new Error('A part needs a name.'), { status: 400 });
    return {
      name,
      qty: qtyNum(p.qty ?? existing.qty ?? 0),
      stockLevel: 'stockLevel' in p ? levelOf(p.stockLevel) : (existing.stockLevel ?? null),
      unit: str(p.unit ?? existing.unit ?? '', 16).toLowerCase() === 'pcs' ? '' : str(p.unit ?? existing.unit ?? '', 16),
      category: str(p.category ?? existing.category ?? '', 80),
      location: str(p.location ?? existing.location ?? '', 80),
      mpn: str(p.mpn ?? existing.mpn ?? '', 120),
      package: str(p.package ?? existing.package ?? '', 60),
      notes: text(p.notes ?? existing.notes ?? '', 2000),
      link: str(p.link ?? existing.link ?? '', 1000),
      aliases: cleanAliases(p.aliases ?? existing.aliases ?? [], name),
      minQty: 'minQty' in p ? optNum(p.minQty) : (existing.minQty ?? null),
      cost: 'cost' in p ? optNum(p.cost) : (existing.cost ?? null),
    };
  }

  createPart(input, { id, logAs = 'create' } = {}) {
    const p = this.normalizePart(input);
    const t = now();
    const sql = `INSERT INTO parts (${id ? 'id, ' : ''}name, qty, category, location, mpn, package, notes, link, aliases, min_qty, cost, stock_level, unit, created_at, updated_at)
      VALUES (${id ? '?, ' : ''}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const args = [p.name, p.qty, p.category, p.location, p.mpn, p.package, p.notes, p.link, JSON.stringify(p.aliases), p.minQty, p.cost, p.stockLevel, p.unit, input.createdAt || t, t];
    const r = this.db.prepare(sql).run(...(id ? [int(id), ...args] : args));
    this.matchCache.clear();
    const part = this.getPart(Number(r.lastInsertRowid));
    if (logAs) this.logEvent(part, logAs, logAs === 'create' ? { qty: [null, part.qty], stockLevel: [null, part.stockLevel] } : {});
    return part;
  }

  updatePart(id, patch) {
    const existing = this.getPart(id);
    if (!existing) return null;
    const p = this.normalizePart(patch, existing);
    const changes = {};
    for (const f of TRACKED_FIELDS) {
      const a = existing[f] ?? null, b = p[f] ?? null;
      if (JSON.stringify(a) !== JSON.stringify(b)) changes[f] = [a, b];
    }
    if (!Object.keys(changes).length) return existing;
    this.db.prepare(`UPDATE parts SET name=?, qty=?, category=?, location=?, mpn=?, package=?, notes=?, link=?, aliases=?, min_qty=?, cost=?, stock_level=?, unit=?, updated_at=? WHERE id=?`)
      .run(p.name, p.qty, p.category, p.location, p.mpn, p.package, p.notes, p.link, JSON.stringify(p.aliases), p.minQty, p.cost, p.stockLevel, p.unit, now(), existing.id);
    this.matchCache.clear();
    this.logEvent(existing, this.action?.kind || 'edit', changes);
    return this.getPart(existing.id);
  }

  adjustQty(id, delta) {
    const part = this.getPart(id);
    if (!part) return null;
    const next = Math.max(0, roundQty(part.qty + (roundQty(delta) || 0)));
    if (next === part.qty) return part;
    this.db.prepare('UPDATE parts SET qty = ?, updated_at = ? WHERE id = ?').run(next, now(), part.id);
    this.logEvent(part, this.action?.kind || 'edit', { qty: [part.qty, next] });
    return this.getPart(part.id);
  }

  /**
   * Add stock that arrived. Counted parts go up by the amount; a part tracked by level
   * that was low or out goes back to Plenty.
   */
  addStock(id, amount) {
    const part = this.getPart(id);
    if (!part) return null;
    if (part.stockLevel) {
      if (part.stockLevel === 'low' || part.stockLevel === 'out') return this.updatePart(part.id, { stockLevel: 'plenty' });
      return part;
    }
    return this.adjustQty(part.id, Math.max(0, roundQty(amount) || 0));
  }

  /** Change several parts at once: category, location, unit or how stock is tracked. */
  bulkUpdate(partIds, patch = {}) {
    const allowed = {};
    if ('category' in patch) allowed.category = patch.category;
    if ('location' in patch) allowed.location = patch.location;
    if ('unit' in patch) allowed.unit = patch.unit;
    if ('stockLevel' in patch) allowed.stockLevel = patch.stockLevel;
    if (!Object.keys(allowed).length) throw Object.assign(new Error('Nothing to change.'), { status: 400 });
    const list = ids(partIds);
    return this.withAction({ kind: 'edit', reason: list.length > 1 ? `Changed ${list.length} parts` : '' }, () => list.map(id => this.updatePart(id, allowed)).filter(Boolean));
  }

  /** Delete several parts. Returns what's needed to put them back. */
  bulkDelete(partIds) {
    const list = ids(partIds);
    return this.withAction({ kind: 'delete', reason: list.length > 1 ? `Deleted ${list.length} parts` : '' }, () => list.map(id => {
      const lineIds = this.linesUsingPart(id);
      const part = this.deletePart(id);
      return part && { part, lineIds };
    }).filter(Boolean));
  }

  restoreMany(removed) {
    return this.tx(() => (removed || []).map(r => this.restorePart(r.part, r.lineIds)));
  }

  /**
   * Fold other parts into one. Quantities add up, the other names become aliases,
   * empty fields are filled from the others, and BOM lines and build history follow.
   */
  mergeParts(keepId, otherIds) {
    const keep = this.getPart(keepId);
    if (!keep) throw Object.assign(new Error('That part no longer exists.'), { status: 404 });
    const others = ids(otherIds).filter(id => id !== keep.id).map(id => this.getPart(id)).filter(Boolean);
    if (!others.length) throw Object.assign(new Error('Pick at least two parts to merge.'), { status: 400 });
    return this.withAction({ kind: 'merge', reason: `Merged with ${others.map(o => o.name).join(', ')}` }, () => {
      const next = { ...keep };
      const rank = { plenty: 3, some: 2, low: 1, out: 0 };
      for (const o of others) {
        if (next.stockLevel || o.stockLevel) {
          // A level beats a count; between two levels, keep the better one.
          const a = next.stockLevel, b = o.stockLevel;
          next.stockLevel = !a ? b : !b ? a : (rank[a] >= rank[b] ? a : b);
        }
        next.qty = roundQty(next.qty + o.qty);
        for (const f of ['category', 'location', 'mpn', 'package', 'link', 'unit']) if (!next[f] && o[f]) next[f] = o[f];
        if (o.notes && !next.notes.includes(o.notes)) next.notes = next.notes ? `${next.notes}\n${o.notes}` : o.notes;
        if (next.minQty == null) next.minQty = o.minQty;
        if (next.cost == null) next.cost = o.cost;
        next.aliases = [...next.aliases, o.name, ...o.aliases];
        this.db.prepare('UPDATE bom_lines SET part_id = ? WHERE part_id = ?').run(keep.id, o.id);
        for (const b of this.db.prepare('SELECT id, changes FROM builds').all()) {
          const changes = JSON.parse(b.changes);
          if (!changes.some(c => c.partId === o.id)) continue;
          this.db.prepare('UPDATE builds SET changes = ? WHERE id = ?').run(JSON.stringify(changes.map(c => (c.partId === o.id ? { ...c, partId: keep.id } : c))), b.id);
        }
        this.logEvent(o, 'merge', {}, { reason: `Merged into ${keep.name}` });
        this.db.prepare('DELETE FROM parts WHERE id = ?').run(o.id);
      }
      const merged = this.updatePart(keep.id, next);
      this.matchCache.clear();
      return { part: merged, removed: others.map(o => o.id) };
    });
  }

  linesUsingPart(id) {
    return this.db.prepare('SELECT id FROM bom_lines WHERE part_id = ?').all(int(id)).map(r => r.id);
  }

  deletePart(id, { log = true } = {}) {
    const part = this.getPart(id);
    if (!part) return null;
    if (log) this.logEvent(part, 'delete', {}, { data: { part, lineIds: this.linesUsingPart(part.id) } });
    this.db.prepare(`UPDATE bom_lines SET state = 'none', score = NULL, match_notes = '[]' WHERE part_id = ?`).run(part.id);
    this.db.prepare('DELETE FROM parts WHERE id = ?').run(part.id);
    this.matchCache.clear();
    return part;
  }

  /** Restore a deleted part with its id, then re-link BOM lines that pointed at it. */
  restorePart(part, lineIds = []) {
    return this.tx(() => {
      const restored = this.createPart(part, { id: part.id, logAs: 'restore' });
      this.db.prepare(`UPDATE part_events SET undone = 1 WHERE part_id = ? AND kind = 'delete' AND undone = 0`).run(restored.id);
      const stmt = this.db.prepare(`UPDATE bom_lines SET part_id = ?, state = 'confirmed' WHERE id = ? AND part_id IS NULL`);
      for (const l of lineIds) stmt.run(restored.id, int(l));
      return restored;
    });
  }

  addAlias(partId, alias) {
    const part = this.getPart(partId);
    if (!part) return null;
    return this.updatePart(part.id, { aliases: [...part.aliases, alias] });
  }

  /**
   * Add many parts at once. Rows with mergeInto add their quantity to an existing part.
   * @returns {{created: number, merged: number, parts: object[]}}
   */
  bulkAdd(rows, { source = 'list' } = {}) {
    const reason = source === 'kit' ? 'Added from a kit' : source === 'list' ? 'Added from a list' : '';
    return this.withAction({ kind: 'add', reason }, () => {
      let created = 0, merged = 0;
      const touched = [];
      for (const r of rows || []) {
        if (r.mergeInto) {
          // A kit added as "Plenty" or "Some" sets the level; a counted amount adds to the stock.
          const target = this.getPart(r.mergeInto);
          const level = levelOf(r.stockLevel);
          const p = !target ? null : level ? this.updatePart(target.id, { stockLevel: level }) : this.addStock(target.id, r.qty);
          if (p) { merged++; touched.push(p); continue; }
        }
        touched.push(this.createPart(r));
        created++;
      }
      return { created, merged, parts: touched };
    });
  }

  /** Rename or merge a category or location everywhere. */
  renameGroup(field, from, to) {
    if (!['category', 'location'].includes(field)) throw Object.assign(new Error('Unknown field.'), { status: 400 });
    const r = this.db.prepare(`UPDATE parts SET ${field} = ?, updated_at = ? WHERE ${field} = ?`).run(str(to, 80), now(), String(from ?? ''));
    return r.changes;
  }

  groups() {
    const q = field => this.db.prepare(`SELECT ${field} AS name, COUNT(*) AS parts FROM parts WHERE ${field} != '' GROUP BY ${field} ORDER BY ${field} COLLATE NOCASE`).all().map(r => ({ ...r }));
    return { categories: q('category'), locations: q('location') };
  }

  // ---------- projects ----------
  listProjects() {
    const projects = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    const parts = new Map(this.listParts().map(p => [p.id, p]));
    return projects.map(p => {
      const lines = this.linesFor(p.id);
      const { summary } = this.evaluate(p, lines, parts);
      return { ...this.rowToProject(p), summary };
    });
  }

  rowToProject(r) {
    return r && {
      id: r.id, name: r.name, notes: r.notes, builds: r.builds, status: r.status || 'planned', archived: Boolean(r.archived),
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  createProject({ name, notes = '', builds = 1, status = 'planned' }) {
    const n = str(name, 200);
    if (!n) throw Object.assign(new Error('A project needs a name.'), { status: 400 });
    const t = now();
    const st = PROJECT_STATUSES.includes(status) ? status : 'planned';
    const r = this.db.prepare('INSERT INTO projects (name, notes, builds, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(n, text(notes), Math.max(1, int(builds, 1)), st, t, t);
    return this.getProject(Number(r.lastInsertRowid));
  }

  updateProject(id, patch) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(int(id));
    if (!p) return null;
    const name = 'name' in patch ? str(patch.name, 200) : p.name;
    if (!name) throw Object.assign(new Error('A project needs a name.'), { status: 400 });
    const status = 'status' in patch && PROJECT_STATUSES.includes(patch.status) ? patch.status : p.status;
    const archived = 'archived' in patch ? (patch.archived ? 1 : 0) : p.archived;
    this.db.prepare('UPDATE projects SET name=?, notes=?, builds=?, status=?, archived=?, updated_at=? WHERE id=?').run(
      name, 'notes' in patch ? text(patch.notes) : p.notes, 'builds' in patch ? Math.max(1, Math.min(9999, int(patch.builds, 1))) : p.builds, status, archived, now(), p.id);
    return this.getProject(p.id);
  }

  touchProject(id) {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), int(id));
  }

  deleteProject(id) {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(int(id)).changes > 0;
  }

  linesFor(projectId) {
    return this.db.prepare('SELECT * FROM bom_lines WHERE project_id = ? ORDER BY position, id').all(int(projectId)).map(r => {
      let notes = [];
      try { notes = JSON.parse(r.match_notes); } catch { /* ignore */ }
      return { id: r.id, position: r.position, qty: r.qty, name: r.name, mpn: r.mpn, package: r.package, refs: r.refs, notes: r.notes, partId: r.part_id, state: r.state, score: r.score, matchNotes: notes };
    });
  }

  /**
   * Work out what each line has and still needs, sharing stock between lines that use the same part.
   */
  evaluate(project, lines, partsById) {
    const remaining = new Map();
    const out = lines.map(l => {
      const need = roundQty(l.qty * project.builds);
      const part = l.partId ? partsById.get(l.partId) : null;
      const counted = part && (l.state === 'auto' || l.state === 'confirmed');
      let have = 0, status;
      const level = counted ? part.stockLevel : null;
      if (l.state === 'skip') status = 'skip';
      else if (l.state === 'review') status = 'review';
      else if (!counted) status = 'missing';
      else if (level) {
        // Plenty and Some cover any amount; Running low means top it up.
        if (level === 'plenty' || level === 'some') { have = need; status = 'ok'; }
        else status = level === 'low' ? 'short' : 'missing';
      } else {
        if (!remaining.has(part.id)) remaining.set(part.id, part.qty);
        const left = remaining.get(part.id);
        have = Math.min(left, need);
        remaining.set(part.id, left - have);
        status = have >= need ? 'ok' : have > 0 ? 'short' : 'missing';
      }
      return { ...l, need, have, short: status === 'skip' || status === 'review' ? 0 : roundQty(need - have), status, level, part: part || null };
    });
    const count = s => out.filter(l => l.status === s).length;
    const summary = {
      lines: out.length,
      ok: count('ok'), short: count('short'), missing: count('missing'), review: count('review'), skip: count('skip'),
    };
    summary.ready = summary.lines > 0 && summary.ok + summary.skip === summary.lines;
    const settings = this.getSettings();
    if (settings.costTracking) {
      let total = 0, toBuy = 0, priced = 0;
      for (const l of out) {
        if (l.part?.cost != null) {
          priced++;
          total += l.part.cost * l.need;
          toBuy += l.part.cost * l.short;
        }
      }
      summary.cost = { total, toBuy, priced };
    }
    return { lines: out, summary };
  }

  getProject(id) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(int(id));
    if (!p) return null;
    const parts = new Map(this.listParts().map(x => [x.id, x]));
    const { lines, summary } = this.evaluate(p, this.linesFor(p.id), parts);
    const builds = this.db.prepare('SELECT id, count, created_at FROM builds WHERE project_id = ? ORDER BY id DESC LIMIT 10').all(p.id).map(b => ({ id: b.id, count: b.count, createdAt: b.created_at }));
    return { ...this.rowToProject(p), lines, summary, buildLog: builds };
  }

  /** Match one BOM item against inventory. */
  matchItem(item, parts) {
    const found = findMatches(item, parts, { limit: 4, min: 0.35, cache: this.matchCache });
    const best = found[0];
    const candidates = found.map(f => ({ id: f.part.id, score: f.score, exact: f.exact, notes: f.notes }));
    if (best?.exact) {
      // Two parts share the exact name? Use the one with more stock, but let you check.
      const twins = found.filter(f => f.exact);
      return { partId: best.part.id, state: twins.length > 1 ? 'review' : 'auto', score: 1, notes: twins.length > 1 ? ['more than one part has this name'] : [], candidates };
    }
    if (best && best.score >= MATCH_SUGGEST) return { partId: best.part.id, state: 'review', score: best.score, notes: best.notes, candidates };
    return { partId: null, state: 'none', score: best?.score ?? null, notes: [], candidates };
  }

  importBom(projectId, rows, { replace = false } = {}) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(int(projectId));
    if (!project) return null;
    const parts = this.listParts();
    return this.tx(() => {
      if (replace) this.db.prepare('DELETE FROM bom_lines WHERE project_id = ?').run(project.id);
      let pos = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM bom_lines WHERE project_id = ?').get(project.id).m + 1;
      const stmt = this.db.prepare(`INSERT INTO bom_lines (project_id, position, qty, name, mpn, package, refs, notes, part_id, state, score, match_notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const t = now();
      let added = 0;
      for (const r of rows) {
        const name = str(r.name, 200);
        if (!name) continue;
        const item = { name, mpn: str(r.mpn, 120), package: str(r.package, 60) };
        const m = this.matchItem(item, parts);
        stmt.run(project.id, pos++, lineQty(r.qty), name, item.mpn, item.package, str(r.refs, 300), text(r.notes, 1000), m.partId, m.state, m.score, JSON.stringify(m.notes), t);
        added++;
      }
      this.touchProject(project.id);
      return added;
    });
  }

  /** Re-run matching for lines that aren't settled (review / none), or all lines. */
  rematch(projectId, { all = false } = {}) {
    const parts = this.listParts();
    const lines = this.linesFor(projectId);
    const stmt = this.db.prepare('UPDATE bom_lines SET part_id = ?, state = ?, score = ?, match_notes = ? WHERE id = ?');
    let changed = 0;
    this.tx(() => {
      for (const l of lines) {
        if (!all && (l.state === 'confirmed' || l.state === 'skip' || l.state === 'auto')) continue;
        if (l.state === 'skip') continue;
        const m = this.matchItem(l, parts);
        if (m.partId !== l.partId || m.state !== l.state) changed++;
        stmt.run(m.partId, m.state, m.score, JSON.stringify(m.notes), l.id);
      }
    });
    return changed;
  }

  candidatesFor(lineId) {
    const l = this.db.prepare('SELECT * FROM bom_lines WHERE id = ?').get(int(lineId));
    if (!l) return null;
    return this.matchItem({ name: l.name, mpn: l.mpn, package: l.package }, this.listParts()).candidates;
  }

  getLine(id) {
    return this.db.prepare('SELECT * FROM bom_lines WHERE id = ?').get(int(id));
  }

  addLine(projectId, row) {
    return this.importBom(projectId, [row]);
  }

  updateLine(lineId, patch, { remember = false } = {}) {
    const l = this.getLine(lineId);
    if (!l) return null;
    const next = {
      qty: 'qty' in patch ? lineQty(patch.qty) : l.qty,
      name: 'name' in patch ? (str(patch.name, 200) || l.name) : l.name,
      mpn: 'mpn' in patch ? str(patch.mpn, 120) : l.mpn,
      package: 'package' in patch ? str(patch.package, 60) : l.package,
      refs: 'refs' in patch ? str(patch.refs, 300) : l.refs,
      notes: 'notes' in patch ? text(patch.notes, 1000) : l.notes,
      part_id: 'partId' in patch ? (patch.partId == null ? null : int(patch.partId)) : l.part_id,
      state: 'state' in patch && LINE_STATES.includes(patch.state) ? patch.state : l.state,
    };
    if ('partId' in patch && !('state' in patch)) next.state = next.part_id ? 'confirmed' : 'none';
    if (next.part_id && !this.getPart(next.part_id)) throw Object.assign(new Error('That part no longer exists.'), { status: 400 });
    if (next.state === 'none') next.part_id = null;
    const renamed = next.name !== l.name || next.mpn !== l.mpn || next.package !== l.package;
    let score = l.score, notes = l.match_notes;
    if (renamed && !('partId' in patch) && !('state' in patch)) {
      const m = this.matchItem(next, this.listParts());
      next.part_id = m.partId; next.state = m.state; score = m.score; notes = JSON.stringify(m.notes);
    }
    this.db.prepare('UPDATE bom_lines SET qty=?, name=?, mpn=?, package=?, refs=?, notes=?, part_id=?, state=?, score=?, match_notes=? WHERE id=?')
      .run(next.qty, next.name, next.mpn, next.package, next.refs, next.notes, next.part_id, next.state, score, notes, l.id);
    // Remember the BOM's wording so the next import matches on its own.
    if (remember && next.part_id && next.state === 'confirmed') {
      const part = this.getPart(next.part_id);
      if (part && compact(part.name) !== compact(next.name)) this.addAlias(part.id, next.name);
    }
    this.touchProject(l.project_id);
    return this.getLine(l.id);
  }

  deleteLine(lineId) {
    const l = this.getLine(lineId);
    if (!l) return false;
    this.db.prepare('DELETE FROM bom_lines WHERE id = ?').run(l.id);
    this.touchProject(l.project_id);
    return true;
  }

  /** Approve every suggested match in a project at once. */
  acceptAll(projectId, { remember = true } = {}) {
    const lines = this.linesFor(projectId).filter(l => l.state === 'review' && l.partId);
    this.tx(() => { for (const l of lines) this.updateLine(l.id, { partId: l.partId, state: 'confirmed' }, { remember }); });
    return lines.length;
  }

  /**
   * Take a project's parts out of inventory for N builds. Uses what's on hand; never goes below zero.
   * @returns {{build: object, changes: Array<{partId:number, name:string, delta:number}>}}
   */
  buildProject(projectId, count) {
    const project = this.getProject(projectId);
    if (!project) return null;
    const n = Math.max(1, int(count, 1));
    const use = new Map();
    for (const l of project.lines) {
      if (!l.part || l.part.stockLevel || (l.state !== 'auto' && l.state !== 'confirmed')) continue;
      use.set(l.part.id, roundQty((use.get(l.part.id) || 0) + l.qty * n));
    }
    return this.tx(() => {
      const r = this.db.prepare('INSERT INTO builds (project_id, count, changes, created_at) VALUES (?, ?, ?, ?)').run(project.id, n, '[]', now());
      const buildId = Number(r.lastInsertRowid);
      const changes = [];
      this.withAction({ batch: newBatch(), kind: 'build', reason: `Built ${project.name}${n > 1 ? ` ×${n}` : ''}`, ref: `build:${buildId}` }, () => {
        for (const [partId, amount] of use) {
          const part = this.getPart(partId);
          const take = Math.min(part.qty, amount);
          if (!take) continue;
          this.adjustQty(partId, -take);
          changes.push({ partId, name: part.name, delta: -take });
        }
      });
      this.db.prepare('UPDATE builds SET changes = ? WHERE id = ?').run(JSON.stringify(changes), buildId);
      this.touchProject(project.id);
      return { build: { id: buildId, count: n }, changes };
    });
  }

  undoBuild(buildId) {
    const b = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(int(buildId));
    if (!b) return null;
    const project = this.db.prepare('SELECT name FROM projects WHERE id = ?').get(b.project_id);
    return this.withAction({ kind: 'undo', reason: `Put back parts from building ${project?.name || 'a project'}` }, () => {
      const changes = JSON.parse(b.changes);
      for (const c of changes) this.adjustQty(c.partId, -c.delta);
      this.db.prepare('DELETE FROM builds WHERE id = ?').run(b.id);
      this.db.prepare('UPDATE part_events SET undone = 1 WHERE ref = ?').run(`build:${b.id}`);
      return changes.length;
    });
  }

  /**
   * Add what a project was short of to inventory (after an order arrives).
   * Unmatched lines become new parts and are linked to the line.
   */
  receiveShortfall(projectId, { category = '', lineIds = null } = {}, guess = () => '') {
    const project = this.getProject(projectId);
    if (!project) return null;
    const only = Array.isArray(lineIds) ? new Set(ids(lineIds)) : null;
    return this.withAction({ kind: 'receive', reason: `Received for ${project.name}` }, () => {
      let added = 0, created = 0;
      for (const l of project.lines) {
        if (l.status !== 'short' && l.status !== 'missing') continue;
        if (only && !only.has(l.id)) continue;
        if (l.part && (l.state === 'auto' || l.state === 'confirmed')) {
          this.addStock(l.part.id, l.short);
          added++;
        } else {
          const part = this.createPart({ name: l.name, qty: l.short, mpn: l.mpn, package: l.package, category: category || guess(l.name) });
          this.db.prepare(`UPDATE bom_lines SET part_id = ?, state = 'confirmed' WHERE id = ?`).run(part.id, l.id);
          created++;
        }
      }
      this.touchProject(project.id);
      return { added, created };
    });
  }

  // ---------- where parts are used ----------
  /**
   * Which projects use each part. Projects that aren't archived or done are listed;
   * planned and building ones count toward what you need.
   * @returns {Map<number, {need:number, projects:Array<{id:number,name:string,status:string,need:number}>}>}
   */
  usage() {
    const out = new Map();
    const projects = this.db.prepare(`SELECT * FROM projects WHERE archived = 0 AND status != 'done' ORDER BY name COLLATE NOCASE`).all();
    const lines = this.db.prepare(`SELECT project_id, part_id, qty FROM bom_lines WHERE part_id IS NOT NULL AND state IN ('auto', 'confirmed')`).all();
    const byProject = new Map(projects.map(p => [p.id, p]));
    for (const l of lines) {
      const p = byProject.get(l.project_id);
      if (!p) continue;
      const need = roundQty(l.qty * p.builds);
      const entry = out.get(l.part_id) || { need: 0, projects: [] };
      let pe = entry.projects.find(x => x.id === p.id);
      if (!pe) { pe = { id: p.id, name: p.name, status: p.status, need: 0 }; entry.projects.push(pe); }
      pe.need = roundQty(pe.need + need);
      if (p.status === 'planned' || p.status === 'building') entry.need = roundQty(entry.need + need);
      out.set(l.part_id, entry);
    }
    return out;
  }

  // ---------- backup ----------
  exportAll() {
    return {
      app: 'particull',
      version: 2,
      exportedAt: now(),
      settings: this.getSettings(),
      parts: this.listParts(),
      projects: this.db.prepare('SELECT * FROM projects ORDER BY id').all().map(p => ({ ...this.rowToProject(p), lines: this.linesFor(p.id) })),
    };
  }

  importAll(data) {
    if (!data || data.app !== 'particull' || !Array.isArray(data.parts)) throw Object.assign(new Error('This file is not a Particull backup.'), { status: 400 });
    return this.tx(() => {
      this.db.exec('DELETE FROM builds; DELETE FROM bom_lines; DELETE FROM projects; DELETE FROM parts; DELETE FROM part_events;');
      for (const p of data.parts) this.createPart(p, { id: p.id, logAs: null });
      const known = new Set(data.parts.map(p => p.id));
      const lineStmt = this.db.prepare(`INSERT INTO bom_lines (project_id, position, qty, name, mpn, package, refs, notes, part_id, state, score, match_notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const pr of data.projects || []) {
        const t = now();
        const r = this.db.prepare('INSERT INTO projects (id, name, notes, builds, status, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(int(pr.id), str(pr.name, 200) || 'Untitled project', text(pr.notes), Math.max(1, int(pr.builds, 1)),
            PROJECT_STATUSES.includes(pr.status) ? pr.status : 'planned', pr.archived ? 1 : 0, pr.createdAt || t, pr.updatedAt || t);
        const pid = Number(r.lastInsertRowid);
        (pr.lines || []).forEach((l, i) => {
          const partId = l.partId && known.has(l.partId) ? l.partId : null;
          const state = LINE_STATES.includes(l.state) ? (partId || l.state === 'skip' || l.state === 'none' ? l.state : 'none') : 'none';
          lineStmt.run(pid, i, lineQty(l.qty), str(l.name, 200) || 'Unnamed', str(l.mpn, 120), str(l.package, 60), str(l.refs, 300), text(l.notes, 1000), partId, state, l.score ?? null, JSON.stringify(l.matchNotes || []), t);
        });
      }
      if (data.settings) this.updateSettings(data.settings);
      this.matchCache.clear();
      return { parts: data.parts.length, projects: (data.projects || []).length };
    });
  }
}

/** A short description of one action, for undo messages: "10k resistor 48 → 50", "Built Dingr ×2". */
export function describeBatch(events) {
  const e = events[0];
  if (!e) return 'Nothing';
  if (events.some(x => x.kind === 'merge')) return 'Merging parts';
  if (e.kind === 'build' || e.kind === 'receive' || (e.reason && events.length > 1)) return e.reason || `${events.length} changes`;
  if (events.length > 1) return `${events.length} changes`;
  if (e.kind === 'create') return `adding ${e.partName}`;
  if (e.kind === 'delete') return `deleting ${e.partName}`;
  if (e.kind === 'merge') return 'Merging parts';
  const fields = Object.keys(e.changes);
  if (fields.length === 1 && fields[0] === 'qty') {
    const [a, b] = e.changes.qty;
    return `${e.partName} ${a} → ${b}`;
  }
  if (fields.length === 1 && fields[0] === 'stockLevel') return `${e.partName}: amount changed`;
  return `changes to ${e.partName}`;
}
