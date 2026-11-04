// "Export for chat": the inventory as text to paste into a conversation.
import { h, icon, api, toast, sheet, copyText, downloadUrl } from './lib.js';
import { state, costOn } from './state.js';

export function openExport() {
  const st = state.settings;
  const opts = { format: 'md', compact: st.exportCompact !== false, locations: st.exportIncludeLocations, notes: st.exportIncludeNotes, empty: st.exportIncludeEmpty, cost: false };
  const s = sheet({ title: 'Export for chat', subtitle: 'Paste this into a chat with Claude so project ideas use the parts you already have.', size: 'lg' });
  const out = h('textarea.input.export-area', { readOnly: true, rows: '14', spellcheck: 'false', 'aria-label': 'Export preview' });
  const meta = h('p.export-meta');

  const toggle = (key, label, cls = '') => h(`label.toggle-row${cls}`,
    h('input.switch', { type: 'checkbox', checked: opts[key], onchange: e => { opts[key] = e.target.checked; load(); } }),
    h('span', label));
  const compactToggle = toggle('compact', 'Group resistors and capacitors');
  const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Format' },
    [['md', 'For chat'], ['csv', 'CSV'], ['json', 'JSON']].map(([k, label]) => h('button.seg', {
      type: 'button', role: 'radio', 'aria-checked': String(opts.format === k),
      onclick: e => {
        opts.format = k;
        [...seg.children].forEach(b => b.setAttribute('aria-checked', String(b === e.currentTarget)));
        compactToggle.hidden = k !== 'md';
        load();
      },
    }, label)));

  s.body.append(
    h('div.export-controls', seg,
      h('div.export-toggles',
        compactToggle,
        toggle('notes', 'Notes'),
        toggle('locations', 'Locations'),
        toggle('empty', 'Parts with none left'),
        costOn() && toggle('cost', 'Unit costs'))),
    out, meta);

  const query = () => `format=${opts.format}&compact=${+opts.compact}&locations=${+opts.locations}&notes=${+opts.notes}&empty=${+opts.empty}&cost=${+opts.cost}`;
  async function load() {
    try {
      const text = await api(`/export/inventory?${query()}`, { raw: true });
      out.value = text;
      const kb = new Blob([text]).size / 1024;
      const lines = text.split('\n').filter(l => l.startsWith('- ')).length;
      meta.textContent = `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB${opts.format === 'md' ? `, ${lines} lines of parts, plus a note asking for BOMs in a format Particull imports` : ''}.`;
    } catch (e) { out.value = e.message; }
  }
  const copyBtn = h('button.btn.btn-primary', { type: 'button', onclick: async () => {
    const ok = await copyText(out.value);
    if (ok) { copyBtn.replaceChildren(icon('check'), 'Copied'); setTimeout(() => copyBtn.replaceChildren(icon('copy'), 'Copy'), 1600); } else toast("Couldn't copy. Select the text and copy it yourself.");
  } }, icon('copy'), 'Copy');
  s.footer.append(
    h('span'),
    h('div.footer-right',
      h('button.btn', { type: 'button', onclick: () => downloadUrl(`/api/export/inventory?${query()}&download=1`) }, icon('download'), 'Download'),
      copyBtn));
  load();
}
