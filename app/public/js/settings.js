// Settings: appearance, cost tracking, export defaults, categories and locations, backups.
import { h, clear, icon, api, toast, showError, confirmSheet, promptSheet, plural, downloadUrl, readFile } from './lib.js';
import { state, saveSettings, loadParts, onChange } from './state.js';
import { openPasteList } from './parts.js';

export function renderSettings(root) {
  const draw = () => {
    const st = state.settings;
    const sw = (key, label, hint) => h('label.setting',
      h('div.setting-text', h('span.setting-label', label), hint && h('span.setting-hint', hint)),
      h('input.switch', { type: 'checkbox', checked: st[key], onchange: async e => {
        try { await saveSettings({ [key]: e.target.checked }); } catch (err) { showError(err); e.target.checked = !e.target.checked; }
      } }));

    const theme = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Theme' },
      [['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([k, label]) => h('button.seg', {
        type: 'button', role: 'radio', 'aria-checked': String(st.theme === k),
        onclick: () => saveSettings({ theme: k }).catch(showError),
      }, label)));

    const group = (field, title, list) => h('section.settings-card',
      h('h2', title),
      list.length
        ? h('div.group-list', list.map(g => h('div.group-item',
          h('span.group-name', field === 'location' ? h('span.tape', g.name) : g.name),
          h('span.group-meta', plural(g.parts, 'part')),
          h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => rename(field, g.name, list) }, 'Rename'))))
        : h('p.setting-hint', field === 'category' ? 'Categories appear here once your parts have them.' : 'Locations appear here once your parts have them.'));

    clear(root,
      h('header.page-head', h('div', h('h1', 'Settings'))),
      h('div.settings',
        h('section.settings-card',
          h('h2', 'Appearance'),
          h('div.setting', h('div.setting-text', h('span.setting-label', 'Theme')), theme)),

        h('section.settings-card',
          h('h2', 'Cost tracking'),
          sw('costTracking', 'Track what parts cost', 'Adds a unit cost to each part, an inventory total, and a cost estimate on projects. Off keeps prices out of sight.'),
          st.costTracking && h('label.setting',
            h('div.setting-text', h('span.setting-label', 'Currency symbol')),
            h('input.input.input-num', { value: st.currency, maxlength: '4', onchange: e => saveSettings({ currency: e.target.value }).catch(showError) }))),

        h('section.settings-card',
          h('h2', 'Export for chat'),
          h('p.setting-hint.card-hint', 'What “Export for chat” includes by default. You can change these each time you export.'),
          sw('exportIncludeNotes', 'Include notes'),
          sw('exportIncludeLocations', 'Include locations', 'Usually not useful to Claude, and it makes the list longer.'),
          sw('exportIncludeEmpty', 'Include parts with none left')),

        group('category', 'Categories', state.groups.categories),
        group('location', 'Locations', state.groups.locations),

        h('section.settings-card',
          h('h2', 'Your data'),
          h('p.setting-hint.card-hint', 'Everything lives in one SQLite file in the container’s /data folder. A backup file holds all parts, projects and settings.'),
          h('div.data-actions',
            h('button.btn', { type: 'button', onclick: () => downloadUrl('/api/backup') }, icon('download'), 'Download backup'),
            h('button.btn', { type: 'button', onclick: restore }, icon('upload'), 'Restore a backup'),
            h('button.btn', { type: 'button', onclick: importParts }, icon('file'), 'Import parts from a CSV'))),

        h('section.settings-card.about',
          h('h2', 'About'),
          h('p', `Particull ${state.session?.version || ''}. A rebuild of Binner, made for keeping track of maker parts and checking project BOMs against them.`),
          h('p', h('a', { href: 'https://github.com/au12/particull', target: '_blank', rel: 'noopener' }, 'github.com/au12/particull')),
          state.session?.passwordRequired && h('button.btn', { type: 'button', onclick: signOut }, icon('lock'), 'Sign out'))));
  };

  async function rename(field, from, list) {
    const to = await promptSheet({ title: `Rename ${field}`, label: `New name for “${from}”. Use an existing name to merge them.`, value: from, confirm: 'Rename', list: list.map(g => g.name).filter(n => n !== from) });
    if (to == null || to === from) return;
    try {
      const r = await api('/groups/rename', { method: 'POST', body: { field, from, to } });
      await loadParts();
      toast(`${plural(r.changed, 'part')} updated.`);
    } catch (e) { showError(e); }
  }

  function pickFile(accept) {
    return new Promise(resolve => {
      const input = h('input', { type: 'file', accept, hidden: true, onchange: () => { resolve(input.files[0] || null); input.remove(); } });
      document.body.append(input);
      input.click();
    });
  }

  async function restore() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    let data;
    try { data = JSON.parse(await readFile(f)); } catch { toast('That file isn’t a Particull backup.', { kind: 'error' }); return; }
    const ok = await confirmSheet({
      title: 'Replace everything with this backup?',
      message: `The backup has ${plural(data.parts?.length || 0, 'part')} and ${plural(data.projects?.length || 0, 'project')}. Everything here now is replaced. Download a backup first if you might want it.`,
      confirm: 'Restore backup', danger: true,
    });
    if (!ok) return;
    try {
      const r = await api('/restore', { method: 'POST', body: data });
      await loadParts();
      state.settings = await api('/settings');
      toast(`Restored ${plural(r.parts, 'part')} and ${plural(r.projects, 'project')}.`);
      draw();
    } catch (e) { showError(e); }
  }

  async function importParts() {
    const f = await pickFile('.csv,.tsv,.txt,.md,text/*');
    if (!f) return;
    try { openPasteList(await readFile(f)); } catch (e) { showError(e); }
  }

  async function signOut() {
    await api('/logout', { method: 'POST', body: {} }).catch(() => {});
    location.reload();
  }

  draw();
  return onChange(what => { if (what === 'settings' || what === 'parts') draw(); });
}
