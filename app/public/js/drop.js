// Bring a list in by dropping a file on the page, or pasting while not typing in a field.
import { h, icon, isTyping, readFile, showError } from './lib.js';

const TEXT_NAME = /\.(csv|tsv|txt|md|markdown|json|bom|xml|net)$/i;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

async function readText(file) {
  if (!TEXT_NAME.test(file.name) && file.type && !/^text\/|json|xml|csv/.test(file.type)) {
    throw new Error(`${file.name} isn’t a text file. Drop a CSV, a KiCad BOM or a text list.`);
  }
  return readFile(file);
}

/**
 * While a page is shown: a file dropped anywhere on it, or text pasted while you aren't
 * typing in a field, goes to onText(text, fileName).
 * @returns {() => void} stop listening
 */
export function acceptDropAndPaste({ title, hint = 'A CSV, a KiCad BOM, or one part per line', onText }) {
  let overlay = null;
  let depth = 0;
  const busy = () => Boolean(document.querySelector('dialog[open]'));

  const show = () => {
    if (overlay) return;
    overlay = h('div.drop-overlay', { 'aria-hidden': 'true' }, h('div.drop-card', icon('file'), h('strong', title), h('span', hint)));
    document.body.append(overlay);
  };
  const hide = () => { overlay?.remove(); overlay = null; depth = 0; };

  const onEnter = e => {
    if (!hasFiles(e) || busy()) return;
    depth++;
    show();
  };
  // A file dropped where nothing takes it would replace the page, so always claim it.
  const onOver = e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = busy() ? 'none' : 'copy';
  };
  const onLeave = () => {
    if (!overlay) return;
    depth--;
    if (depth <= 0) hide();
  };
  const onDrop = async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (busy()) return;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    try { onText(await readText(file), file.name); } catch (err) { showError(err); }
  };
  const onPaste = e => {
    if (isTyping() || busy()) return;
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!text.trim()) return;
    e.preventDefault();
    onText(text, null);
  };

  document.addEventListener('dragenter', onEnter);
  document.addEventListener('dragover', onOver);
  document.addEventListener('dragleave', onLeave);
  document.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);
  return () => {
    hide();
    document.removeEventListener('dragenter', onEnter);
    document.removeEventListener('dragover', onOver);
    document.removeEventListener('dragleave', onLeave);
    document.removeEventListener('drop', onDrop);
    document.removeEventListener('paste', onPaste);
  };
}

/**
 * A text box you can also drop a file onto, with a row of tools under it.
 * @param {HTMLTextAreaElement} textarea
 * @param {Array<Node>} tools buttons for the row under the box
 * @param {string} hint quiet text at the end of that row
 */
export function dropArea(textarea, tools = [], hint = '') {
  const zone = h('div.dropzone', textarea, h('div.dropzone-bar', tools, hint && h('span.dropzone-hint', hint)));
  zone.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-over'); });
  zone.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('is-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    try {
      textarea.value = await readText(file);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) { showError(err); }
  });
  return zone;
}
