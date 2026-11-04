// End-to-end checks in a real browser: the main things you do in Particull, start to finish.
// Run with: npm run test:e2e   (needs Chrome or Chromium; set CHROME_PATH if it isn't found)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
let server, dir, browser, page;
const problems = [];

function startServer() {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir, PUID: '0', NODE_ENV: 'production' }, stdio: 'pipe',
  });
  server.stderr.on('data', d => problems.push(`server: ${d}`));
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = p => page.evaluate(async u => (await fetch(u)).json(), BASE + p);
const part = async name => (await api('/api/parts')).parts.find(x => x.name === name);

/** Click the first visible element matching a selector whose text matches a pattern. */
async function click(sel, re) {
  const ok = await page.evaluate((s, r) => {
    const el = [...document.querySelectorAll(s)].find(e => e.offsetParent && new RegExp(r, 'i').test(`${e.textContent} ${e.getAttribute('aria-label') || ''}`.trim()));
    el?.click();
    return Boolean(el);
  }, sel, re);
  if (!ok) throw new Error(`Nothing to click: ${sel} /${re}/`);
  await sleep(300);
}

async function type(sel, text) {
  await page.waitForSelector(sel);
  await page.type(sel, text);
}

async function clearAndType(sel, text) {
  await page.evaluate(s => { const el = document.querySelector(s); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }, sel);
  if (text) await page.type(sel, text);
  await sleep(200);
}

async function goto(hash, waitFor) {
  const url = `${BASE}/${hash}`;
  if (page.url() === url) await page.reload(); else await page.goto(url);
  if (waitFor) await page.waitForSelector(waitFor);
}

const rows = () => page.$$eval('.part-row', els => els.map(e => e.querySelector('.part-name').textContent));
const openDialogs = () => page.$$eval('dialog[open]', d => d.length);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'particull-e2e-'));
  startServer();
  await waitForServer();
  execFileSync(process.execPath, ['scripts/seed-demo.js', BASE], { cwd: ROOT, stdio: 'pipe' });
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`page: ${e.message}`));
});

after(async () => {
  await browser?.close();
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quantity steppers save, including typed amounts', async () => {
  await goto('#/parts', '.part-row');
  const before_ = (await part('28mm 8 ohm speaker')).qty;
  // No steppers in the list: + and - on a focused row nudge the amount.
  assert.equal(await page.$('.part-row .stepper-btn'), null);
  await page.focus('.part-row');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await sleep(800);
  assert.equal((await part('28mm 8 ohm speaker')).qty, before_ + 2);
  await page.click('.part-row .stepper-value', { clickCount: 3 });
  await page.keyboard.type('9');
  await page.keyboard.press('Enter');
  await sleep(800);
  assert.equal((await part('28mm 8 ohm speaker')).qty, 9);
});

test('search matches text, locations and values like 4k7', async () => {
  await goto('#/parts', '.part-row');
  await clearAndType('.search-input', 'drawer a2');
  assert.equal((await rows()).length, 3);
  await clearAndType('.search-input', '4k7');
  assert.deepEqual(await rows(), ['4.7k resistor']);
  await clearAndType('.search-input', '0.1u');
  assert.deepEqual(await rows(), ['100nF ceramic capacitor']);
  await clearAndType('.search-input', '');
  await click('.rail-filter', '^Resistors');
  assert.equal((await rows()).length, 62);
  await click('.rail-filter', '^All parts');
});

test('add parts one after another, with category suggestions that stick', async () => {
  await goto('#/parts', '.part-row');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('n');
  await type('dialog[open] .input-lg', '2N3904 transistor');
  await sleep(600);
  await click('dialog[open] .suggest button', 'Semiconductors');
  await click('dialog[open] .stepper-btn', 'Add one');
  await click('dialog[open] button', 'Add and start another');
  assert.equal(await page.$eval('dialog[open] .input-lg', e => e.value), '');
  assert.equal(await page.$eval('dialog[open] input[list="dl-cats"]', e => e.value), 'Semiconductors');
  await type('dialog[open] .input-lg', 'BC547 transistor');
  await page.keyboard.press('Enter');
  await sleep(500);
  assert.equal((await part('2N3904 transistor')).qty, 2);
  assert.ok(await part('BC547 transistor'));
});

test('points out duplicates and adds to the existing part', async () => {
  await goto('#/parts', '.part-row');
  const esp = await part('ESP32-S3-DevKitC-1 N16R8');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('n');
  await type('dialog[open] .input-lg', 'ESP32-S3 DevKitC N16R8');
  await sleep(700);
  await click('dialog[open] .similar button', '^Add 1 to it');
  assert.equal((await part('ESP32-S3-DevKitC-1 N16R8')).qty, esp.qty + 1);
  await click('dialog[open] .sheet-close', 'close');
  assert.equal(await openDialogs(), 0);
});

