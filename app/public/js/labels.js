// Labels for drawers and bins. Each has a QR code: scan it and that location's parts open
// on your phone, ready to adjust.
import { h, clear, icon, toast, showError, plural, stepper, debounce } from './lib.js';
import { state, saveSettings, onChange } from './state.js';
import { qrSvg } from '../shared/qr.js';

// Sizes in inches. Avery templates are US Letter.
const LAYOUTS = {
  5160: { name: 'Avery 5160', hint: '30 to a sheet, 1 × 2⅝ in', cols: 3, rows: 10, w: 2.625, h: 1, top: 0.5, left: 0.1875, gapX: 0.125, gapY: 0, qr: 0.84, long: 13 },
  5163: { name: 'Avery 5163', hint: '10 to a sheet, 2 × 4 in', cols: 2, rows: 5, w: 4, h: 2, top: 0.5, left: 0.15625, gapX: 0.1875, gapY: 0, qr: 1.66, long: 16 },
  plain: { name: 'Plain paper', hint: '24 to a page, cut along the lines', cols: 3, rows: 8, w: 2.5, h: 1.25, top: 0.5, left: 0.5, gapX: 0, gapY: 0, qr: 1.02, long: 13 },
};
const SHEET_PX = { w: 816, h: 1056, gap: 28 };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const linkFor = (base, name) => `${base.replace(/\/+$/, '')}/#/parts/loc/${encodeURIComponent(name)}`;

