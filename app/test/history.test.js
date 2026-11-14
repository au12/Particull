import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, describeBatch } from '../db.js';

const kinds = s => s.db.prepare('SELECT kind FROM part_events ORDER BY id').all().map(r => r.kind);

test('every change to a part is logged with what changed', () => {
  const s = new Store(':memory:');
  const p = s.createPart({ name: '10k resistor', qty: 50 });
  s.updatePart(p.id, { qty: 48, location: 'Drawer A1' });
  s.adjustQty(p.id, 2);
  s.updatePart(p.id, { qty: 50 }); // no change, nothing logged
  const h = s.partHistory(p.id);
  assert.equal(h.length, 3);
  assert.deepEqual(h[0].changes, { qty: [48, 50] });
  assert.deepEqual(h[1].changes, { qty: [50, 48], location: ['', 'Drawer A1'] });
  assert.equal(h[2].kind, 'create');
});

test('undo reverses the last change, then the one before', () => {
  const s = new Store(':memory:');
  const p = s.createPart({ name: '10k resistor', qty: 50 });
  s.updatePart(p.id, { qty: 48 });
  s.updatePart(p.id, { location: 'Bin 2' });
  assert.equal(s.undoLast().summary, 'changes to 10k resistor');
  assert.equal(s.getPart(p.id).location, '');
  assert.equal(s.undoLast().summary, '10k resistor 50 → 48');
  assert.equal(s.getPart(p.id).qty, 50);
  // Undoing the creation removes the part; then there is nothing left to undo.
  s.undoLast();
  assert.equal(s.getPart(p.id), null);
  assert.throws(() => s.undoLast(), /nothing to undo/);
});

test('one action is one undo: bulk changes, kits and deletes', () => {
  const s = new Store(':memory:');
  const ids = s.bulkAdd([{ name: 'A', qty: 1 }, { name: 'B', qty: 2 }, { name: 'C', qty: 3 }]).parts.map(p => p.id);
  s.bulkUpdate(ids, { location: 'Drawer Z' });
  assert.equal(s.lastChange().summary, 'Changed 3 parts');
  s.undoLast();
  assert.ok(s.listParts().every(p => p.location === ''));

  s.bulkDelete(ids.slice(0, 2));
  assert.equal(s.listParts().length, 1);
  s.undoLast();
  assert.equal(s.listParts().length, 3);

  // A kit that adds to one part and creates another: one undo takes back both.
  const a = s.listParts().find(p => p.name === 'A');
  s.bulkAdd([{ name: 'A', mergeInto: a.id, qty: 10 }, { name: 'D', qty: 5 }], { source: 'kit' });
  assert.equal(s.getPart(a.id).qty, 11);
  assert.equal(s.lastChange().summary, 'Added from a kit');
  s.undoLast();
  assert.equal(s.getPart(a.id).qty, 1);
  assert.equal(s.listParts().find(p => p.name === 'D'), undefined);
});

test('builds undo through the build, and merges are not undoable', () => {
  const s = new Store(':memory:');
  const esp = s.createPart({ name: 'ESP32-S3 dev board', qty: 3 });
  const pr = s.createProject({ name: 'Dingr', builds: 1 });
  s.importBom(pr.id, [{ name: 'ESP32-S3 dev board', qty: 1 }]);
  const b = s.buildProject(pr.id, 2);
  assert.equal(s.getPart(esp.id).qty, 1);
  assert.equal(s.lastChange().summary, 'Built Dingr ×2');
  s.undoLast();
  assert.equal(s.getPart(esp.id).qty, 3);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM builds WHERE id = ?').get(b.build.id).n, 0);

  // "Put parts back" from the build log marks the build's changes as undone too.
  const b2 = s.buildProject(pr.id, 1);
  s.undoBuild(b2.build.id);
  assert.equal(s.getPart(esp.id).qty, 3);
  assert.notEqual(s.lastChange()?.summary, 'Built Dingr');

  const dup = s.createPart({ name: 'ESP32-S3 devboard', qty: 1 });
  s.mergeParts(esp.id, [dup.id]);
  assert.equal(s.lastChange().undoable, false);
  assert.throws(() => s.undoLast(), /Merging parts can’t be undone/);
  assert.ok(kinds(s).includes('merge'));
});

test('receiving only the ticked lines, as one undo', () => {
  const s = new Store(':memory:');
  s.createPart({ name: 'ESP32-S3 dev board', qty: 0 });
  const pr = s.createProject({ name: 'Dingr' });
  s.importBom(pr.id, [{ name: 'ESP32-S3 dev board', qty: 2 }, { name: 'Piezo buzzer', qty: 1 }, { name: 'Speaker', qty: 1 }]);
  const lines = s.getProject(pr.id).lines;
  const r = s.receiveShortfall(pr.id, { lineIds: [lines[0].id, lines[1].id] });
  assert.deepEqual(r, { added: 1, created: 1 });
  const after = s.getProject(pr.id).lines;
  assert.deepEqual(after.map(l => l.status), ['ok', 'ok', 'missing']);
  assert.equal(s.lastChange().summary, 'Received for Dingr');
  s.undoLast();
  assert.deepEqual(s.getProject(pr.id).lines.map(l => l.status), ['missing', 'missing', 'missing']);
  assert.equal(s.listParts().length, 1);
});

test('where parts are used and what active projects need', () => {
  const s = new Store(':memory:');
  const esp = s.createPart({ name: 'ESP32-S3 dev board', qty: 3 });
  const a = s.createProject({ name: 'Dingr', builds: 2, status: 'building' });
  const b = s.createProject({ name: 'Patio lights', status: 'idea' });
  const c = s.createProject({ name: 'Old thing', status: 'done' });
  for (const p of [a, b, c]) s.importBom(p.id, [{ name: 'ESP32-S3 dev board', qty: 1 }]);
  s.importBom(a.id, [{ name: 'ESP32-S3 dev board', qty: 1 }]);
  const u = s.usage().get(esp.id);
  assert.equal(u.need, 4); // Dingr: 2 lines × 2 builds; ideas don't count, done projects aren't listed
  assert.deepEqual(u.projects.map(p => [p.name, p.status, p.need]), [['Dingr', 'building', 4], ['Patio lights', 'idea', 1]]);
  s.updateProject(a.id, { archived: true });
  assert.equal(s.usage().get(esp.id).need, 0);
});

test('describing changes for undo messages', () => {
  const ev = (kind, changes = {}, extra = {}) => ({ kind, changes, partName: '10k resistor', reason: '', ...extra });
  assert.equal(describeBatch([ev('edit', { qty: [1, 2] })]), '10k resistor 1 → 2');
  assert.equal(describeBatch([ev('create')]), 'adding 10k resistor');
  assert.equal(describeBatch([ev('delete')]), 'deleting 10k resistor');
  assert.equal(describeBatch([ev('build', { qty: [3, 1] }, { reason: 'Built Dingr' })]), 'Built Dingr');
});
