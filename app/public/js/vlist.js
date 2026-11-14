// Draws only the rows on screen, so a list of thousands of parts stays quick. The page
// scrolls as usual; the list reserves its full height and places the visible rows in it.
//
// Items are { key, height, sig, render() }. A row is drawn again when its sig changes.

const typingIn = node => {
  const a = document.activeElement;
  return a && a !== node && node.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
};

export function virtualList(host, { overscan = 8 } = {}) {
  let items = [];
  let tops = [];
  const live = new Map();
  let frame = 0;

  function indexAt(y) {
    // The first item whose bottom edge is below y.
    let lo = 0, hi = items.length - 1, found = items.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] + items[mid].height > y) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return found;
  }

  function range() {
    if (!items.length || !host.isConnected) return [0, 0];
    const r = host.getBoundingClientRect();
    const from = Math.max(0, -r.top);
    const to = Math.max(0, window.innerHeight - r.top);
    return [Math.max(0, indexAt(from) - overscan), Math.min(items.length, indexAt(to) + 1 + overscan)];
  }

  function place(it, node) {
    node._sig = it.sig;
    node._key = it.key;
    node.classList.add('vl-item');
    return node;
  }

  function draw() {
    cancelAnimationFrame(frame);
    frame = 0;
    const [start, end] = range();
    const want = new Set();
    let prev = null;
    for (let i = start; i < end; i++) {
      const it = items[i];
      want.add(it.key);
      let node = live.get(it.key);
      if (node && node._sig !== it.sig && !typingIn(node)) {
        const hadFocus = document.activeElement === node;
        const fresh = place(it, it.render());
        node.replaceWith(fresh);
        live.set(it.key, fresh);
        node = fresh;
        if (hadFocus) node.focus({ preventScroll: true });
      }
      if (!node) {
        node = place(it, it.render());
        live.set(it.key, node);
      }
      const top = `${tops[i]}px`;
      if (node.style.top !== top) node.style.top = top;
      // Keep the document order the same as the order on screen, for keyboard and screen readers.
      const next = prev ? prev.nextSibling : host.firstChild;
      if (node !== next) host.insertBefore(node, next);
      prev = node;
    }
    for (const [key, node] of live) {
      if (want.has(key) || node.contains(document.activeElement)) continue;
      node.remove();
      live.delete(key);
    }
  }

  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });

  return {
    /** Replace the items. Rows whose key and sig are unchanged stay as they are. */
    setItems(next) {
      items = next;
      tops = new Array(items.length);
      let y = 0;
      for (let i = 0; i < items.length; i++) { tops[i] = y; y += items[i].height; }
      host.style.height = `${y}px`;
      const keys = new Set(items.map(it => it.key));
      for (const [key, node] of live) {
        if (!keys.has(key)) { node.remove(); live.delete(key); }
      }
      draw();
    },
    draw,
    get length() { return items.length; },
    indexOf: key => items.findIndex(it => it.key === key),
    node: key => live.get(key) || null,
    /** Mark a row as drawn with this sig, after changing it in place. */
    touch(key, sig) { const n = live.get(key); if (n) n._sig = sig; },
    /**
     * Scroll just enough to show an item, below anything pinned to the top of the window.
     * @param {number} i index
     * @param {{top?: number, bottom?: number}} insets pixels covered at the top and bottom
     */
    reveal(i, { top = 0, bottom = 0 } = {}) {
      if (i < 0 || i >= items.length) return;
      const r = host.getBoundingClientRect();
      const itemTop = r.top + tops[i];
      const itemBottom = itemTop + items[i].height;
      if (itemTop < top + 4) window.scrollBy(0, itemTop - top - 8);
      else if (itemBottom > window.innerHeight - bottom - 4) window.scrollBy(0, itemBottom - (window.innerHeight - bottom) + 8);
      draw();
    },
    destroy() {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      live.clear();
    },
  };
}