export function renderLabels(root) {
  let layout = '5160';
  try { layout = localStorage.getItem('particull.labelLayout') || '5160'; } catch { /* private mode */ }
  if (!LAYOUTS[layout]) layout = '5160';
  let start = 1;
  let chosen = null;

  const stage = h('div.label-stage');
  const preview = h('div.label-preview');
  stage.append(preview);
  const locsBox = h('div.labels-locs');
  const countEl = h('span.labels-note');
  const base = h('input.input', {
    type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: location.origin,
    value: state.settings.labelBaseUrl || location.origin,
    onchange: saveBase, oninput: debounce(() => drawSheets(), 200),
  });
  const startStep = stepper({
    value: start, label: 'Start at label',
    onDelta: d => setStart(start + d), onSet: v => setStart(v),
  });
  const layoutSeg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Label sheet' },
    Object.entries(LAYOUTS).map(([k, L]) => h('button.seg', {
      type: 'button', role: 'radio', 'aria-checked': String(layout === k), title: L.hint, dataset: { k },
      onclick: () => {
        layout = k;
        try { localStorage.setItem('particull.labelLayout', k); } catch { /* ignore */ }
        [...layoutSeg.children].forEach(b => b.setAttribute('aria-checked', String(b.dataset.k === k)));
        setStart(start);
        layoutHint.textContent = L.hint;
      },
    }, L.name)));
  const layoutHint = h('span.field-hint', LAYOUTS[layout].hint);
  const printBtn = h('button.btn.btn-primary', { type: 'button', onclick: print }, icon('printer'), 'Print');

  function setStart(v) {
    const per = LAYOUTS[layout].cols * LAYOUTS[layout].rows;
    start = Math.min(per, Math.max(1, Math.round(v) || 1));
    startStep.update(start);
    drawSheets();
  }

  function baseUrl() {
    const v = base.value.trim();
    return /^https?:\/\/\S+$/i.test(v) ? v.replace(/\/+$/, '') : location.origin;
  }

  async function saveBase() {
    const v = base.value.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(v)) { toast('That doesn’t look like a web address. Start it with http:// or https://.', { kind: 'error' }); return; }
    try {
      await saveSettings({ labelBaseUrl: !v || v === location.origin ? '' : v });
      toast('Labels will link to this address.');
    } catch (e) { showError(e); }
  }

  function locations() {
    return [...state.groups.locations].sort((a, b) => collator.compare(a.name, b.name));
  }

  function drawLocs() {
    const all = locations();
    if (chosen == null) chosen = new Set(all.map(l => l.name));
    for (const n of [...chosen]) if (!all.some(l => l.name === n)) chosen.delete(n);
    const allOn = all.every(l => chosen.has(l.name));
    clear(locsBox,
      all.map(l => h('button.chip.chip-sm', {
        type: 'button', 'aria-pressed': String(chosen.has(l.name)),
        onclick: () => { if (chosen.has(l.name)) chosen.delete(l.name); else chosen.add(l.name); drawLocs(); drawSheets(); },
      }, l.name, h('span.chip-count', l.parts))),
      all.length > 1 && h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => {
        chosen = allOn ? new Set() : new Set(all.map(l => l.name));
        drawLocs();
        drawSheets();
      } }, allOn ? 'Select none' : 'Select all'));
  }

  function labelFor(loc, L) {
    const parts = state.parts.filter(p => p.location === loc.name);
    const cats = [...new Set(parts.map(p => p.category).filter(Boolean))];
    const count = plural(parts.length, 'part');
    const sub = layout === '5160' ? count : [count, cats.slice(0, layout === '5163' ? 4 : 2).join(', ') + (cats.length > (layout === '5163' ? 4 : 2) ? '…' : '')].filter(Boolean).join(' · ');
    const t = document.createElement('template');
    t.innerHTML = qrSvg(linkFor(baseUrl(), loc.name), { ecl: 'M', margin: 1, title: `Open ${loc.name} in Particull` });
    const svg = t.content.firstElementChild;
    svg.style.width = `${L.qr}in`;
    svg.style.height = `${L.qr}in`;
    return [svg, h('div.label-text',
      h(`div.label-name${loc.name.length > L.long ? '.is-long' : ''}`, loc.name),
      h('div.label-sub', sub))];
  }

  function drawSheets() {
    const L = LAYOUTS[layout];
    const per = L.cols * L.rows;
    const picked = locations().filter(l => chosen?.has(l.name));
    const slots = [...Array(start - 1).fill(null), ...picked];
    const sheets = [];
    for (let i = 0; i < Math.max(1, slots.length); i += per) sheets.push(slots.slice(i, i + per));
    clear(preview, sheets.map(slotsOnSheet => h(`div.label-sheet.layout-${layout}`, { 'aria-label': 'Label sheet' },
      slotsOnSheet.map((loc, i) => {
        const col = i % L.cols;
        const row = Math.floor(i / L.cols);
        return h(`div.label${loc ? '' : '.is-skip'}`, {
          style: { left: `${L.left + col * (L.w + L.gapX)}in`, top: `${L.top + row * (L.h + L.gapY)}in`, width: `${L.w}in`, height: `${L.h}in` },
          title: loc ? linkFor(baseUrl(), loc.name) : 'Already used',
        }, loc ? labelFor(loc, L) : null);
      }))));
    countEl.textContent = picked.length
      ? `${plural(picked.length, 'label')} on ${plural(sheets.length, 'sheet')}`
      : 'Pick the locations to print';
    printBtn.disabled = picked.length === 0;
    fit();
  }

  // Show the sheets at a size that fits the window; they print at full size.
  function fit() {
    const avail = stage.clientWidth || root.clientWidth;
    const scale = Math.min(1, avail / SHEET_PX.w);
    const n = preview.children.length;
    preview.style.transform = scale < 1 ? `scale(${scale})` : '';
    stage.style.height = `${n * (SHEET_PX.h + SHEET_PX.gap) * scale}px`;
  }

  function print() {
    document.body.classList.add('print-labels');
    const done = () => document.body.classList.remove('print-labels');
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    setTimeout(done, 1000);
  }

  function draw() {
    if (!state.groups.locations.length) {
      clear(root,
        h('header.page-head', h('div', h('h1', 'Location labels'), h('p.page-sub', 'A label with a QR code for each drawer or bin.'))),
        h('div.empty',
          h('div.empty-art', icon('qr')),
          h('h2', 'No locations yet'),
          h('p', 'Give your parts a location, like “Drawer A2” or “Bin 3”, and you can print a label for each one here. Scanning a label opens what’s in it.'),
          h('div.empty-actions', h('a.btn.btn-primary', { href: '#/parts' }, 'Go to parts'))));
      return;
    }
    drawLocs();
    clear(root,
      h('a.back-link', { href: '#/parts' }, icon('back'), 'Parts'),
      h('header.page-head',
        h('div', h('h1', 'Location labels'), h('p.page-sub', 'A label for each drawer or bin. Scan one with your phone to see what’s in it.')),
        h('div.page-actions', printBtn)),
      h('section.labels-card',
        h('div.labels-row',
          h('div.field', h('span.field-label', 'Label sheet'), layoutSeg, layoutHint),
          h('div.field.labels-start', h('span.field-label', 'Start at label'), startStep, h('span.field-hint', 'Skip labels already used on the first sheet.'))),
        h('label.field', h('span.field-label', 'Link to'), base,
          h('span.field-hint', 'The address your phone uses to reach Particull, like http://tower.local:8080.')),
        h('div.field', h('span.field-label', 'Locations'), locsBox),
        h('div.labels-actions', countEl, h('span.field-hint', 'Print at 100% scale with margins set to None.'))),
      stage);
    drawSheets();
  }

  draw();
  const onResize = () => fit();
  window.addEventListener('resize', onResize);
  const off = onChange(what => { if (what === 'parts') draw(); });
  return () => {
    off();
    window.removeEventListener('resize', onResize);
    document.body.classList.remove('print-labels');
  };
}
