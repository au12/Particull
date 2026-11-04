import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../db.js';
import { Backups, lastSlot } from '../backup.js';
import { exportInventory, shoppingList } from '../export.js';
import { kitRows, KITS } from '../public/shared/kits.js';
import { describeValues, formatOhms, formatFarads, seriesValues } from '../public/shared/values.js';
import { formatStock, isLow } from '../public/shared/stock.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'particull-test-'));

test('rough stock levels count in BOM checks', () => {
  const s = new Store(':memory:');
  s.bulkAdd([
    { name: '10k resistor', package: '0805', stockLevel: 'plenty' },
    { name: '100nF ceramic capacitor', package: '0805', stockLevel: 'some' },
    { name: 'Solder', stockLevel: 'low' },
    { name: 'Flux pen', stockLevel: 'out' },
  ]);
  const p = s.createProject({ name: 'P', builds: 10 });
  s.importBom(p.id, [{ name: '10k resistor', package: '0805', qty: 40 }, { name: '100nF ceramic capacitor', package: '0805', qty: 8 }, { name: 'Solder', qty: 1 }, { name: 'Flux pen', qty: 1 }]);
  const lines = s.getProject(p.id).lines;
  assert.deepEqual(lines.map(l => [l.status, l.level]), [['ok', 'plenty'], ['ok', 'some'], ['short', 'low'], ['missing', 'out']]);
  // Building leaves level-tracked parts alone; receiving tops them up to Plenty.
  s.buildProject(p.id, 1);
  assert.equal(s.listParts().find(x => x.name === '10k resistor').stockLevel, 'plenty');
  s.receiveShortfall(p.id);
  assert.equal(s.listParts().find(x => x.name === 'Solder').stockLevel, 'plenty');
  assert.match(shoppingList({ name: 'P', builds: 1, lines: [{ status: 'short', level: 'low', short: 1, have: 0, need: 1, name: 'Solder', mpn: '', package: '', part: { unit: '' } }] }), /running low, top up/);
});

test('units and fractional amounts', () => {
  const s = new Store(':memory:');
  const wire = s.createPart({ name: '26 AWG wire', qty: 2.5, unit: 'm' });
  assert.equal(wire.qty, 2.5);
  assert.equal(formatStock(wire), '2.5 m');
  assert.equal(formatStock({ qty: 6, unit: 'spool' }), '6 spools');
  assert.equal(s.adjustQty(wire.id, 0.1).qty, 2.6);
  const p = s.createProject({ name: 'Harness' });
  s.importBom(p.id, [{ name: '26 AWG wire', qty: 0.75 }]);
  const line = s.getProject(p.id).lines[0];
  assert.equal(line.qty, 0.75);
  assert.equal(line.status, 'ok');
  assert.equal(s.createPart({ name: 'x', unit: 'pcs' }).unit, '');
  assert.equal(isLow({ qty: 1, minQty: 1 }), true);
  assert.equal(isLow({ stockLevel: 'some' }), false);
});

test('merging parts keeps names, adds amounts and moves BOM lines', () => {
  const s = new Store(':memory:');
  const a = s.createPart({ name: '10k resistor', qty: 50, package: '0805' });
  const b = s.createPart({ name: '10K ohm res', qty: 20, location: 'Drawer A1', aliases: ['R10k'] });
  const p = s.createProject({ name: 'P' });
  s.importBom(p.id, [{ name: '10K ohm res', qty: 4 }]);
  assert.equal(s.getProject(p.id).lines[0].partId, b.id);
  const { part } = s.mergeParts(a.id, [b.id]);
  assert.equal(part.qty, 70);
  assert.equal(part.location, 'Drawer A1');
  assert.deepEqual(part.aliases, ['10K ohm res', 'R10k']);
  assert.equal(s.getProject(p.id).lines[0].partId, a.id);
  assert.equal(s.listParts().length, 1);
  // A level beats a count.
  const c = s.createPart({ name: '10k resistor 0805 kit', stockLevel: 'plenty' });
  assert.equal(s.mergeParts(a.id, [c.id]).part.stockLevel, 'plenty');
  assert.throws(() => s.mergeParts(a.id, [a.id]), /at least two/);
});

