import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseParts, parseLine } from '../public/shared/parse.js';
import { findMatches, analyze, compare, guessCategory } from '../public/shared/match.js';
import { Store } from '../db.js';
import { exportInventory, shoppingList } from '../export.js';

test('plain list lines pick up quantities in common shapes', () => {
  const cases = [
    ['10x 10k resistor 0805', 10, '10k resistor 0805'],
    ['10 x 10k resistor', 10, '10k resistor'],
    ['ESP32-S3 dev board ×2', 2, 'ESP32-S3 dev board'],
    ['ESP32-S3 dev board x2', 2, 'ESP32-S3 dev board'],
    ['SSD1306 OLED, 3', 3, 'SSD1306 OLED'],
    ['M3 screws (x50)', 50, 'M3 screws'],
    ['5 pcs AMS1117-3.3', 5, 'AMS1117-3.3'],
    ['3 ESP32 boards', 3, 'ESP32 boards'],
    ['555 timer', 1, '555 timer'],
    ['Resistor 10k, 0805', 1, 'Resistor 10k, 0805'],
    ['Pin header 1x40', 1, 'Pin header 1x40'],
    ['- [ ] 2x WS2812B', 2, 'WS2812B'],
    ['1. 4 AA battery holder', 4, 'AA battery holder'],
  ];
  for (const [line, qty, name] of cases) {
    const r = parseLine(line);
    assert.equal(r.qty, qty, line);
    assert.equal(r.name, name, line);
  }
});

test('markdown tables, including inch marks and prose around them', () => {
  const r = parseParts(`Here is the BOM:

| Qty | Part | Part number | Package | Notes |
| --- | --- | --- | --- | --- |
| 1 | 1.69" ST7789 display | | | 240x280 |
| 6 | 10K ohm res | | 0805 | pull-ups |
| **Total** | | | | |

Let me know.`);
  assert.equal(r.format, 'markdown table');
  assert.equal(r.rows.length, 2);
  assert.deepEqual([r.rows[1].qty, r.rows[1].name, r.rows[1].package, r.rows[1].notes], [6, '10K ohm res', '0805', 'pull-ups']);
});

test('KiCad CSV exports become readable part names', () => {
  const r = parseParts('"Reference","Value","Footprint","Datasheet","Qty"\n"R1,R2,R3","10k","Resistor_SMD:R_0805_2012Metric","~","3"\n"C1","100n","Capacitor_SMD:C_0603_1608Metric","~","1"');
  assert.equal(r.format, 'CSV');
  assert.deepEqual(r.rows.map(x => [x.qty, x.name, x.package, x.refs]), [[3, '10k resistor', '0805', 'R1,R2,R3'], [1, '100n capacitor', '0603', 'C1']]);
});

test('headings set the category for the lines below', () => {
  const r = parseParts('## Passives\n- 10x 10k resistor\n## Hardware\n- 50x M3 screw');
  assert.deepEqual(r.rows.map(x => x.category), ['Passives', 'Hardware']);
});

test('values are normalized across notations', () => {
  assert.equal(analyze('4k7 resistor').values.get('res'), 'res:4700');
  assert.equal(analyze('4.7K ohm').values.get('res'), 'res:4700');
  assert.equal(analyze('0.1uF cap').values.get('cap'), analyze('100nF capacitor').values.get('cap'));
  assert.equal(analyze('3v3 regulator').values.get('v'), 'v:3.3');
  assert.equal(analyze('AMS1117-3.3 LDO').values.get('v'), 'v:3.3');
});

const inventory = [
  { id: 1, name: '10k resistor', package: '0805', qty: 50 },
  { id: 2, name: '4.7k resistor', package: '0805', qty: 20 },
  { id: 3, name: '100nF ceramic capacitor', package: '0805', qty: 100 },
  { id: 4, name: 'ESP32-S3-DevKitC-1 N16R8', qty: 2 },
  { id: 5, name: '10k potentiometer', qty: 3 },
  { id: 6, name: 'AMS1117-3.3 regulator', package: 'SOT-223', qty: 5 },
  { id: 7, name: 'AMS1117-5.0 regulator', qty: 5 },
  { id: 8, name: '6x6mm tactile button', qty: 40, aliases: ['tact switch 6mm'] },
];
const best = (q, extra = {}) => findMatches({ name: q, ...extra }, inventory)[0];

test('finds the same part under a different name', () => {
  assert.equal(best('10K ohm res').part.id, 1);
  assert.equal(best('R 10k', { package: '0805' }).part.id, 1);
  assert.equal(best('0.1uF cap').part.id, 3);
  assert.equal(best('ESP32-S3 dev board').part.id, 4);
  assert.equal(best('3.3V LDO AMS1117').part.id, 6);
  assert.equal(best('AMS1117 5V').part.id, 7);
  assert.equal(best('10k pot').part.id, 5);
});

test('never suggests a part with a different value or type', () => {
  for (const m of findMatches({ name: '22k resistor' }, inventory)) assert.notEqual(m.part.id, 1);
  assert.ok(!findMatches({ name: '10k resistor' }, inventory).some(m => m.part.id === 5));
  assert.ok(!findMatches({ name: '3.3V regulator AMS1117' }, inventory).some(m => m.part.id === 7 && m.score >= 0.5));
});

test('aliases give exact matches', () => {
  const m = best('Tact switch 6mm');
  assert.equal(m.part.id, 8);
  assert.equal(m.exact, true);
});