test('delete with undo, and a warning before losing edits', async () => {
  await goto('#/parts', '.part-row');
  await click('.part-row', 'BC547');
  await click('dialog[open] button', 'Delete');
  await click('dialog[open] button', 'Delete part');
  await sleep(300);
  assert.equal(await part('BC547 transistor'), undefined);
  await click('.toast-action', 'Undo');
  await sleep(400);
  assert.ok(await part('BC547 transistor'));
  await click('.part-row', 'BC547');
  await type('dialog[open] .input-lg', ' X');
  await page.keyboard.press('Escape');
  await sleep(300);
  assert.equal(await openDialogs(), 2);
  await click('dialog[open] button', '^Discard');
  await sleep(400);
  assert.equal(await openDialogs(), 0);
});

test('rough amounts: Plenty, Some, Low and Out', async () => {
  await goto('#/parts', '.part-row');
  await clearAndType('.search-input', '10k resistor');
  await click('.level-pill', 'Plenty');
  await click('.menu-item', 'Running low');
  await sleep(400);
  assert.equal((await part('10k resistor')).stockLevel, 'low');
  await click('.level-pill', 'Running low');
  await click('.menu-item', '^Plenty');
  await sleep(400);
  assert.equal((await part('10k resistor')).stockLevel, 'plenty');
  // A counted part switched to a level in the editor
  await clearAndType('.search-input', 'CR2032');
  await click('.part-row', 'CR2032');
  await click('dialog[open] .amount-seg .seg', '^Some$');
  await click('dialog[open] .btn-primary', '^Save');
  assert.equal((await part('CR2032 coin cell')).stockLevel, 'some');
});

test('units: grams of filament step and save', async () => {
  await goto('#/parts', '.part-row');
  await clearAndType('.search-input', 'filament');
  assert.equal(await page.$eval('.part-row .unit-label', e => e.textContent), 'g');
  await page.click('.part-row .stepper-value', { clickCount: 3 });
  await page.keyboard.type('612.5');
  await page.keyboard.press('Enter');
  await sleep(800);
  assert.equal((await part('PLA filament, black')).qty, 612.5);
});

test('add a kit, merging parts you already have', async () => {
  await goto('#/parts', '.part-row');
  await click('.page-actions button', 'Add several');
  await click('.menu-item', 'Add a kit');
  await click('dialog[open] .kit-kind', '^LEDs$');
  await page.waitForSelector('dialog[open] .preview-row');
  await sleep(400);
  const label = await page.$eval('dialog[open] .sheet-footer .btn-primary', e => e.textContent);
  assert.equal(label, 'Add 3, update 2');
  const red = (await part('5mm red LED')).qty;
  await click('dialog[open] .sheet-footer .btn-primary', 'Add 3');
  await sleep(500);
  assert.equal((await part('5mm red LED')).qty, red + 20);
  assert.equal((await part('5mm blue LED')).qty, 20);
  assert.equal((await part('5mm blue LED')).category, 'LEDs');
});

test('select parts to move, merge and delete them together', async () => {
  await goto('#/parts', '.part-row');
  await click('.select-btn', 'Select');
  for (const n of ['5mm blue LED', '5mm white LED', '5mm yellow LED']) await click('.part-row', n);
  assert.match(await page.$eval('.bar-count', e => e.textContent), /3 selected/);
  await click('.bar-btn', 'Location');
  await clearAndType('dialog[open] input', 'Drawer Z');
  await click('dialog[open] .btn-primary', 'Move');
  await sleep(400);
  assert.equal((await api('/api/parts')).parts.filter(p => p.location === 'Drawer Z').length, 3);

  // Merge two, keeping the first one's name
  await click('.select-btn', 'Select');
  await click('.select-btn', 'Select');
  for (const n of ['5mm red LED', '5mm green LED']) await click('.part-row', n);
  await click('.bar-btn', 'Merge');
  await page.waitForSelector('dialog[open] .merge-option');
  await click('dialog[open] .btn-primary', 'Merge');
  await sleep(500);
  const merged = (await api('/api/parts')).parts.filter(p => /^5mm (red|green) LED$/.test(p.name));
  assert.equal(merged.length, 1);
  assert.ok(merged[0].aliases.length >= 1);

  // Delete two, then undo
  await click('.select-btn', 'Select');
  for (const n of ['5mm blue LED', '5mm white LED']) await click('.part-row', n);
  await click('.bar-btn', 'Delete');
  await click('dialog[open] .btn-danger', 'Delete');
  await sleep(500);
  assert.equal(await part('5mm blue LED'), undefined);
  await click('.toast-action', 'Undo');
  await sleep(600);
  assert.ok(await part('5mm blue LED'));
});

