const screens = {};
let opener = null;
export function register(name, def) { screens[name] = def; }
export function getDef(name) { return screens[name]; }
export function setOpener(fn) { opener = fn; }
export function go(name) {
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.screen === name));
  if (opener) { opener(name); return; }
  const el = document.getElementById('screen');
  if (!el) return;
  el.innerHTML = '';
  const def = screens[name];
  if (def) def.mount(el);
}