test('package mismatches are flagged, not hidden', () => {
  const r = compare(analyze('10k resistor', { package: '0603' }), analyze('10k resistor', { package: '0805' }));
  assert.ok(r.notes.includes('different package'));
});

test('category guesses', () => {
  assert.equal(guessCategory('ESP32-S3 dev board'), 'Microcontrollers');
  assert.equal(guessCategory('10k resistor'), 'Resistors');
  assert.equal(guessCategory('100nF cap'), 'Capacitors');
  assert.equal(guessCategory('SSD1306 OLED'), 'Displays');
});

test('store: BOM import, review, remember, shortfall and builds', () => {
  const s = new Store(':memory:');
  s.bulkAdd([
    { name: '10k resistor 0805', qty: 10, category: 'Resistors' },
    { name: 'ESP32-S3-DevKitC-1', qty: 1 },
  ]);
  const p = s.createProject({ name: 'Test', builds: 1 });
  s.importBom(p.id, parseParts('| Qty | Part |\n|---|---|\n| 4 | 10K ohm res 0805 |\n| 1 | ESP32-S3-DevKitC-1 |\n| 2 | Piezo buzzer |\n| 1 | Solder |').rows);
  let proj = s.getProject(p.id);
  assert.deepEqual(proj.lines.map(l => l.status), ['review', 'ok', 'missing', 'missing']);

  // Approve with "remember", and the next import matches on its own.
  s.updateLine(proj.lines[0].id, { partId: proj.lines[0].partId, state: 'confirmed' }, { remember: true });
  s.updateLine(proj.lines[3].id, { state: 'skip' });
  const again = s.createProject({ name: 'Again' });
  s.importBom(again.id, [{ name: '10K ohm res 0805', qty: 1 }]);
  assert.equal(s.getProject(again.id).lines[0].state, 'auto');

  // Two builds need 8 resistors; 10 on hand covers it, the ESP32 runs short.
  s.updateProject(p.id, { builds: 2 });
  proj = s.getProject(p.id);
  assert.equal(proj.lines[0].status, 'ok');
  assert.equal(proj.lines[1].status, 'short');
  assert.equal(proj.lines[1].short, 1);
  assert.equal(proj.summary.skip, 1);

  // Receiving the order adds stock and creates the buzzer as a new part.
  const r = s.receiveShortfall(p.id, {}, () => 'Audio');
  assert.deepEqual(r, { added: 1, created: 1 });
  proj = s.getProject(p.id);
  assert.equal(proj.summary.ready, true);
  assert.equal(s.listParts().find(x => x.name === 'Piezo buzzer').category, 'Audio');

  // Building takes parts out; undo puts them back.
  const before = s.listParts().map(x => [x.id, x.qty]);
  const b = s.buildProject(p.id, 2);
  assert.equal(s.listParts().find(x => x.name.startsWith('10k')).qty, 2);
  s.undoBuild(b.build.id);
  assert.deepEqual(s.listParts().map(x => [x.id, x.qty]), before);
  s.close();
});

test('store: deleting and restoring a part relinks BOM lines', () => {
  const s = new Store(':memory:');
  const part = s.createPart({ name: 'WS2812B LED', qty: 30 });
  const p = s.createProject({ name: 'Lights' });
  s.importBom(p.id, [{ name: 'WS2812B LED', qty: 12 }]);
  const lineIds = s.linesUsingPart(part.id);
  const removed = s.deletePart(part.id);
  assert.equal(s.getProject(p.id).lines[0].status, 'missing');
  s.restorePart(removed, lineIds);
  assert.equal(s.getProject(p.id).lines[0].status, 'ok');
  s.close();
});

test('store: backup round trip', () => {
  const a = new Store(':memory:');
  a.createPart({ name: 'Teensy 4.1', qty: 1, aliases: ['T4.1 board'] });
  const p = a.createProject({ name: 'iPod' });
  a.importBom(p.id, [{ name: 'Teensy 4.1', qty: 1 }]);
  a.updateSettings({ costTracking: true });
  const dump = JSON.parse(JSON.stringify(a.exportAll()));
  const b = new Store(':memory:');
  b.importAll(dump);
  assert.equal(b.listParts()[0].aliases[0], 'T4.1 board');
  assert.equal(b.getProject(p.id).lines[0].status, 'ok');
  assert.equal(b.getSettings().costTracking, true);
  assert.throws(() => b.importAll({ nope: true }), /not a Particull backup/);
});

test('exports', () => {
  const parts = [
    { name: '10k resistor', qty: 50, category: 'Resistors', package: '0805', mpn: '', notes: '', location: 'A1', cost: 0.01 },
    { name: 'Teensy 4.1', qty: 0, category: '', package: '', mpn: '', notes: '', location: '' },
  ];
  const md = exportInventory(parts, { format: 'md', locations: false, notes: true, empty: false, cost: false, currency: '$' });
  assert.match(md, /- 50 × 10k resistor \(0805\)/);
  assert.doesNotMatch(md, /Teensy/);
  assert.doesNotMatch(md, /A1/);
  assert.match(md, /\| Qty \| Part \| Part number \| Package \| Notes \|/);
  const csv = exportInventory(parts, { format: 'csv', locations: true, notes: false, empty: true, cost: false, currency: '$' });
  assert.equal(csv.split('\r\n')[0], 'Qty,Unit,Name,Category,Part number,Package,Location');
  const list = shoppingList({ name: 'X', builds: 1, lines: [{ status: 'short', short: 2, have: 1, need: 3, name: 'LED', mpn: '', package: '' }] });
  assert.match(list, /- 2 × LED — have 1, need 3/);
});
