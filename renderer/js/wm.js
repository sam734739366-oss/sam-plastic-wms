// ===== مدير النوافذ الداخلي =====
// كل صفحة تُفتح كنافذة مستقلة فوق سطح المكتب، بأزرار تصغير/تكبير/إغلاق،
// ولكل نافذة زر في شريط المهام السفلي يبقى ظاهراً باسمها عند تصغيرها.
import { getDef } from './router.js';
import { esc, explainDialog } from './ui.js';
import { helpFor } from './help.js';

let desktopEl = null, taskbarEl = null;
const wins = new Map();
let zTop = 100, cascade = 0;

export function initWM(desktop, taskbar) {
  desktopEl = desktop;
  taskbarEl = taskbar;
}

function placeNew(el) {
  const dw = desktopEl.clientWidth, dh = desktopEl.clientHeight;
  const w = Math.min(1080, Math.max(360, dw - 26));
  const h = Math.min(720, Math.max(320, dh - 26));
  const off = (cascade % 8) * 22;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.left = `${12 + off}px`;
  el.style.top = `${10 + off}px`;
}

function focusWin(win) {
  if (win.el.classList.contains('min')) {
    win.el.classList.remove('min');
    win.tb.classList.remove('min');
  }
  for (const w of wins.values()) {
    const on = w === win;
    w.el.classList.toggle('active', on);
    w.tb.classList.toggle('active', on);
  }
  zTop += 1;
  win.el.style.zIndex = zTop;
  window.dispatchEvent(new CustomEvent('wm:focus', { detail: { name: win.name } }));
}

function topVisible() {
  let top = null;
  for (const w of wins.values()) {
    if (w.el.classList.contains('min')) continue;
    if (!top || Number(w.el.style.zIndex) > Number(top.el.style.zIndex)) top = w;
  }
  return top;
}

function minimizeWin(win) {
  win.el.classList.add('min');
  win.tb.classList.add('min');
  const t = topVisible();
  if (t) focusWin(t);
  else window.dispatchEvent(new CustomEvent('wm:focus', { detail: { name: null } }));
}

function toggleMax(win) {
  const el = win.el;
  if (el.classList.contains('max')) {
    el.classList.remove('max');
    el.style.left = win.prev.left; el.style.top = win.prev.top;
    el.style.width = win.prev.width; el.style.height = win.prev.height;
    el.querySelector('.wc-max').textContent = '□';
  } else {
    win.prev = { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
    el.classList.add('max');
    el.querySelector('.wc-max').textContent = '❐';
  }
  focusWin(win);
}

function closeWin(win) {
  win.el.remove();
  win.tb.remove();
  wins.delete(win.name);
  const t = topVisible();
  if (t) focusWin(t);
  else window.dispatchEvent(new CustomEvent('wm:focus', { detail: { name: null } }));
}

async function mountInto(win) {
  const def = getDef(win.name);
  win.body.innerHTML = '';
  try {
    await def.mount(win.body);
  } catch (e) {
    win.body.innerHTML = `<p class="error">تعذر تحميل الصفحة: ${esc(String(e?.message || e))}</p>`;
  }
}

export function openWindow(name, opts = {}) {
  const def = getDef(name);
  if (!def || !desktopEl) return;
  const existing = wins.get(name);
  if (existing) {
    if (opts.refresh) mountInto(existing);
    focusWin(existing);
    return;
  }

  const el = document.createElement('section');
  el.className = 'win';
  el.innerHTML = `
    <header class="win-bar">
      <span class="win-title"><span class="win-dot"></span>${esc(def.title)}</span>
      <span class="win-controls">
        <button class="wc wc-help" title="شرح العملية">؟</button>
        <button class="wc wc-min" title="تصغير">─</button>
        <button class="wc wc-max" title="تكبير / استعادة">□</button>
        <button class="wc wc-close" title="إغلاق">✕</button>
      </span>
    </header>
    <div class="win-body"></div>`;
  const bar = el.querySelector('.win-bar');
  const body = el.querySelector('.win-body');

  const tb = document.createElement('button');
  tb.className = 'tb-btn';
  tb.innerHTML = `<span class="tb-dot"></span><span class="tb-label">${esc(def.title)}</span>`;

  const win = { name, el, tb, body, prev: null };
  wins.set(name, win);
  desktopEl.appendChild(el);
  taskbarEl.appendChild(tb);
  placeNew(el);
  cascade += 1;

  mountInto(win);

  // سحب النافذة من شريط العنوان
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.wc')) return;
    focusWin(win);
    if (el.classList.contains('max')) return;
    const rect = desktopEl.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const ol = el.offsetLeft, ot = el.offsetTop;
    const move = (ev) => {
      let nl = ol + (ev.clientX - startX);
      let nt = ot + (ev.clientY - startY);
      nl = Math.max(-el.offsetWidth + 110, Math.min(nl, rect.width - 110));
      nt = Math.max(0, Math.min(nt, rect.height - 42));
      el.style.left = `${nl}px`;
      el.style.top = `${nt}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  bar.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.wc')) toggleMax(win);
  });
  el.addEventListener('mousedown', () => focusWin(win));

  el.querySelector('.wc-min').onclick = () => minimizeWin(win);
  el.querySelector('.wc-max').onclick = () => toggleMax(win);
  el.querySelector('.wc-close').onclick = () => closeWin(win);
  el.querySelector('.wc-help').onclick = () => {
    const h = helpFor(win.name);
    explainDialog(h.title, h.lines);
  };

  tb.onclick = () => {
    if (el.classList.contains('min')) focusWin(win);
    else if (el.classList.contains('active')) minimizeWin(win);
    else focusWin(win);
  };

  focusWin(win);
  return win;
}
