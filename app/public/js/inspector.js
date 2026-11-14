// The selected part's details, beside the list on wide screens. Changes save as you type.
import { h, clear, icon, api, menu, kbd, modKey, formatWhen } from './lib.js';
import { state, upsertParts, onChange } from './state.js';
import { partForm, partExtras, formFields, deletePartFlow } from './editor.js';
import { openMerge } from './merge.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createInspector({ onClose = () => {} } = {}) {
  const el = h('aside.inspector', { 'aria-label': 'Part details' });
  let part = null;
  let form = null;
  let extras = null;
  let saved = null;
  let timer = null;
  let inflight = 0;
  let chain = Promise.resolve();
  let statusEl = null;
  let statusTimer = null;

  function empty() {
    part = null; form = null; extras = null; saved = null;
    clear(el, h('div.insp-empty',
      icon('inspector'),
      h('h2', 'No part selected'),
      h('p', 'Choose a part to see its details here. Changes save as you go.'),
      h('div.insp-keys',
        h('span', kbd('↑'), kbd('↓')), h('span', 'Move between parts'),
        h('span', kbd('/')), h('span', 'Search'),
        h('span', kbd('N')), h('span', 'Add a part'),
        h('span', kbd(modKey()), kbd('K')), h('span', 'Jump to anything'),
        h('span', kbd('?')), h('span', 'All shortcuts'))));
  }

  function setStatus(kind, text) {
    if (!statusEl) return;
    clearTimeout(statusTimer);
    statusEl.className = `save-state${kind ? ` is-${kind}` : ''}`;
    if (kind === 'saving') clear(statusEl, 'Saving…');
    else if (kind === 'saved') {
      clear(statusEl, icon('check'), 'Saved');
      statusTimer = setTimeout(() => setStatus(''), 2200);
    } else if (kind === 'error') clear(statusEl, icon('warn'), text);
    else if (part) clear(statusEl, `Changed ${formatWhen(state.byId.get(part.id)?.updatedAt || part.updatedAt).replace(/^(Today|Yesterday)/, m => m.toLowerCase())}`);
  }

  function show(p) {
    if (!p) { empty(); return; }
    if (part?.id === p.id) return;
    if (timer) save();
    part = p;
    saved = formFields(p);
    form = partForm(p, {
      editing: true,
      partId: p.id,
      moreOpen: false,
      onEdit: key => {
        clearTimeout(timer);
        // Clicks save right away; typing saves after a short pause.
        const typing = document.activeElement?.matches('input:not(.stepper-value), textarea');
        timer = setTimeout(save, key === 'aliases' || !typing ? 200 : 650);
      },
      onSubmit: () => save(),
      actions: { merge: top => { save(); openMerge([p.id, top.id], { keep: top.id }); } },
    });
    // Leaving a field saves it without waiting.
    form.el.addEventListener('focusout', () => { if (timer) save(); });
    extras = partExtras(p.id);
    statusEl = h('span.save-state');
    const moreBtn = h('button.icon-btn.icon-btn-sm', { type: 'button', 'aria-label': 'More actions for this part', onclick: e => menu(e.currentTarget, [
      { label: 'Merge with a duplicate…', icon: 'merge', action: () => { save(); openMerge([p.id], { keep: p.id, pickOther: true }); } },
      '-',
      { label: 'Delete part', icon: 'trash', danger: true, action: () => deletePartFlow(state.byId.get(p.id) || p, { onDone: () => { empty(); onClose(); } }) },
    ]) }, icon('more'));
    clear(el,
      h('div.insp-head',
        h('span.insp-kicker', 'Part details'),
        moreBtn,
        h('button.icon-btn.icon-btn-sm', { type: 'button', 'aria-label': 'Close details', title: 'Close (Esc)', onclick: () => { if (timer) save(); empty(); onClose(); } }, icon('x'))),
      h('div.insp-body', form.el, h('div.insp-extras', extras)),
      h('div.insp-foot', statusEl));
    setStatus('');
  }

  /** Save what's changed. Saves run one after another, so they land in order. */
  function save() {
    clearTimeout(timer);
    timer = null;
    if (!part || !form) return chain;
    const id = part.id;
    const values = form.values();
    const fields = form.current();
    if (!values.name) {
      form.name.classList.add('invalid');
      setStatus('error', 'Give the part a name to save it.');
      return chain;
    }
    form.name.classList.remove('invalid');
    if (same(fields, saved)) return chain;
    const before = saved;
    saved = fields;
    inflight++;
    setStatus('saving');
    chain = chain.then(async () => {
      try {
        const r = await api(`/parts/${id}`, { method: 'PUT', body: values });
        inflight--;
        if (part?.id === id) {
          saved = formFields(r);
          setStatus('saved');
          extras?.refresh();
        }
        upsertParts([r]);
      } catch (e) {
        inflight--;
        if (part?.id === id) {
          saved = before;
          setStatus('error', `Couldn’t save: ${e.message}`);
        }
      }
    });
    return chain;
  }

  // Someone changed the part elsewhere (the list, an undo, another device): take the new
  // values for fields you haven't touched, unless your own save is still on its way.
  function external(p) {
    if (!part || !form || p?.id !== part.id || timer || inflight) return;
    form.sync(p, saved);
    saved = formFields(p);
    if (!statusEl?.classList.contains('is-saving') && !statusEl?.classList.contains('is-saved')) setStatus('');
  }

  const off = onChange(what => {
    if (!part) return;
    const p = state.byId.get(part.id);
    if (!p) { empty(); onClose(); return; }
    if (what === 'parts' || what === 'undo') {
      external(p);
      if (what === 'undo') extras?.load();
    }
  });

  empty();
  return {
    el,
    show,
    clear: () => { if (timer) save(); empty(); },
    external,
    save,
    get partId() { return part?.id ?? null; },
    destroy() { if (timer) save(); off(); },
  };
}
