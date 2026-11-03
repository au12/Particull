// SQLite storage for parts, projects and BOM lines (node:sqlite, no npm packages).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { findMatches, MATCH_SUGGEST, compact } from './public/shared/match.js';

export const DEFAULT_SETTINGS = {
  costTracking: false,
  currency: '$',
  theme: 'system',
  exportIncludeLocations: false,
  exportIncludeNotes: true,
  exportIncludeEmpty: false,
};

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
];

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
const optInt = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
const optNum = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));

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

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
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
      minQty: r.min_qty, cost: r.cost, createdAt: r.created_at, updatedAt: r.updated_at,
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
      qty: Math.max(0, int(p.qty ?? existing.qty ?? 0)),
      category: str(p.category ?? existing.category ?? '', 80),
      location: str(p.location ?? existing.location ?? '', 80),
      mpn: str(p.mpn ?? existing.mpn ?? '', 120),
      package: str(p.package ?? existing.package ?? '', 60),
      notes: text(p.notes ?? existing.notes ?? '', 2000),
      link: str(p.link ?? existing.link ?? '', 1000),
      aliases: cleanAliases(p.aliases ?? existing.aliases ?? [], name),
      minQty: 'minQty' in p ? optInt(p.minQty) : (existing.minQty ?? null),
      cost: 'cost' in p ? optNum(p.cost) : (existing.cost ?? null),
    };
  }

  createPart(input, { id } = {}) {
    const p = this.normalizePart(input);
    const t = now();
    const sql = `INSERT INTO parts (${id ? 'id, ' : ''}name, qty, category, location, mpn, package, notes, link, aliases, min_qty, cost, created_at, updated_at)
      VALUES (${id ? '?, ' : ''}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const args = [p.name, p.qty, p.category, p.location, p.mpn, p.package, p.notes, p.link, JSON.stringify(p.aliases), p.minQty, p.cost, input.createdAt || t, t];
    const r = this.db.prepare(sql).run(...(id ? [int(id), ...args] : args));
    this.matchCache.clear();
    return this.getPart(Number(r.lastInsertRowid));
  }

  updatePart(id, patch) {
    const existing = this.getPart(id);
    if (!existing) return null;
    const p = this.normalizePart(patch, existing);
    this.db.prepare(`UPDATE parts SET name=?, qty=?, category=?, location=?, mpn=?, package=?, notes=?, link=?, aliases=?, min_qty=?, cost=?, updated_at=? WHERE id=?`)
      .run(p.name, p.qty, p.category, p.location, p.mpn, p.package, p.notes, p.link, JSON.stringify(p.aliases), p.minQty, p.cost, now(), existing.id);
    this.matchCache.clear();
    return this.getPart(existing.id);
  }

  adjustQty(id, delta) {
    const r = this.db.prepare('UPDATE parts SET qty = MAX(0, qty + ?), updated_at = ? WHERE id = ?').run(int(delta), now(), int(id));
    return r.changes ? this.getPart(id) : null;
  }

  linesUsingPart(id) {
    return this.db.prepare('SELECT id FROM bom_lines WHERE part_id = ?').all(int(id)).map(r => r.id);
  }

  deletePart(id) {
    const part = this.getPart(id);
    if (!part) return null;
    this.db.prepare(`UPDATE bom_lines SET state = 'none', score = NULL, match_notes = '[]' WHERE part_id = ?`).run(part.id);
    this.db.prepare('DELETE FROM parts WHERE id = ?').run(part.id);
    this.matchCache.clear();
    return part;
  }

  /** Restore a deleted part with its id, then re-link BOM lines that pointed at it. */
  restorePart(part, lineIds = []) {
    return this.tx(() => {
      const restored = this.createPart(part, { id: part.id });
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
  bulkAdd(rows) {
    return this.tx(() => {
      let created = 0, merged = 0;
      const touched = [];
      for (const r of rows || []) {
        if (r.mergeInto) {
          const p = this.adjustQty(r.mergeInto, Math.max(0, int(r.qty)));
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
    const q = field => this.db.prepare(`SELECT ${field} AS name, COUNT(*) AS parts, SUM(qty) AS pieces FROM parts WHERE ${field} != '' GROUP BY ${field} ORDER BY ${field} COLLATE NOCASE`).all().map(r => ({ ...r }));
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
    return r && { id: r.id, name: r.name, notes: r.notes, builds: r.builds, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  createProject({ name, notes = '', builds = 1 }) {
    const n = str(name, 200);
    if (!n) throw Object.assign(new Error('A project needs a name.'), { status: 400 });
    const t = now();
    const r = this.db.prepare('INSERT INTO projects (name, notes, builds, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(n, text(notes), Math.max(1, int(builds, 1)), t, t);
    return this.getProject(Number(r.lastInsertRowid));
  }

  updateProject(id, patch) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(int(id));
    if (!p) return null;
    const name = 'name' in patch ? str(patch.name, 200) : p.name;
    if (!name) throw Object.assign(new Error('A project needs a name.'), { status: 400 });
    this.db.prepare('UPDATE projects SET name=?, notes=?, builds=?, updated_at=? WHERE id=?').run(
      name, 'notes' in patch ? text(patch.notes) : p.notes, 'builds' in patch ? Math.max(1, Math.min(9999, int(patch.builds, 1))) : p.builds, now(), p.id);
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
      const need = l.qty * project.builds;
      const part = l.partId ? partsById.get(l.partId) : null;
      const counted = part && (l.state === 'auto' || l.state === 'confirmed');
      let have = 0, status;
      if (l.state === 'skip') status = 'skip';
      else if (l.state === 'review') status = 'review';
      else if (!counted) status = 'missing';
      else {
        if (!remaining.has(part.id)) remaining.set(part.id, part.qty);
        const left = remaining.get(part.id);
        have = Math.min(left, need);
        remaining.set(part.id, left - have);
        status = have >= need ? 'ok' : have > 0 ? 'short' : 'missing';
      }
      return { ...l, need, have, short: status === 'skip' || status === 'review' ? 0 : need - have, status, part: part || null };
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
        stmt.run(project.id, pos++, Math.max(1, int(r.qty, 1)), name, item.mpn, item.package, str(r.refs, 300), text(r.notes, 1000), m.partId, m.state, m.score, JSON.stringify(m.notes), t);
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
      qty: 'qty' in patch ? Math.max(1, int(patch.qty, 1)) : l.qty,
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
      if (!l.part || (l.state !== 'auto' && l.state !== 'confirmed')) continue;
      use.set(l.part.id, (use.get(l.part.id) || 0) + l.qty * n);
    }
    return this.tx(() => {
      const changes = [];
      for (const [partId, amount] of use) {
        const part = this.getPart(partId);
        const take = Math.min(part.qty, amount);
        if (!take) continue;
        this.adjustQty(partId, -take);
        changes.push({ partId, name: part.name, delta: -take });
      }
      const r = this.db.prepare('INSERT INTO builds (project_id, count, changes, created_at) VALUES (?, ?, ?, ?)').run(project.id, n, JSON.stringify(changes), now());
      this.touchProject(project.id);
      return { build: { id: Number(r.lastInsertRowid), count: n }, changes };
    });
  }

  undoBuild(buildId) {
    const b = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(int(buildId));
    if (!b) return null;
    return this.tx(() => {
      const changes = JSON.parse(b.changes);
      for (const c of changes) this.adjustQty(c.partId, -c.delta);
      this.db.prepare('DELETE FROM builds WHERE id = ?').run(b.id);
      return changes.length;
    });
  }

  /**
   * Add what a project was short of to inventory (after an order arrives).
   * Unmatched lines become new parts and are linked to the line.
   */
  receiveShortfall(projectId, { category = '' } = {}, guess = () => '') {
    const project = this.getProject(projectId);
    if (!project) return null;
    return this.tx(() => {
      let added = 0, created = 0;
      for (const l of project.lines) {
        if (l.status !== 'short' && l.status !== 'missing') continue;
        if (l.part && (l.state === 'auto' || l.state === 'confirmed')) {
          this.adjustQty(l.part.id, l.short);
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

  // ---------- backup ----------
  exportAll() {
    return {
      app: 'particull',
      version: 1,
      exportedAt: now(),
      settings: this.getSettings(),
      parts: this.listParts(),
      projects: this.db.prepare('SELECT * FROM projects ORDER BY id').all().map(p => ({ ...this.rowToProject(p), lines: this.linesFor(p.id) })),
    };
  }

  importAll(data) {
    if (!data || data.app !== 'particull' || !Array.isArray(data.parts)) throw Object.assign(new Error('This file is not a Particull backup.'), { status: 400 });
    return this.tx(() => {
      this.db.exec('DELETE FROM builds; DELETE FROM bom_lines; DELETE FROM projects; DELETE FROM parts;');
      for (const p of data.parts) this.createPart(p, { id: p.id });
      const known = new Set(data.parts.map(p => p.id));
      const lineStmt = this.db.prepare(`INSERT INTO bom_lines (project_id, position, qty, name, mpn, package, refs, notes, part_id, state, score, match_notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const pr of data.projects || []) {
        const t = now();
        const r = this.db.prepare('INSERT INTO projects (id, name, notes, builds, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(int(pr.id), str(pr.name, 200) || 'Untitled project', text(pr.notes), Math.max(1, int(pr.builds, 1)), pr.createdAt || t, pr.updatedAt || t);
        const pid = Number(r.lastInsertRowid);
        (pr.lines || []).forEach((l, i) => {
          const partId = l.partId && known.has(l.partId) ? l.partId : null;
          const state = LINE_STATES.includes(l.state) ? (partId || l.state === 'skip' || l.state === 'none' ? l.state : 'none') : 'none';
          lineStmt.run(pid, i, Math.max(1, int(l.qty, 1)), str(l.name, 200) || 'Unnamed', str(l.mpn, 120), str(l.package, 60), str(l.refs, 300), text(l.notes, 1000), partId, state, l.score ?? null, JSON.stringify(l.matchNotes || []), t);
        });
      }
      if (data.settings) this.updateSettings(data.settings);
      this.matchCache.clear();
      return { parts: data.parts.length, projects: (data.projects || []).length };
    });
  }
}