test('bulk update, bulk delete and undo', () => {
  const s = new Store(':memory:');
  const ids = s.bulkAdd([{ name: 'A', qty: 1 }, { name: 'B', qty: 2 }, { name: 'C', qty: 3 }]).parts.map(p => p.id);
  const p = s.createProject({ name: 'P' });
  s.importBom(p.id, [{ name: 'B', qty: 1 }]);
  assert.equal(s.bulkUpdate(ids, { location: 'Drawer Z', category: 'Misc' }).length, 3);
  assert.ok(s.listParts().every(x => x.location === 'Drawer Z' && x.category === 'Misc'));
  s.bulkUpdate(ids.slice(0, 2), { stockLevel: 'plenty' });
  assert.equal(s.listParts().filter(x => x.stockLevel === 'plenty').length, 2);
  assert.throws(() => s.bulkUpdate(ids, { name: 'nope' }), /Nothing to change/);
  const removed = s.bulkDelete(ids.slice(0, 2));
  assert.equal(s.listParts().length, 1);
  assert.equal(s.getProject(p.id).lines[0].status, 'missing');
  s.restoreMany(removed);
  assert.equal(s.listParts().length, 3);
  assert.equal(s.getProject(p.id).lines[0].status, 'ok');
});

test('a kit added as Plenty sets the level on a part you already have', () => {
  const s = new Store(':memory:');
  const r = s.createPart({ name: '10k resistor', qty: 12 });
  s.bulkAdd([{ name: '10k resistor', mergeInto: r.id, stockLevel: 'plenty', qty: 0 }]);
  assert.equal(s.getPart(r.id).stockLevel, 'plenty');
  const led = s.createPart({ name: '5mm red LED', qty: 10 });
  s.bulkAdd([{ name: '5mm red LED', mergeInto: led.id, qty: 20 }]);
  assert.equal(s.getPart(led.id).qty, 30);
});

test('project status and archiving', () => {
  const s = new Store(':memory:');
  const p = s.createProject({ name: 'P', status: 'idea' });
  assert.equal(p.status, 'idea');
  assert.equal(p.archived, false);
  assert.equal(s.updateProject(p.id, { status: 'building' }).status, 'building');
  assert.equal(s.updateProject(p.id, { status: 'bogus' }).status, 'building');
  assert.equal(s.updateProject(p.id, { archived: true }).archived, true);
  assert.equal(s.createProject({ name: 'Q' }).status, 'planned');
});