test('project review: pick a match and remember the BOM name', async () => {
  const dingr = (await api('/api/projects')).projects.find(p => p.name === 'Dingr prototype');
  await goto(`#/projects/${dingr.id}`, '.bom-line');
  await click('.bom-line .btn', 'Pick another');
  await page.waitForSelector('dialog[open] .pick-row');
  assert.match(await page.$eval('dialog[open] .pick-row .pick-name', e => e.textContent), /AMS1117-3\.3/);
  await page.click('dialog[open] .pick-row');
  await sleep(600);
  assert.equal((await api(`/api/projects/${dingr.id}`)).summary.review, 0);
  assert.ok((await part('AMS1117-3.3 regulator')).aliases.includes('AMS1117 3.3V LDO'));
});

test('project: add a missing part, shop, receive, build and undo', async () => {
  const dingr = (await api('/api/projects')).projects.find(p => p.name === 'Dingr prototype');
  await goto(`#/projects/${dingr.id}`, '.bom-line');
  await click('.bom-line .btn', 'Add to parts');
  await page.waitForSelector('dialog[open] .input-lg');
  await click('dialog[open] .stepper-btn', 'Add one');
  await click('dialog[open] .stepper-btn', 'Add one');
  await click('dialog[open] .btn-primary', 'Add part');
  await sleep(600);
  let proj = await api(`/api/projects/${dingr.id}`);
  assert.equal(proj.lines.find(l => l.name === '5.1k resistor').status, 'short');

  await click('.summary-actions .btn', 'Shopping list');
  await page.waitForSelector('dialog[open] textarea');
  await sleep(300);
  const list = await page.$eval('dialog[open] textarea', e => e.value);
  assert.match(list, /Piezo buzzer/);
  assert.match(list, /5\.1k/);
  await click('dialog[open] button', 'I got these');
  await click('dialog[open] button', 'Add to parts');
  await sleep(600);
  proj = await api(`/api/projects/${dingr.id}`);
  assert.equal(proj.summary.ready, true);

  const esp = (await part('ESP32-S3-DevKitC-1 N16R8')).qty;
  await click('.summary-actions .btn', 'Build');
  await page.waitForSelector('dialog[open] .build-item');
  assert.match(await page.$eval('dialog[open] .sheet-body', e => e.textContent), /Plenty or Some/);
  await click('dialog[open] .btn-primary', 'Take parts out');
  await sleep(600);
  assert.equal((await part('ESP32-S3-DevKitC-1 N16R8')).qty, esp - 2);
  assert.equal((await part('10k resistor')).stockLevel, 'plenty');
  await click('.toast-action', 'Undo');
  await sleep(700);
  assert.equal((await part('ESP32-S3-DevKitC-1 N16R8')).qty, esp);
});

test('project status and archiving', async () => {
  const proj = (await api('/api/projects')).projects.find(p => p.name === 'Teensy iPod, stage 1');
  await goto(`#/projects/${proj.id}`, '.status-btn');
  await click('.status-btn', 'Planned');
  await click('.menu-item', '^Done');
  await sleep(400);
  assert.equal((await api(`/api/projects/${proj.id}`)).status, 'done');
  await click('.page-actions .icon-btn', 'More project actions');
  await click('.menu-item', '^Archive');
  await sleep(400);
  assert.equal((await api(`/api/projects/${proj.id}`)).archived, true);
  await goto('#/projects', '.project-row');
  const visible = await page.$$eval('.project-row', els => els.filter(e => e.offsetParent).map(e => e.querySelector('.project-name').textContent));
  assert.ok(!visible.includes('Teensy iPod, stage 1'));
  await click('.archived-toggle', 'Show');
  const after_ = await page.$$eval('.project-row', els => els.filter(e => e.offsetParent).map(e => e.querySelector('.project-name').textContent));
  assert.ok(after_.includes('Teensy iPod, stage 1'));
});

test('new project with a status, and a BOM that replaces the old one', async () => {
  await goto('#/projects', '.project-row');
  await click('.page-actions button', 'New project');
  await type('dialog[open] .input-lg', 'Quick test');
  await click('dialog[open] .seg', '^Idea$');
  await type('dialog[open] textarea', 'ESP32-S3 dev board\n3x SSD1306 OLED');
  await click('dialog[open] .btn-primary', 'Create');
  await page.waitForSelector('.bom-line');
  const id = Number(page.url().split('/').pop());
  assert.equal((await api(`/api/projects/${id}`)).status, 'idea');
  await click('.page-actions button', 'Import BOM');
  await type('dialog[open] textarea', '2x 4k7 res\n1x Teensy 4.1');
  await page.evaluate(() => document.querySelector('dialog[open] .switch').click());
  await click('dialog[open] .btn-primary', '^Import');
  await sleep(600);
  assert.equal((await api(`/api/projects/${id}`)).lines.length, 2);
});

