// Projects list, a project's BOM checked against inventory, and everything you do from there.
import { h, clear, icon, api, toast, showError, sheet, confirmSheet, menu, plural, copyText, downloadUrl, isTouch, readFile, money, stepper } from './lib.js';
import { state, loadParts, costOn } from './state.js';
import { openPartEditor } from './editor.js';
import { formatNumber, formatStock, unitLabel, LEVEL_LABELS } from '../shared/stock.js';

// Where a project is. Archived is separate: any project can be put away.
const PROJECT_STATUS = {
  building: { label: 'Building', order: 0 },
  planned: { label: 'Planned', order: 1 },
  idea: { label: 'Idea', order: 2 },
  done: { label: 'Done', order: 3 },
};
const statusPill = st => h(`span.status-pill.status-${st}`, PROJECT_STATUS[st]?.label || st);

/** "4", "2.5 m", "6 spools" for an amount of a line's matched part. */
function amt(n, part) {
  const u = part ? unitLabel(part.unit, n) : '';
  return u ? `${formatNumber(n)} ${u}` : formatNumber(n);
}

const STATUS = {
  ok: { label: 'In stock', short: 'In stock' },
  short: { label: 'Buy more', short: 'Short' },
  missing: { label: 'To buy', short: 'To buy' },
  review: { label: 'To check', short: 'Check' },
  skip: { label: 'Not tracked', short: 'Not tracked' },
};

function confidence(score) {
  if (score >= 0.85) return 'Very likely';
  if (score >= 0.65) return 'Likely';
  return 'Possibly';
}

function bar(summary, { large = false } = {}) {
  const total = summary.lines || 1;
  const seg = (k, n) => n > 0 && h(`span.bar-seg.seg-${k}`, { style: { flexGrow: String(n) }, title: `${n} ${STATUS[k].label.toLowerCase()}` });
  return h(`div.bom-bar${large ? '.bom-bar-lg' : ''}`, { role: 'img', 'aria-label': `${summary.ok} of ${summary.lines} lines in stock` },
    summary.lines ? [seg('ok', summary.ok), seg('skip', summary.skip), seg('review', summary.review), seg('short', summary.short), seg('missing', summary.missing)] : h('span.bar-seg.seg-empty', { style: { flexGrow: String(total) } }));
}

function statusLine(summary) {
  if (!summary.lines) return h('span.status-text', 'No parts listed yet');
  if (summary.ready) return h('span.status-text.status-ready', icon('check'), 'Everything is in stock');
  const toBuy = summary.short + summary.missing;
  return h('span.status-text',
    h('span.stat.stat-ok', `${summary.ok} in stock`),
    summary.review > 0 && h('span.stat.stat-review', `${summary.review} to check`),
    toBuy > 0 && h('span.stat.stat-missing', `${toBuy} to buy`));
}

// ---------- list ----------
export async function renderProjects(root) {
  const list = h('div.project-list', h('div.loading', 'Loading projects'));
  clear(root,
    h('header.page-head',
      h('div', h('h1', 'Projects'), h('p.page-sub', 'Check a project’s bill of materials against your parts.')),
      h('div.page-actions',
        h('button.icon-btn.icon-btn-primary.show-sm', { type: 'button', 'aria-label': 'New project', onclick: openNewProject }, icon('plus')),
        h('button.btn.btn-primary.hide-sm', { type: 'button', onclick: openNewProject }, icon('plus'), 'New project'))),
    list);

  let projects;
  try { ({ projects } = await api('/projects')); } catch (e) { clear(list, h('div.empty.empty-small', h('p', e.message))); return; }
  if (!projects.length) {
    clear(list, h('div.empty',
      h('div.empty-art', icon('projects')),
      h('h2', 'No projects yet'),
      h('p', 'A project holds a bill of materials. Paste one from a chat or a CSV and Particull shows what you have, what to check, and what to buy.'),
      h('div.empty-actions', h('button.btn.btn-primary', { type: 'button', onclick: openNewProject }, icon('plus'), 'New project'))));
    return;
  }
  const row = p => h(`a.project-row${p.archived ? '.is-archived' : ''}`, { href: `#/projects/${p.id}` },
    h('div.project-main',
      h('div.project-name-row', h('h2.project-name', p.name), p.archived && statusPill(p.status)),
      p.status !== 'done' && !p.archived ? [statusLine(p.summary), bar(p.summary)] : h('span.status-text', plural(p.summary.lines, 'line'))),
    h('div.project-side',
      p.builds > 1 && h('span.builds-badge', `×${p.builds}`),
      icon('chevron', 'chev')));
  const active = projects.filter(p => !p.archived);
  const archived = projects.filter(p => p.archived);
  const groups = Object.keys(PROJECT_STATUS).map(st => [st, active.filter(p => p.status === st)]).filter(([, ps]) => ps.length);
  const archivedBox = h('div.project-list', { hidden: true }, archived.map(row));
  clear(list,
    groups.length === 0 && h('p.page-sub', 'All your projects are archived.'),
    groups.map(([st, ps]) => h('section.project-group',
      h('h2.group-head', h('span', PROJECT_STATUS[st].label), h('span.group-count', ps.length)),
      h('div.project-list', ps.map(row)))),
    archived.length > 0 && h('section.project-group.archived-group',
      h('button.btn.btn-quiet.archived-toggle', { type: 'button', 'aria-expanded': 'false', onclick: e => {
        archivedBox.hidden = !archivedBox.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!archivedBox.hidden));
        e.currentTarget.querySelector('span').textContent = archivedBox.hidden ? `Show ${plural(archived.length, 'archived project')}` : 'Hide archived projects';
      } }, icon('archive'), h('span', `Show ${plural(archived.length, 'archived project')}`)),
      archivedBox));
}

