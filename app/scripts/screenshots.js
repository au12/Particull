// Screenshots of the main screens, desktop and phone, light and dark.
// Usage: node scripts/screenshots.js [base url] [out dir]
//   CHROME_PATH   path to Chrome or Chromium (found automatically on most systems)
//   ONLY          comma-separated shot names, e.g. ONLY=parts,project
//   THEMES        light,dark (default light)
// Seed a fresh instance first: node scripts/seed-demo.js <base url>
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../test/e2e/browser.js';

const base = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const out = path.resolve(process.argv[3] || 'screenshots');
const only = (process.env.ONLY || '').split(',').filter(Boolean);
const themes = (process.env.THEMES || 'light').split(',');
fs.mkdirSync(out, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = (p, sel, re) => p.evaluate((s, r) => {
  const el = [...document.querySelectorAll(s)].find(e => e.offsetParent && new RegExp(r, 'i').test(`${e.textContent} ${e.getAttribute('aria-label') || ''}`.trim()));
  el?.click();
  return Boolean(el);
}, sel, re);

const shots = {
  async parts(p) { await p.goto(`${base}/#/parts`); await p.waitForSelector('.part-row'); },
  async project(p) {
    await p.goto(`${base}/#/projects`); await p.waitForSelector('.project-row');
    await click(p, '.project-row', 'Dingr'); await p.waitForSelector('.bom-line');
  },
  async projects(p) { await p.goto(`${base}/#/projects`); await p.waitForSelector('.project-row'); },
  async add(p) {
    await p.goto(`${base}/#/parts`); await p.waitForSelector('.part-row');
    await click(p, '.page-actions button', '^(\\s*)?Add part');
    await p.waitForSelector('dialog[open] .input-lg');
    await p.type('dialog[open] .input-lg', '10K ohm resistor');
    await sleep(700);
  },
  async kit(p) {
    await p.goto(`${base}/#/parts`); await p.waitForSelector('.part-row');
    await click(p, '.page-actions button', 'Add several');
    await click(p, '.menu-item', 'Add a kit');
    await p.waitForSelector('dialog[open] .kit-kind');
    await click(p, 'dialog[open] .kit-kind', 'Ceramic');
    await p.waitForSelector('dialog[open] .preview-row');
    await sleep(300);
  },
  async select(p) {
    await p.goto(`${base}/#/parts`); await p.waitForSelector('.part-row');
    await click(p, '.select-btn', 'Select');
    for (const n of ['10uF ceramic', '22pF ceramic', '100nF ceramic']) await click(p, '.part-row', n);
  },
  async export(p) {
    await p.goto(`${base}/#/parts`); await p.waitForSelector('.part-row');
    await click(p, '.page-actions button', 'Export for chat');
    await p.waitForSelector('dialog[open] textarea');
    await sleep(500);
  },
  async settings(p) { await p.goto(`${base}/#/settings`); await p.waitForSelector('.backup-item, .backup-empty'); },
};

const viewports = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const browser = await launchBrowser();
const problems = [];
try {
  for (const [vpName, vp] of Object.entries(viewports)) {
    for (const theme of themes) {
      for (const [name, fn] of Object.entries(shots)) {
        if (only.length && !only.includes(name)) continue;
        const page = await browser.newPage();
        await page.setViewport(vp);
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
        page.on('console', m => { if (m.type() === 'error') problems.push(`${vpName} ${name}: ${m.text()}`); });
        page.on('pageerror', e => problems.push(`${vpName} ${name}: ${e.message}`));
        try {
          await fn(page);
          await sleep(250);
          await page.screenshot({ path: path.join(out, `${vpName}-${theme}-${name}.png`) });
        } catch (e) { problems.push(`${vpName} ${name}: ${e.message}`); }
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
console.log(problems.length ? problems.join('\n') : `Saved screenshots to ${out}`);
process.exitCode = problems.length ? 1 : 0;