test('export for chat groups resistor runs', async () => {
  await goto('#/parts', '.part-row');
  await click('.page-actions button', 'Export for chat');
  await page.waitForSelector('dialog[open] textarea');
  await sleep(500);
  const text = await page.$eval('dialog[open] textarea', e => e.value);
  assert.match(text, /Resistors, 0805: E12 series 10Ω–1M \(61 values\), plus 5\.1k; plenty of each \(5\.1k: \d+\)/);
  await click('dialog[open] .toggle-row', 'Group resistors');
  await sleep(500);
  assert.match(await page.$eval('dialog[open] textarea', e => e.value), /4\.7k resistor \(0805\): plenty/);
  await page.keyboard.press('Escape');
});

test('settings: cost tracking, theme, renaming a location, pasting a list', async () => {
  await goto('#/settings', '.settings-card');
  const toggle = label => page.evaluate(l => [...document.querySelectorAll('.setting')].find(s => s.textContent.includes(l)).querySelector('input').click(), label);
  await toggle('Track what parts cost');
  await sleep(400);
  assert.equal((await api('/api/settings')).costTracking, true);
  await toggle('Track what parts cost');
  await click('.seg', '^Dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await click('.seg', 'Match device');
  await page.evaluate(() => [...document.querySelectorAll('.group-item')].find(g => g.textContent.includes('Bin 3')).querySelector('button').click());
  await page.waitForSelector('dialog[open] input');
  await clearAndType('dialog[open] input', 'Bin 3B');
  await click('dialog[open] .btn-primary', 'Rename');
  await sleep(400);
  assert.equal((await api('/api/parts')).parts.filter(p => p.location === 'Bin 3B').length, 5);

  await goto('#/parts', '.part-row');
  await click('.page-actions button', 'Add several');
  await click('.menu-item', 'Paste a list');
  await type('dialog[open] textarea', '10x ESP32-S3-DevKitC-1 N16R8\n7 x LM358 op-amp');
  await sleep(900);
  const esp = (await part('ESP32-S3-DevKitC-1 N16R8')).qty;
  await click('dialog[open] .btn-primary', 'Add 1, update 1');
  await sleep(500);
  assert.equal((await part('ESP32-S3-DevKitC-1 N16R8')).qty, esp + 10);
  assert.equal((await api('/api/parts')).parts.find(p => /LM358/.test(p.name)).category, 'ICs');
});

test('backups: back up now, change something, restore it back', async () => {
  await goto('#/settings', '.backup-empty, .backup-item');
  const count = async () => (await api('/api/backups')).backups.length;
  const n = await count();
  await click('.settings-card button', 'Back up now');
  await sleep(500);
  assert.equal(await count(), n + 1);
  const teensy = await part('Teensy 4.1');
  await page.evaluate(id => fetch(`/api/parts/${id}`, { method: 'DELETE' }), teensy.id);
  assert.equal(await part('Teensy 4.1'), undefined);
  await goto('#/settings', '.backup-item');
  await page.click('.backup-item .icon-btn');
  await click('.menu-item', 'Restore this backup');
  await click('dialog[open] .btn-danger', 'Restore backup');
  await sleep(800);
  assert.ok(await part('Teensy 4.1'));
  const kinds = (await api('/api/backups')).backups.map(b => b.kind);
  assert.ok(kinds.includes('pre-restore'));
});

test('opens from the service worker and shows saved data when the server is down', async () => {
  await goto('#/parts', '.part-row');
  await page.waitForFunction(() => navigator.serviceWorker?.controller, { timeout: 10000 });
  await page.reload();
  await page.waitForSelector('.part-row');
  const count = (await rows()).length;
  server.kill();
  await sleep(300);
  await page.reload();
  await page.waitForSelector('.part-row', { timeout: 15000 });
  assert.equal((await rows()).length, count);
  await page.waitForSelector('.offline-banner');
  // Restart for any later tests.
  startServer();
  await waitForServer();
});

test('no errors in the browser console', () => {
  const real = problems.filter(p => !/Failed to load resource|ERR_CONNECTION_REFUSED|net::ERR/.test(p));
  assert.deepEqual(real, []);
});
