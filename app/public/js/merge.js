// Combine duplicate parts into one.
import { h, clear, icon, api, toast, showError, sheet, isTouch, plural } from './lib.js';
import { state, loadParts } from './state.js';
import { formatStock, formatNumber, unitLabel } from '../shared/stock.js';

function combined(parts) {
  const levels = parts.map(p => p.stockLevel).filter(Boolean);
  if (levels.length) {
    const rank = { plenty: 3, some: 2, low: 1, out: 0 };
    const best = levels.sort((a, b) => rank[b] - rank[a])[0];
    return formatStock({ stockLevel: best });
  }
  const qty = Math.round(parts.reduce((s, p) => s + p.qty, 0) * 1000) / 1000;
  const unit = parts.find(p => p.unit)?.unit || '';
  const u = unitLabel(unit, qty);
  return u ? `${formatNumber(qty)} ${u}` : formatNumber(qty);
}

/**
 * @param {number[]} ids parts to merge (one id plus pickOther to choose the rest)
 * @param {{keep?: number, pickOther?: boolean, onDone?: Function}} o
 */
export async function openMerge(ids, { keep, pickOther = false, onDone } = {}) {
  let chosen = ids.map(id => state.byId.get(id)).filter(Boolean);
  if (pickOther) {
    const other = await pickDuplicate(chosen[0]);
    if (!other) return;
    chosen = [chosen[0], other];
  }
  if (chosen.length < 2) { toast('Pick at least two parts to merge.'); return; }
  let keepId = keep && chosen.some(p => p.id === keep) ? keep : chosen[0].id;

  const s = sheet({ title: `Merge ${plural(chosen.length, 'part')}`, subtitle: 'They become one part. Amounts add up, and the other names are kept so BOMs still match.', size: 'md' });
  const preview = h('div.merge-preview');
  const list = h('div.merge-list', { role: 'radiogroup', 'aria-label': 'Part to keep' });
  function draw() {
    clear(list, chosen.map(p => h('label.merge-option', { class: p.id === keepId ? 'is-keep' : '' },
      h('input', { type: 'radio', name: 'keep', checked: p.id === keepId, onchange: () => { keepId = p.id; draw(); } }),
      h('div.merge-main',
        h('span.merge-name', p.name),
        h('div.part-meta',
          h('span', formatStock(p)),
          p.package && h('span.meta-pkg', p.package),
          p.category && h('span.meta-cat', p.category),
          p.location && h('span.tape', p.location))),
      p.id === keepId && h('span.pill.pill-ok', 'Keep'))));
    const k = chosen.find(p => p.id === keepId);
    const others = chosen.filter(p => p.id !== keepId);
    clear(preview,
      h('p.field-label', 'Result'),
      h('div.merge-result',
        h('strong', k.name),
        h('span', combined(chosen)),
        h('span.merge-aka', `Also known as ${[...new Set([...others.map(p => p.name), ...chosen.flatMap(p => p.aliases || [])])].join(', ')}`)),
      h('p.field-hint', 'Empty fields on the kept part are filled from the others. Project lines that used any of them now use the kept part. This can’t be undone.'));
  }
  draw();
  s.body.append(h('p.field-label', 'Keep the name of'), list, preview);
  const go = h('button.btn.btn-primary', { type: 'button', onclick: async () => {
    go.disabled = true;
    try {
      const r = await api('/parts/merge', { method: 'POST', body: { keepId, ids: chosen.map(p => p.id).filter(id => id !== keepId) } });
      await loadParts();
      s.close();
      toast(`Merged into ${r.part.name}.`);
      onDone?.(r);
    } catch (e) { showError(e); go.disabled = false; }
  } }, icon('merge'), 'Merge');
  s.footer.append(h('span'), h('div.footer-right', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'), go));
}

/** Choose the duplicate to merge with, starting from parts with similar names. */
function pickDuplicate(part) {
  return new Promise(resolve => {
    let picked = null;
    const s = sheet({ title: `Merge ${part.name} with…`, size: 'md', footer: false, onClose: () => resolve(picked) });
    const search = h('input.search-input', { type: 'search', placeholder: 'Search your parts', autocomplete: 'off', 'aria-label': 'Search your parts' });
    const results = h('div.pick-list');
    s.body.append(h('label.search', icon('search'), search), results);
    let similar = [];
    const row = p => h('button.pick-row', { type: 'button', onclick: () => { picked = p; s.close(); } },
      h('div.pick-main', h('span.pick-name', p.name), h('div.part-meta', p.package && h('span.meta-pkg', p.package), p.location && h('span.tape', p.location))),
      h('div.pick-side', h('span.pick-qty', formatStock(p))));
    function draw() {
      const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) {
        clear(results, similar.length ? h('p.pick-label', 'Similar names') : h('p.pick-label', 'Search for the duplicate.'), similar.map(row));
        return;
      }
      const list = state.parts.filter(p => p.id !== part.id && terms.every(t => `${p.name} ${p.mpn} ${p.package} ${(p.aliases || []).join(' ')}`.toLowerCase().includes(t))).slice(0, 50);
      clear(results, list.length ? list.map(row) : h('p.pick-label', `Nothing matches “${search.value}”.`));
    }
    search.addEventListener('input', draw);
    draw();
    api('/similar', { method: 'POST', body: { name: part.name, mpn: part.mpn, package: part.package, exclude: part.id } })
      .then(r => { similar = r.matches.map(m => state.byId.get(m.id)).filter(Boolean); draw(); })
      .catch(() => {});
    if (!isTouch()) search.focus();
  });
}
