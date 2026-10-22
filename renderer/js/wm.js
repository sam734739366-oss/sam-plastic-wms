// ===== مدير النوافذ الداخلي =====
// الصفحات الرئيسية ثابتة داخل البرنامج (#screen) ولا تمر من هنا.
// هذا المدير يفتح النوافذ المنبثقة فقط (الفواتير والسندات والنماذج) فوقها،
// بأزرار تصغير/تكبير/إغلاق، ولكل نافذة زر في شريط المهام السفلي يبقى ظاهراً
// باسمها عند تصغيرها، ويمكن فتح أكثر من منبثقة في نفس الوقت.
// كما يفتح دليل المستخدم كنافذة مستقلة من زر الدليل في الصفحة الرئيسية.
import { getDef } from './router.js';
import { esc, explainDialog, setPopupOpener } from './ui.js';
import { helpFor } from './help.js';

let desktopEl = null, taskbarEl = null;
const wins = new Map();
const pops = new Map();
let zTop = 100, cascade = 0, popCount = 0;

export function initWM(desktop, taskbar) {
  desktopEl = desktop;
  taskbarEl = taskbar;
  setPopupOpener((title, bodyHtml, buttons) => openPopup({ title, bodyHtml, buttons }));
}

function all() { return [...wins.values(), ...pops.values()]; }

// يُظهر شريط المهام فقط عند وجود نوافذ (منبثقات أو دليل) مفتوحة
function syncTaskbar() {
  if (taskbarEl) taskbarEl.classList.toggle('has-wins', taskbarEl.children.length > 0);
}

function placeNew(el, { small = false } = {}) {
  const dw = desktopEl.clientWidth, dh = desktopEl.clientHeight;
  const w = small ? Math.min(1080, Math.max(420, dw - 40)) : Math.min(1080, Math.max(360, dw - 26));
  const h = Math.min(720, Math.max(320, dh - 26));
  const off = (cascade % 8) * 22;
  el.style.width = `${w}px`;
  el.style.left = `${12 + off}px`;
  el.style.top = `${10 + off}px`;
  if (small) {
    // المنبثقات: ارتفاع تلقائي حسب المحتوى (بحد أقصى عبر CSS)
    el.style.left = `${Math.max(14, (dw - w) / 2 + off - 60)}px`;
    el.style.top = `${Math.max(8, 26 + off)}px`;
  } else {
    el.style.height = `${h}px`;
  }
}

function focusWin(win) {
  if (win.el.classList.contains('min')) {
    win.el.classList.remove('min');
    win.tb.classList.remove('min');
  }
  for (const w of all()) {
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
  for (const w of all()) {
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
  const el = win.el;
  if (el.remove.__native) el.remove = el.remove.__native;
  el.remove();
  win.tb.remove();
  win.map.delete(win.name);
  syncTaskbar();
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

// ربط سلوك النافذة (سحب، تصغير، تكبير، إغلاق، زر شريط المهام) بعنصر نافذة
function wireWindow(win, { dragHandle }) {
  const el = win.el;
  const bar = dragHandle || el.querySelector('.win-bar');
  if (bar) {
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.wc, .mh-close, button')) return;
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
      if (!e.target.closest('.wc, .mh-close, button')) toggleMax(win);
    });
  }
  el.addEventListener('mousedown', () => focusWin(win));

  el.querySelector('.wc-min').onclick = () => minimizeWin(win);
  el.querySelector('.wc-max').onclick = () => toggleMax(win);
  const closeBtn = el.querySelector('.wc-close') || el.querySelector('.mh-close');
  closeBtn.onclick = () => closeWin(win);

  win.tb.onclick = () => {
    if (el.classList.contains('min')) focusWin(win);
    else if (el.classList.contains('active')) minimizeWin(win);
    else focusWin(win);
  };

  focusWin(win);
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
  const body = el.querySelector('.win-body');

  const tb = document.createElement('button');
  tb.className = 'tb-btn';
  tb.innerHTML = `<span class="tb-dot"></span><span class="tb-label">${esc(def.title)}</span>`;

  const win = { name, el, tb, body, prev: null, map: wins };
  wins.set(name, win);
  desktopEl.appendChild(el);
  taskbarEl.appendChild(tb);
  syncTaskbar();
  placeNew(el);
  cascade += 1;

  mountInto(win);
  wireWindow(win, { dragHandle: el.querySelector('.win-bar') });

  el.querySelector('.wc-help').onclick = () => {
    const h = helpFor(win.name);
    explainDialog(h.title, h.lines);
  };
  return win;
}

// نافذة منبثقة (فواتير، سندات، نماذج) — يمكن فتح أكثر من واحدة في نفس الوقت
export function openPopup({ title, bodyHtml, buttons = [] }) {
  if (!desktopEl) return null;
  popCount += 1;
  const name = `pop:${popCount}`;

  const el = document.createElement('section');
  el.className = 'win pop';
  el.innerHTML = `
    <header class="win-bar">
      <span class="win-title"><span class="win-dot"></span>${esc(title)}</span>
      <span class="win-controls">
        <button class="wc wc-min" title="تصغير">─</button>
        <button class="wc wc-max" title="تكبير / استعادة">□</button>
        <button class="wc wc-close mh-close" title="إغلاق">✕</button>
      </span>
    </header>
    <div class="win-body pop-body"><div class="modal-body">${bodyHtml}</div></div>
    <div class="modal-foot actions"></div>`;

  const body = el.querySelector('.modal-body');
  const act = el.querySelector('.actions');
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = `btn ${b.class || ''}`; btn.textContent = b.label;
    btn.onclick = () => b.onClick(el);
    act.appendChild(btn);
  }

  const tb = document.createElement('button');
  tb.className = 'tb-btn tb-pop';
  tb.innerHTML = `<span class="tb-dot"></span><span class="tb-label">${esc(title)}</span>`;

  const win = { name, el, tb, body, prev: null, map: pops };
  pops.set(name, win);
  desktopEl.appendChild(el);
  taskbarEl.appendChild(tb);
  syncTaskbar();
  placeNew(el, { small: true });
  cascade += 1;

  wireWindow(win, { dragHandle: el.querySelector('.win-bar') });

  // توافق مع الاستخدام الحالي: openModal يُرجع العنصر ويُغلق بـ .remove()
  // ملاحظة: __native يجب أن يُسند على دالة التظليل نفسها لا على دالة النموذج
  // الأصلية (el.remove قبل التظليل)، وإلا لما استطاع closeWin استعادة الأصلية.
  const nativeRemove = el.remove.bind(el);
  const override = () => {
    if (pops.has(name)) closeWin(win);
    else nativeRemove();
  };
  override.__native = nativeRemove;
  el.remove = override;
  return el;
}