test('a v0.1 database upgrades in place', () => {
  const dir = tmp();
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE parts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', mpn TEXT NOT NULL DEFAULT '', package TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', aliases TEXT NOT NULL DEFAULT '[]', min_qty INTEGER, cost REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX parts_category ON parts(category);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', builds INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE bom_lines (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0, qty INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, mpn TEXT NOT NULL DEFAULT '', package TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL, state TEXT NOT NULL DEFAULT 'none', score REAL, match_notes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE builds (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, count INTEGER NOT NULL, changes TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO parts (name, qty, created_at, updated_at) VALUES ('Teensy 4.1', 1, 'x', 'x');
    INSERT INTO projects (name, created_at, updated_at) VALUES ('iPod', 'x', 'x');
    PRAGMA user_version = 1;`);
  old.close();
  const s = new Store(file);
  const part = s.listParts()[0];
  assert.equal(part.stockLevel, null);
  assert.equal(part.unit, '');
  assert.equal(s.listProjects()[0].status, 'planned');
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backups: create, list, prune, validate, schedule', () => {
  const dir = tmp();
  const store = new Store(path.join(dir, 'particull.db'));
  store.createPart({ name: 'Teensy 4.1', qty: 1 });
  const b = new Backups(path.join(dir, 'backups'), () => store);
  const made = b.create('manual');
  assert.equal(made.kind, 'manual');
  assert.deepEqual(Backups.validate(path.join(b.dir, made.name)), { parts: 1, projects: 0 });
  for (let i = 0; i < 4; i++) b.create('auto');
  b.prune(2);
  const kinds = b.list().map(x => x.kind);
  assert.equal(kinds.filter(k => k === 'auto').length, 2);
  assert.equal(kinds.filter(k => k === 'manual').length, 1);
  assert.throws(() => b.pathFor('../particull.db'), /No such backup/);
  fs.writeFileSync(path.join(dir, 'junk.db'), 'not a database');
  assert.throws(() => Backups.validate(path.join(dir, 'junk.db')), /not a Particull database/);

  // Scheduling: the latest slot at or before now.
  const at = new Date(2026, 10, 4, 2, 0); // Wed 4 Nov, 02:00
  assert.equal(lastSlot('daily', 3, at).getDate(), 3);
  assert.equal(lastSlot('daily', 1, at).getDate(), 4);
  assert.equal(lastSlot('weekly', 3, at).getDay(), 0);
  assert.equal(lastSlot('off', 3, at), null);
  store.updateSettings({ backupFrequency: 'off' });
  assert.equal(b.tick(), null);
  store.updateSettings({ backupFrequency: 'daily', backupKeep: 0, backupHour: 99 });
  assert.equal(store.getSettings().backupKeep, 1);
  assert.equal(store.getSettings().backupHour, 23);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('values and series', () => {
  assert.equal(seriesValues('E12', 10, 100).length, 13);
  assert.equal(formatOhms(4700), '4.7k');
  assert.equal(formatOhms(1e6), '1M');
  assert.equal(formatOhms(47), '47Ω');
  assert.equal(formatFarads(100000), '100nF');
  assert.equal(formatFarads(22), '22pF');
  assert.equal(formatFarads(4.7e6), '4.7µF');
  const e12 = seriesValues('E12', 10, 1e6);
  assert.equal(describeValues(e12, formatOhms), 'E12 series 10Ω–1M (61 values)');
  assert.equal(describeValues(e12.filter(v => v !== 27), formatOhms), 'E12 series 10Ω–1M (60 values, except 27Ω)');
  assert.equal(describeValues([...e12, 5100], formatOhms), 'E12 series 10Ω–1M (61 values), plus 5.1k');
  assert.equal(describeValues([10, 100, 1000], formatOhms), '10Ω, 100Ω, 1k');
});

test('kits', () => {
  assert.equal(kitRows('resistors', KITS.resistors.defaults).length, 61);
  assert.equal(kitRows('resistors', { ...KITS.resistors.defaults, series: 'E6', min: 1000, max: 1e4 })[0].name, '1k resistor');
  assert.equal(kitRows('ceramic', KITS.ceramic.defaults)[0].name, '10pF ceramic capacitor');
  assert.deepEqual(kitRows('connectors', { family: 'JST-XH', minPins: 2, maxPins: 3, housings: true, headers: true, crimps: true }).map(r => r.name),
    ['JST-XH 2-pin housing', 'JST-XH 2-pin PCB header', 'JST-XH 3-pin housing', 'JST-XH 3-pin PCB header', 'JST-XH crimp terminal']);
  assert.deepEqual(kitRows('hardware', { sizes: ['M3'], lengths: '6, 10', kind: 'socket head screw', nuts: true }).map(r => r.name),
    ['M3 × 6mm socket head screw', 'M3 × 10mm socket head screw', 'M3 hex nut']);
  assert.equal(kitRows('leds', { sizes: ['3mm', '5mm'], colors: ['red', 'green'] }).length, 4);
});

test('compact export collapses resistor runs and keeps everything else', () => {
  const parts = seriesValues('E12', 10, 1e6).map((v, i) => ({ id: i + 1, name: `${formatOhms(v)} resistor`, package: '0805', stockLevel: 'plenty', qty: 0, unit: '', category: 'Resistors', notes: '', mpn: '', location: '' }));
  parts.push({ id: 900, name: '22pF ceramic capacitor', package: '0603', qty: 30, unit: '', category: 'Capacitors', notes: '', mpn: '', location: '' });
  parts.push({ id: 901, name: 'Teensy 4.1', qty: 1, unit: '', category: 'Microcontrollers', notes: '', mpn: '', location: '' });
  parts.push({ id: 902, name: '26 AWG wire', qty: 2.5, unit: 'm', category: 'Wire', notes: '', mpn: '', location: '' });
  const md = exportInventory(parts, { format: 'md', compact: true, notes: true, locations: false, empty: false, cost: false, currency: '$' });
  assert.match(md, /- Resistors, 0805: E12 series 10Ω–1M \(61 values\); plenty of each/);
  assert.match(md, /- 30 × 22pF ceramic capacitor \(0603\)/);
  assert.match(md, /- 2\.5 m of 26 AWG wire/);
  assert.equal(md.split('\n').filter(l => l.startsWith('- ')).length, 4);
  const full = exportInventory(parts, { format: 'md', compact: false, notes: true, locations: false, empty: false, cost: false, currency: '$' });
  assert.match(full, /- 4\.7k resistor \(0805\): plenty/);
  const csv = exportInventory(parts, { format: 'csv', notes: false, locations: false, empty: false, cost: false, currency: '$' });
  assert.match(csv, /Plenty,,10Ω resistor/);
  assert.match(csv, /2\.5,m,26 AWG wire/);
});
