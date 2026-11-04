// Settings: appearance, cost tracking, export defaults, backups, categories and locations, data.
import { h, clear, icon, api, toast, showError, confirmSheet, promptSheet, menu, plural, downloadUrl, readFile, stepper } from './lib.js';
import { state, saveSettings, loadParts, onChange } from './state.js';
import { openPasteList } from './addmany.js';

const FREQUENCIES = [['off', 'Off'], ['6h', 'Every 6 hours'], ['daily', 'Daily'], ['weekly', 'Weekly']];

function when(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}, ${time}`;
}

/** "today at 3:00 AM", "on Nov 2 at 3:00 AM" for the middle of a sentence. */
function inline(iso) {
  const w = when(iso);
  return /^(Today|Yesterday)/.test(w) ? w.replace(/^\w+/, m => m.toLowerCase()).replace(',', ' at') : `on ${w.replace(',', ' at')}`;
}

function upcoming(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 864e5);
  if (diff === 0) return `today at ${time}`;
  if (diff === 1) return `tomorrow at ${time}`;
  return `on ${d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`;
}

function size(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hourLabel(hr) {
  const d = new Date();
  d.setHours(hr, 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function renderSettings(root) {
  let backups = null;
  let showAllBackups = false;

  const draw = () => {
    const st = state.settings;
    const sw = (key, label, hint) => h('label.setting',
      h('div.setting-text', h('span.setting-label', label), hint && h('span.setting-hint', hint)),
      h('input.switch', { type: 'checkbox', checked: st[key], onchange: async e => {
        try { await saveSettings({ [key]: e.target.checked }); } catch (err) { showError(err); e.target.checked = !e.target.checked; }
      } }));
    const seg = (label, key, options) => h('div.segmented', { role: 'radiogroup', 'aria-label': label },
      options.map(([k, text]) => h('button.seg', {
        type: 'button', role: 'radio', 'aria-checked': String(st[key] === k),
        onclick: () => saveSettings({ [key]: k }).then(() => key.startsWith('backup') && loadBackups()).catch(showError),
      }, text)));

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
          h('div.setting', h('div.setting-text', h('span.setting-label', 'Theme')), seg('Theme', 'theme', [['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']]))),

        backupCard(st, seg),

        h('section.settings-card',
          h('h2', 'Cost tracking'),
          sw('costTracking', 'Track what parts cost', 'Adds a unit cost to each part, an inventory total, and a cost estimate on projects. Off keeps prices out of sight.'),
          st.costTracking && h('label.setting',
            h('div.setting-text', h('span.setting-label', 'Currency symbol')),
            h('input.input.input-num', { value: st.currency, maxlength: '4', onchange: e => saveSettings({ currency: e.target.value }).catch(showError) }))),

        h('section.settings-card',
          h('h2', 'Export for chat'),
          h('p.setting-hint.card-hint', 'What “Export for chat” includes by default. You can change these each time you export.'),
          sw('exportCompact', 'Group resistors and capacitors', 'Lists a run like a resistor kit as one line, “E12 series 10Ω–1M”, instead of one line per value.'),
          sw('exportIncludeNotes', 'Include notes'),
          sw('exportIncludeLocations', 'Include locations', 'Usually not useful to Claude, and it makes the list longer.'),
          sw('exportIncludeEmpty', 'Include parts with none left')),

        group('category', 'Categories', state.groups.categories),
        group('location', 'Locations', state.groups.locations),

        h('section.settings-card',
          h('h2', 'Move your data'),
          h('p.setting-hint.card-hint', 'A JSON file with every part, project and setting, readable by other tools. Restoring one replaces everything here, after a safety backup.'),
          h('div.data-actions',
            h('button.btn', { type: 'button', onclick: () => downloadUrl('/api/backup') }, icon('download'), 'Download as JSON'),
            h('button.btn', { type: 'button', onclick: restoreJson }, icon('upload'), 'Restore from JSON'),
            h('button.btn', { type: 'button', onclick: importParts }, icon('file'), 'Import parts from a CSV'))),

        h('section.settings-card.about',
          h('h2', 'About'),
          h('p', `Particull ${state.session?.version || ''}. A rebuild of Binner, made for keeping track of maker parts and checking project BOMs against them.`),
          h('p', h('a', { href: 'https://github.com/au12/particull', target: '_blank', rel: 'noopener' }, 'github.com/au12/particull')),
          state.session?.passwordRequired && h('button.btn', { type: 'button', onclick: signOut }, icon('lock'), 'Sign out'))));
  };

  function backupCard(st, seg) {
    const keep = stepper({
      value: st.backupKeep, label: 'Scheduled backups to keep',
      onDelta: d => saveSettings({ backupKeep: Math.max(1, st.backupKeep + d) }).catch(showError),
      onSet: v => saveSettings({ backupKeep: Math.max(1, v) }).catch(showError),
    });
    const hour = h('select.input.select.select-sm', { 'aria-label': 'Time of day', onchange: e => saveSettings({ backupHour: Number(e.target.value) }).then(loadBackups).catch(showError) },
      Array.from({ length: 24 }, (_, i) => h('option', { value: String(i), selected: i === st.backupHour }, hourLabel(i))));
    const list = backups?.backups || [];
    const shown = showAllBackups ? list : list.slice(0, 5);
    let status = '';
    if (backups) {
      if (st.backupFrequency === 'off') status = 'Scheduled backups are off. Backups are still made before every restore.';
      else if (backups.next) status = `Next backup ${new Date(backups.next) <= new Date(Date.now() + 60e3) ? 'in a few minutes' : upcoming(backups.next)}.`;
    }
    return h('section.settings-card',
      h('h2', 'Backups'),
      h('p.setting-hint.card-hint', 'Copies of the whole database, saved in the container’s /data/backups folder. A copy is also made before any restore, so a restore can be undone.'),
      h('div.setting.setting-stack',
        h('div.setting-text', h('span.setting-label', 'Back up automatically')),
        seg('Backup frequency', 'backupFrequency', FREQUENCIES)),
      (st.backupFrequency === 'daily' || st.backupFrequency === 'weekly') && h('label.setting',
        h('div.setting-text', h('span.setting-label', st.backupFrequency === 'weekly' ? 'On Sundays at' : 'At'), h('span.setting-hint', 'In the container’s time zone.')),
        hour),
      st.backupFrequency !== 'off' && h('div.setting',
        h('div.setting-text', h('span.setting-label', 'Scheduled backups to keep'), h('span.setting-hint', 'Older ones are deleted. Backups you make by hand are kept until you delete them.')),
        keep),
      backups?.lastError && h('p.notice', icon('warn'), `The last scheduled backup failed: ${backups.lastError}`),
      status && h('p.setting-hint.backup-status', status),
      h('div.data-actions',
        h('button.btn', { type: 'button', onclick: backupNow }, icon('database'), 'Back up now'),
        h('button.btn.btn-quiet', { type: 'button', onclick: restoreFile }, icon('upload'), 'Restore from a .db file')),
      backups == null
        ? h('p.setting-hint', 'Loading backups…')
        : list.length === 0
          ? h('p.setting-hint.backup-empty', 'No backups yet.')
          : h('div.backup-list',
            shown.map(b => h('div.backup-item',
              h('div.backup-main', h('span.backup-when', when(b.createdAt)), h('span.backup-meta', `${b.label}, ${size(b.size)}`)),
              h('button.icon-btn.icon-btn-sm', { type: 'button', 'aria-label': `Actions for the backup from ${when(b.createdAt)}`, onclick: e => menu(e.currentTarget, [
                { label: 'Restore this backup', icon: 'refresh', action: () => restoreBackup(b) },
                { label: 'Download', icon: 'download', action: () => downloadUrl(`/api/backups/${encodeURIComponent(b.name)}`) },
                '-',
                { label: 'Delete', icon: 'trash', danger: true, action: () => deleteBackup(b) },
              ]) }, icon('more')))),
            list.length > 5 && h('button.btn.btn-quiet.btn-sm.backup-more', { type: 'button', onclick: () => { showAllBackups = !showAllBackups; draw(); } },
              showAllBackups ? 'Show fewer' : `Show all ${list.length}`)));
  }

  async function loadBackups() {
    try { backups = await api('/backups'); } catch (e) { backups = { backups: [], lastError: e.message }; }
    draw();
  }

  async function backupNow() {
    try {
      const r = await api('/backups', { method: 'POST', body: {} });
      backups = { ...backups, backups: r.backups };
      toast('Backup saved.');
      draw();
    } catch (e) { showError(e); }
  }

  async function afterRestore(message) {
    await loadParts();
    state.settings = await api('/settings');
    toast(message, { timeout: 8000 });
    loadBackups();
  }

  async function restoreBackup(b) {
    const ok = await confirmSheet({
      title: 'Restore this backup?',
      message: `Everything goes back to how it was ${inline(b.createdAt)}. A backup of how things are now is saved first, so you can come back.`,
      confirm: 'Restore backup', danger: true,
    });
    if (!ok) return;
    try {
      const r = await api(`/backups/${encodeURIComponent(b.name)}/restore`, { method: 'POST', body: {} });
      await afterRestore(`Restored ${plural(r.parts, 'part')} and ${plural(r.projects, 'project')}.`);
    } catch (e) { showError(e); }
  }

  async function deleteBackup(b) {
    const ok = await confirmSheet({ title: 'Delete this backup?', message: `The backup from ${inline(b.createdAt)} is removed from the server.`, confirm: 'Delete backup', danger: true });
    if (!ok) return;
    try {
      const r = await api(`/backups/${encodeURIComponent(b.name)}`, { method: 'DELETE' });
      backups = { ...backups, backups: r.backups };
      draw();
    } catch (e) { showError(e); }
  }

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

  async function restoreFile() {
    const f = await pickFile('.db,.sqlite,.sqlite3,application/vnd.sqlite3,application/octet-stream');
    if (!f) return;
    const ok = await confirmSheet({
      title: 'Replace everything with this file?',
      message: `Everything here is replaced with the contents of ${f.name}. A backup of how things are now is saved first.`,
      confirm: 'Restore file', danger: true,
    });
    if (!ok) return;
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const r = await api('/backups/upload', { method: 'POST', body: { data: btoa(bin) } });
      await afterRestore(`Restored ${plural(r.parts, 'part')} and ${plural(r.projects, 'project')}.`);
    } catch (e) { showError(e); }
  }

  async function restoreJson() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    let data;
    try { data = JSON.parse(await readFile(f)); } catch { toast('That file isn’t a Particull backup.', { kind: 'error' }); return; }
    const ok = await confirmSheet({
      title: 'Replace everything with this file?',
      message: `The file has ${plural(data.parts?.length || 0, 'part')} and ${plural(data.projects?.length || 0, 'project')}. Everything here now is replaced. A backup of how things are now is saved first.`,
      confirm: 'Restore file', danger: true,
    });
    if (!ok) return;
    try {
      const r = await api('/restore', { method: 'POST', body: data });
      await afterRestore(`Restored ${plural(r.parts, 'part')} and ${plural(r.projects, 'project')}.`);
    } catch (e) { showError(e); }
  }

  async function importParts() {
    const f = await pickFile('.csv,.tsv,.txt,.md,text/*');
    if (!f) return;
    try { openPasteList(await readFile(f)); } catch (e) { showError(e); }
  }

  async function signOut() {
    await api('/logout', { method: 'POST', body: {} }).catch(() => {});
    try { await caches.delete('particull-api'); } catch { /* no cache API */ }
    location.reload();
  }

  draw();
  loadBackups();
  return onChange(what => { if (what === 'settings' || what === 'parts') draw(); });
}