// ---------- new project ----------
function bomInput({ value = '' } = {}) {
  const ta = h('textarea.input.paste-area', { rows: '8', spellcheck: 'false', placeholder: '| Qty | Part | Part number | Package | Notes |\n| --- | --- | --- | --- | --- |\n| 1 | ESP32-S3 dev board | | | |\n| 4 | 10k resistor | | 0805 | pull-ups |\n\nA table, a CSV/KiCad BOM, or one part per line all work.' });
  ta.value = value;
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.md,text/*', hidden: true, onchange: async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { ta.value = await readFile(f); ta.dispatchEvent(new Event('input')); } catch (err) { showError(err); }
    e.target.value = '';
  } });
  const copyBtn = h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: async () => {
    try {
      const { text } = await api('/bom-format');
      if (await copyText(text)) toast('Copied. Add it to your message so Claude answers in a format Particull reads.');
    } catch (e) { showError(e); }
  } }, icon('copy'), 'Copy BOM instructions for Claude');
  const tools = h('div.paste-tools', h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => file.click() }, icon('file'), 'Open a file'), file, copyBtn);
  return { ta, tools };
}

export function openNewProject() {
  const s = sheet({ title: 'New project', size: 'lg' });
  const name = h('input.input.input-lg', { placeholder: 'e.g. Dingr v2 prototype', autocomplete: 'off', required: true });
  let builds = 1;
  const buildStep = stepper({ value: 1, label: 'How many to build', onDelta: d => { builds = Math.max(1, builds + d); buildStep.update(builds); }, onSet: v => { builds = Math.max(1, v); buildStep.update(builds); } });
  const { ta, tools } = bomInput();
  let status = 'planned';
  const statusSeg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Status' },
    ['idea', 'planned', 'building'].map(k => h('button.seg', {
      type: 'button', role: 'radio', 'aria-checked': String(status === k), dataset: { k },
      onclick: () => { status = k; [...statusSeg.children].forEach(b => b.setAttribute('aria-checked', String(b.dataset.k === k))); },
    }, PROJECT_STATUS[k].label)));
  const form = h('form', { onsubmit: e => { e.preventDefault(); create(); } },
    h('label.field', h('span.field-label', 'Name'), name),
    h('div.form-row.new-project-row',
      h('div.field', h('span.field-label', 'Status'), statusSeg),
      h('div.field', h('span.field-label', 'How many to build'), buildStep)),
    h('div.field', h('span.field-label', 'Bill of materials', h('span.optional', 'optional, you can add it later')), ta, tools));
  s.body.append(form);
  const btn = h('button.btn.btn-primary', { type: 'button', onclick: create }, 'Create project');
  s.footer.append(h('span'), h('div.footer-right', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'), btn));
  async function create() {
    if (!name.value.trim()) { name.focus(); toast('Give the project a name.'); return; }
    btn.disabled = true;
    try {
      const p = await api('/projects', { method: 'POST', body: { name: name.value.trim(), builds, status, bom: ta.value.trim() || undefined } });
      s.close();
      location.hash = `#/projects/${p.id}`;
      if (p.lines.length) toast(importSummary(p.lines.length, p.summary));
    } catch (e) { showError(e); btn.disabled = false; }
  }
  setTimeout(() => name.focus());
}

function importSummary(added, sm) {
  const bits = [`${sm.ok} in stock`];
  if (sm.review) bits.push(`${sm.review} to check`);
  if (sm.short + sm.missing) bits.push(`${sm.short + sm.missing} to buy`);
  return `Imported ${plural(added, 'line')}: ${bits.join(', ')}.`;
}

// ---------- one project ----------
const projectView = { tab: 'all', remember: true };

export function renderProject(root, id) {
  let project = null;
  const body = h('div.project-body', h('div.loading', 'Loading project'));
  clear(root, h('a.back-link', { href: '#/projects' }, icon('back'), 'Projects'), body);

  async function load() {
    try {
      project = await api(`/projects/${id}`);
      draw();
    } catch (e) {
      clear(body, h('div.empty.empty-small', h('p', e.message), h('a.btn', { href: '#/projects' }, 'Back to projects')));
    }
  }

  function set(p) {
    project = p;
    const y = window.scrollY;
    draw();
    window.scrollTo(0, y);
  }

  async function act(fn, success) {
    try {
      const r = await fn();
      const p = r?.lines ? r : r?.project;
      if (p) set(p);
      if (success) toast(typeof success === 'function' ? success(r) : success);
      return r;
    } catch (e) { showError(e); return null; }
  }

  const updateLine = (line, patch, msg) => act(() => api(`/lines/${line.id}`, { method: 'PUT', body: patch }), msg);

  function draw() {
    const p = project;
    const sm = p.summary;
    if (projectView.tab !== 'all' && !p.lines.some(l => tabOf(l) === projectView.tab)) projectView.tab = 'all';

    const buildStep = stepper({
      value: p.builds, label: 'Number of builds',
      onDelta: d => { if (p.builds + d >= 1) act(() => api(`/projects/${p.id}`, { method: 'PUT', body: { builds: p.builds + d } })); },
      onSet: v => act(() => api(`/projects/${p.id}`, { method: 'PUT', body: { builds: Math.max(1, v) } })),
    });

    const setStatus = st => act(() => api(`/projects/${p.id}`, { method: 'PUT', body: { status: st } }));
    const statusBtn = h(`button.status-pill.status-${p.status}.status-btn`, { type: 'button', 'aria-label': `Status: ${PROJECT_STATUS[p.status].label}. Change`, onclick: e => menu(e.currentTarget,
      Object.entries(PROJECT_STATUS).map(([k, v]) => ({ label: v.label, icon: p.status === k ? 'check' : null, action: () => setStatus(k) }))) },
    PROJECT_STATUS[p.status].label, icon('down'));
    const moreBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'More project actions', onclick: e => menu(e.currentTarget, [
      { label: 'Rename or edit notes', icon: 'edit', action: () => editProject(p) },
      p.archived
        ? { label: 'Unarchive', icon: 'archive', action: () => act(() => api(`/projects/${p.id}`, { method: 'PUT', body: { archived: false } }), 'Project unarchived.') }
        : { label: 'Archive', icon: 'archive', action: () => act(() => api(`/projects/${p.id}`, { method: 'PUT', body: { archived: true } }), 'Project archived. It’s at the bottom of the projects list.') },
      { label: 'Add a line', icon: 'plus', action: () => editLine(null) },
      { label: 'Check matches again', icon: 'refresh', action: () => act(() => api(`/projects/${p.id}/rematch`, { method: 'POST', body: {} }), r => (r.changed ? `${plural(r.changed, 'line')} changed.` : 'No new matches found.')) },
      '-',
      { label: 'Copy BOM as a table', icon: 'copy', action: async () => { if (await copyText(await api(`/projects/${p.id}/export?kind=bom`, { raw: true }))) toast('BOM copied.'); } },
      { label: 'Download BOM (CSV)', icon: 'download', action: () => downloadUrl(`/api/projects/${p.id}/export?kind=bom&format=csv&download=1`) },
      '-',
      { label: 'Delete project', icon: 'trash', danger: true, action: deleteProject },
    ]) }, icon('more'));

    const toBuy = sm.short + sm.missing;
    const tabs = [
      ['all', 'All', sm.lines],
      ['review', 'To check', sm.review],
      ['buy', 'To buy', toBuy],
      ['ok', 'In stock', sm.ok],
      ['skip', 'Not tracked', sm.skip],
    ].filter(([k, , n]) => k === 'all' || n > 0);

    const lines = p.lines.filter(l => projectView.tab === 'all' || tabOf(l) === projectView.tab);
    const order = { review: 0, missing: 1, short: 2, ok: 3, skip: 4 };
    if (projectView.tab === 'all') lines.sort((a, b) => order[a.status] - order[b.status] || a.position - b.position);

    clear(body,
      h('header.page-head.project-head',
        h('div.project-title',
          h('div.project-title-row', h('h1', p.name), statusBtn, p.archived && h('span.status-pill.status-archived', 'Archived')),
          p.notes ? h('p.page-sub.project-notes', p.notes) : null),
        h('div.page-actions',
          h('button.btn.btn-quiet.hide-sm', { type: 'button', onclick: () => openImport(p) }, icon('upload'), 'Import BOM'),
          h('button.icon-btn.show-sm', { type: 'button', 'aria-label': 'Import BOM', onclick: () => openImport(p) }, icon('upload')),
          moreBtn)),

      h('section.project-summary',
        h('div.summary-top',
          h('div.summary-status', statusLine(sm)),
          h('div.builds', h('span.builds-label', 'Builds'), buildStep)),
        bar(sm, { large: true }),
        sm.cost && costOn() && h('p.summary-cost',
          `Parts cost about ${money(sm.cost.total, state.settings.currency)}`,
          sm.cost.toBuy > 0 && `, ${money(sm.cost.toBuy, state.settings.currency)} of it still to buy`,
          sm.cost.priced < sm.lines && ` (${sm.cost.priced} of ${sm.lines} lines have a cost)`, '.'),
        p.lines.length > 0 && h('div.summary-actions',
          h('button.btn', { type: 'button', onclick: () => openShopping(p), disabled: toBuy === 0 && sm.review === 0 }, icon('cart'), toBuy ? `Shopping list (${toBuy})` : 'Shopping list'),
          h('button.btn', { type: 'button', onclick: () => openBuild(p) }, icon('build'), 'Build'))),

      sm.review > 0 && h('div.review-banner',
        h('div.review-text',
          h('strong', `${plural(sm.review, 'line')} ${sm.review === 1 ? 'needs' : 'need'} a quick check`),
          h('span', 'Particull found parts that look the same under a different name. Confirm each one, or accept them all.')),
        h('div.review-actions',
          h('label.toggle-row.toggle-sm',
            h('input.switch', { type: 'checkbox', checked: projectView.remember, onchange: e => { projectView.remember = e.target.checked; } }),
            h('span', 'Remember these names')),
          h('button.btn.btn-warn', { type: 'button', onclick: () => act(() => api(`/projects/${p.id}/accept-all`, { method: 'POST', body: { remember: projectView.remember } }), r => `Accepted ${plural(r.accepted, 'match', 'matches')}.`) }, icon('check'), 'Accept all'))),

      p.lines.length > 0 && h('div.tabs', { role: 'tablist' }, tabs.map(([k, label, n]) => h('button.tab', {
        type: 'button', role: 'tab', 'aria-selected': String(projectView.tab === k),
        onclick: () => { projectView.tab = k; draw(); },
      }, label, h('span.tab-count', n)))),

      p.lines.length
        ? h('div.bom-lines', lines.map(lineRow))
        : h('div.empty',
          h('div.empty-art', icon('paste')),
          h('h2', 'Add the bill of materials'),
          h('p', 'Paste a BOM from a chat, open a CSV or KiCad export, or add lines one at a time.'),
          h('div.empty-actions',
            h('button.btn.btn-primary', { type: 'button', onclick: () => openImport(p) }, icon('upload'), 'Import BOM'),
            h('button.btn', { type: 'button', onclick: () => editLine(null) }, icon('plus'), 'Add a line'))),

      p.lines.length > 0 && h('button.btn.btn-quiet.add-line', { type: 'button', onclick: () => editLine(null) }, icon('plus'), 'Add a line'),

      p.buildLog?.length > 0 && h('section.build-log',
        h('h2.group-head', h('span', 'Recent builds')),
        p.buildLog.map(b => h('div.build-row',
          h('span', `${plural(b.count, 'build')} on ${new Date(b.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`),
          h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => undoBuild(b.id) }, 'Put parts back')))));
  }

  function tabOf(l) {
    return l.status === 'short' || l.status === 'missing' ? 'buy' : l.status;
  }

  function lineRow(l) {
    const p = project;
    const meta = [
      l.mpn && h('span.meta-mpn', l.mpn),
      l.package && h('span.meta-pkg', l.package),
      l.refs && h('span.meta-refs', l.refs),
      l.notes && h('span.meta-note', l.notes),
    ].filter(Boolean);
    const lineMenu = e => menu(e.currentTarget, [
      { label: 'Edit line', icon: 'edit', action: () => editLine(l) },
      l.status !== 'skip' && { label: l.part ? 'Use a different part' : 'Find a matching part', icon: 'swap', action: () => pickPart(l) },
      l.part && { label: `Open ${l.part.name}`, icon: 'parts', action: () => openPartEditor(state.byId.get(l.part.id) || l.part, {}, { onSaved: () => load() }) },
      l.status === 'skip'
        ? { label: 'Track this part', icon: 'refresh', action: () => updateLine(l, { state: 'none' }).then(() => act(() => api(`/projects/${p.id}/rematch`, { method: 'POST', body: {} }))) }
        : { label: 'Don’t track this', icon: 'x', action: () => updateLine(l, { state: 'skip', partId: null }, `${l.name} is not tracked.`) },
      '-',
      { label: 'Delete line', icon: 'trash', danger: true, action: () => act(() => api(`/lines/${l.id}`, { method: 'DELETE' }), 'Line deleted.') },
    ]);

    const qtyText = p.builds > 1 ? h('span.line-qty', { title: `${formatNumber(l.qty)} per build` }, formatNumber(l.need)) : h('span.line-qty', formatNumber(l.qty));
    const pillText = l.level === 'low' ? 'Top up'
      : l.status === 'short' || (l.status === 'missing' && l.part) ? `Buy ${amt(l.short, l.part)}`
        : STATUS[l.status].short;
    const head = h('div.line-head',
      qtyText,
      h('div.line-title', h('span.line-name', l.name), meta.length > 0 && h('div.part-meta', meta)),
      h('span.pill', { class: `pill-${l.status}` }, pillText),
      h('button.icon-btn.icon-btn-sm', { type: 'button', 'aria-label': `More for ${l.name}`, onclick: lineMenu }, icon('more')));

    let detail = null;
    if (l.status === 'review' && l.part) {
      const notes = (l.matchNotes || []).filter(n => n !== 'value not listed');
      detail = h('div.detail.detail-review',
        h('div.review-match',
          h('span.review-q', `${confidence(l.score ?? 0)} the same as`),
          h('span.review-part', l.part.name, l.part.package && !l.part.name.includes(l.part.package) ? h('span.meta-pkg', l.part.package) : null),
          h('span.review-stock', l.part.stockLevel ? formatStock(l.part) : `${amt(l.part.qty, l.part)} on hand`, l.part.location ? h('span.tape', l.part.location) : null),
          notes.length > 0 && h('span.review-warn', icon('warn'), notes.join(', ').replace(/^./, c => c.toUpperCase()))),
        h('div.review-buttons',
          h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => updateLine(l, { partId: l.part.id, state: 'confirmed', remember: projectView.remember }) }, icon('check'), 'Same part'),
          h('button.btn.btn-sm', { type: 'button', onclick: () => pickPart(l) }, 'Pick another'),
          h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => updateLine(l, { state: 'none', partId: null }) }, 'I don’t have it')));
    } else if (l.status === 'ok' || l.status === 'short' || (l.status === 'missing' && l.part)) {
      detail = h('div.detail.detail-stock',
        h('span.stock-part', l.state === 'auto' ? icon('check') : icon('link'), l.part.name),
        h('span.stock-qty', l.level ? LEVEL_LABELS[l.level]
          : l.status === 'ok' ? `${amt(l.part.qty, l.part)} on hand` : `have ${amt(l.have, l.part)} of ${amt(l.need, l.part)}`),
        l.part.location && h('span.tape', l.part.location));
    } else if (l.status === 'missing') {
      detail = h('div.detail.detail-missing',
        h('span', 'Not in your parts'),
        h('div.review-buttons',
          h('button.btn.btn-sm', { type: 'button', onclick: () => pickPart(l) }, 'Find a match'),
          h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => addAsPart(l) }, icon('plus'), 'Add to parts')));
    }
    return h(`div.bom-line.line-${l.status}`, head, detail);
  }

  function addAsPart(l) {
    openPartEditor(null, { name: l.name, mpn: l.mpn, package: l.package, qty: 0, notes: '' }, {
      onSaved: saved => updateLine(l, { partId: saved.id, state: 'confirmed' }),
    });
  }

  // Choose the inventory part a line refers to.
  async function pickPart(l) {
    const s = sheet({ title: 'Match a part', subtitle: `“${l.name}”${l.package ? ` (${l.package})` : ''}${l.mpn ? `, ${l.mpn}` : ''}`, size: 'md' });
    const search = h('input.search-input', { type: 'search', placeholder: 'Search your parts', autocomplete: 'off', 'aria-label': 'Search your parts' });
    const results = h('div.pick-list');
    const remember = h('input.switch', { type: 'checkbox', checked: projectView.remember });
    s.body.append(
      h('label.search', icon('search'), search),
      results,
      h('label.toggle-row.pick-remember', remember, h('span', `Remember “${l.name}” as another name for the part you pick`)));
    s.footer.append(
      h('div.footer-left',
        h('button.btn.btn-quiet', { type: 'button', onclick: () => { s.close(); updateLine(l, { state: 'skip', partId: null }, `${l.name} is not tracked.`); } }, 'Don’t track'),
        h('button.btn.btn-quiet', { type: 'button', onclick: () => { s.close(); updateLine(l, { state: 'none', partId: null }); } }, 'I don’t have it')),
      h('button.btn', { type: 'button', onclick: () => { s.close(); addAsPart(l); } }, icon('plus'), 'Add as a new part'));

    let candidates = [];
    try { ({ candidates } = await api(`/lines/${l.id}/candidates`)); } catch { /* search still works */ }
    const scoreOf = new Map(candidates.map(c => [c.id, c]));

    function choose(part) {
      s.close();
      updateLine(l, { partId: part.id, state: 'confirmed', remember: remember.checked }, `Matched to ${part.name}.`);
    }
    function row(part) {
      const c = scoreOf.get(part.id);
      return h('button.pick-row', { type: 'button', onclick: () => choose(part), class: l.part?.id === part.id ? 'current' : '' },
        h('div.pick-main',
          h('span.pick-name', part.name),
          h('div.part-meta',
            part.package && h('span.meta-pkg', part.package),
            part.mpn && h('span.meta-mpn', part.mpn),
            part.location && h('span.tape', part.location),
            c && c.notes?.filter(n => n !== 'value not listed').length > 0 && h('span.meta-warn', c.notes.filter(n => n !== 'value not listed').join(', ')))),
        h('div.pick-side',
          c && h('span.pick-score', c.exact ? 'Same name' : confidence(c.score)),
          h('span.pick-qty', `${part.qty} on hand`)));
    }
    function drawResults() {
      const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      let list;
      if (!terms.length) {
        list = candidates.map(c => state.byId.get(c.id)).filter(Boolean);
        clear(results,
          list.length ? h('p.pick-label', 'Closest matches') : h('p.pick-label', 'No close matches. Search your parts instead.'),
          list.map(row));
        return;
      }
      list = state.parts.filter(p => terms.every(t => `${p.name} ${p.mpn} ${p.package} ${p.category} ${(p.aliases || []).join(' ')}`.toLowerCase().includes(t))).slice(0, 60);
      clear(results, list.length ? list.map(row) : h('p.pick-label', `Nothing matches “${search.value}”.`));
    }
    search.addEventListener('input', drawResults);
    drawResults();
    if (!isTouch()) search.focus();
  }

  function editLine(l) {
    const p = project;
    const s = sheet({ title: l ? 'Edit line' : 'Add a line', size: 'md' });
    let qty = l?.qty ?? 1;
    const qtyStep = stepper({ value: qty, label: 'Quantity per build', onDelta: d => { qty = Math.max(1, qty + d); qtyStep.update(qty); }, onSet: v => { qty = Math.max(1, v); qtyStep.update(qty); } });
    const name = h('input.input.input-lg', { value: l?.name || '', autocomplete: 'off', placeholder: 'e.g. 10k resistor' });
    const mpn = h('input.input.mono', { value: l?.mpn || '', autocomplete: 'off', spellcheck: 'false' });
    const pkg = h('input.input', { value: l?.package || '', autocomplete: 'off' });
    const refs = h('input.input', { value: l?.refs || '', autocomplete: 'off', placeholder: 'e.g. R1, R2, R5' });
    const notes = h('input.input', { value: l?.notes || '', autocomplete: 'off', placeholder: 'What it’s for' });
    const f = (label, c) => h('label.field', h('span.field-label', label), c);
    const form = h('form', { onsubmit: e => { e.preventDefault(); save(); } },
      h('div.form-row', h('div.field', h('span.field-label', 'Qty per build'), qtyStep), h('div.form-row-grow', f('Part', name))),
      h('div.form-grid', f('Part number', mpn), f('Package', pkg), f('References', refs), f('Notes', notes)),
      h('button', { type: 'submit', hidden: true }));
    s.body.append(form);
    s.footer.append(
      l ? h('button.btn.btn-danger-quiet', { type: 'button', onclick: () => { s.close(); act(() => api(`/lines/${l.id}`, { method: 'DELETE' }), 'Line deleted.'); } }, icon('trash'), 'Delete') : h('span'),
      h('div.footer-right', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'), h('button.btn.btn-primary', { type: 'button', onclick: save }, l ? 'Save' : 'Add line')));
    async function save() {
      if (!name.value.trim()) { name.focus(); return; }
      const body = { qty, name: name.value.trim(), mpn: mpn.value.trim(), package: pkg.value.trim(), refs: refs.value.trim(), notes: notes.value.trim() };
      const r = await act(() => (l ? api(`/lines/${l.id}`, { method: 'PUT', body }) : api(`/projects/${p.id}/lines`, { method: 'POST', body })));
      if (r) s.close();
    }
    if (!isTouch()) setTimeout(() => name.focus());
  }

  function editProject(p) {
    const s = sheet({ title: 'Project details', size: 'md' });
    const name = h('input.input.input-lg', { value: p.name, autocomplete: 'off' });
    const notes = h('textarea.input', { rows: '4', placeholder: 'Links, goals, anything you want to keep with the project' });
    notes.value = p.notes;
    s.body.append(h('form', { onsubmit: e => { e.preventDefault(); save(); } },
      h('label.field', h('span.field-label', 'Name'), name),
      h('label.field', h('span.field-label', 'Notes'), notes)));
    s.footer.append(h('span'), h('div.footer-right', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'), h('button.btn.btn-primary', { type: 'button', onclick: save }, 'Save')));
    async function save() {
      if (!name.value.trim()) { name.focus(); return; }
      if (await act(() => api(`/projects/${p.id}`, { method: 'PUT', body: { name: name.value.trim(), notes: notes.value } }))) s.close();
    }
  }

  async function deleteProject() {
    const ok = await confirmSheet({ title: `Delete ${project.name}?`, message: 'The project and its BOM are removed. Your parts stay as they are.', confirm: 'Delete project', danger: true });
    if (!ok) return;
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' });
      toast(`Deleted ${project.name}.`);
      location.hash = '#/projects';
    } catch (e) { showError(e); }
  }

  function openImport(p) {
    const s = sheet({ title: 'Import BOM', subtitle: `Into ${p.name}`, size: 'lg' });
    const { ta, tools } = bomInput();
    const replace = h('input.switch', { type: 'checkbox' });
    s.body.append(ta, tools,
      p.lines.length > 0 && h('label.toggle-row', replace, h('span', `Replace the ${plural(p.lines.length, 'line')} already here`)));
    const btn = h('button.btn.btn-primary', { type: 'button', onclick: run }, 'Import');
    s.footer.append(h('span'), h('div.footer-right', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'), btn));
    async function run() {
      if (!ta.value.trim()) { ta.focus(); return; }
      btn.disabled = true;
      const r = await act(() => api(`/projects/${p.id}/bom`, { method: 'POST', body: { text: ta.value, replace: replace.checked } }), r2 => importSummary(r2.added, r2.project.summary));
      if (r) { projectView.tab = r.project.summary.review ? 'review' : 'all'; draw(); s.close(); } else btn.disabled = false;
    }
    setTimeout(() => ta.focus());
  }

  async function openShopping(p) {
    const s = sheet({ title: 'Shopping list', subtitle: p.builds > 1 ? `For ${p.builds} builds of ${p.name}` : p.name, size: 'md' });
    const out = h('textarea.input.export-area', { readOnly: true, rows: '10', 'aria-label': 'Shopping list' });
    s.body.append(
      p.summary.review > 0 && h('p.notice', icon('warn'), `${plural(p.summary.review, 'line')} still ${p.summary.review === 1 ? 'needs' : 'need'} checking, so this list may change.`),
      out,
      h('p.field-hint', 'When the order arrives, add it all to your parts in one go. Lines that weren’t in your parts become new parts.'));
    const copyBtn = h('button.btn', { type: 'button', onclick: async () => { if (await copyText(out.value)) toast('Shopping list copied.'); } }, icon('copy'), 'Copy');
    const receive = h('button.btn.btn-primary', { type: 'button', onclick: async () => {
      const ok = await confirmSheet({ title: 'Add these to your parts?', message: `This adds the quantities on the list to your parts. ${p.summary.missing ? 'Parts you don’t have yet are created.' : ''}`, confirm: 'Add to parts' });
      if (!ok) return;
      const r = await act(() => api(`/projects/${p.id}/receive`, { method: 'POST', body: {} }), r2 => `Added to ${plural(r2.added + r2.created, 'part')}${r2.created ? `, ${r2.created} of them new` : ''}.`);
      if (r) { s.close(); loadParts(); }
    } }, icon('check'), 'I got these');
    s.footer.append(
      h('button.btn.btn-quiet', { type: 'button', onclick: () => downloadUrl(`/api/projects/${p.id}/export?kind=shopping&format=csv&download=1`) }, icon('download'), 'CSV'),
      h('div.footer-right', copyBtn, p.summary.short + p.summary.missing > 0 && receive));
    try { out.value = await api(`/projects/${p.id}/export?kind=shopping`, { raw: true }); } catch (e) { out.value = e.message; }
  }

  function openBuild(p) {
    const s = sheet({ title: `Build ${p.name}`, subtitle: 'Take the parts out of your inventory.', size: 'md' });
    let count = p.builds;
    const preview = h('div.build-preview');
    const countStep = stepper({ value: count, label: 'Builds', onDelta: d => { count = Math.max(1, count + d); countStep.update(count); draw2(); }, onSet: v => { count = Math.max(1, v); countStep.update(count); draw2(); } });
    s.body.append(h('div.form-row', h('div.field', h('span.field-label', 'How many did you build?'), countStep)), preview);
    function draw2() {
      const use = new Map();
      for (const l of p.lines) {
        if (!l.part || l.part.stockLevel || (l.state !== 'auto' && l.state !== 'confirmed')) continue;
        const u = use.get(l.part.id) || { part: l.part, n: 0 };
        u.n += l.qty * count;
        use.set(l.part.id, u);
      }
      const unmatched = p.lines.filter(l => l.status === 'review' || (!l.part && l.status !== 'skip')).length;
      const levelled = p.lines.filter(l => l.part?.stockLevel && (l.state === 'auto' || l.state === 'confirmed')).length;
      clear(preview,
        unmatched > 0 && h('p.notice', icon('warn'), `${plural(unmatched, 'line')} ${unmatched === 1 ? 'isn’t' : 'aren’t'} matched to a part and won’t be counted.`),
        levelled > 0 && h('p.field-hint.build-hint', `${plural(levelled, 'part')} tracked as Plenty or Some ${levelled === 1 ? 'stays' : 'stay'} as ${levelled === 1 ? 'it is' : 'they are'}.`),
        h('div.build-list', [...use.values()].map(({ part, n }) => {
          const take = Math.min(part.qty, n);
          return h('div.build-item',
            h('span.build-name', part.name),
            h('span.build-change', take < n ? h('span.meta-warn', `only ${amt(part.qty, part)}`) : null, ` ${formatNumber(part.qty)} → ${amt(Math.round((part.qty - take) * 1000) / 1000, part)}`));
        })));
      go.disabled = use.size === 0;
    }
    const go = h('button.btn.btn-primary', { type: 'button', onclick: async () => {
      const r = await act(() => api(`/projects/${p.id}/build`, { method: 'POST', body: { count } }));
      if (!r) return;
      s.close();
      loadParts();
      if (p.status === 'idea' || p.status === 'planned') act(() => api(`/projects/${p.id}`, { method: 'PUT', body: { status: 'building' } }));
      toast(`Took parts for ${plural(count, 'build')} out of inventory.`, { action: 'Undo', timeout: 10000, onAction: () => undoBuild(r.build.id) });
    } }, icon('build'), 'Take parts out');
    s.footer.append(h('span'), h('div.footer-right', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'), go));
    draw2();
  }

  async function undoBuild(buildId) {
    try {
      await api(`/builds/${buildId}/undo`, { method: 'POST', body: {} });
      await loadParts();
      await load();
      toast('Parts put back.');
    } catch (e) { showError(e); }
  }

  load();
  return () => {};
}
