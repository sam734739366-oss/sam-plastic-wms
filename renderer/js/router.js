const screens = {};
export function register(name, def) { screens[name] = def; }
export async function go(name) {
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.screen === name));
  const el = document.getElementById('screen');
  el.innerHTML = '';
  const def = screens[name];
  if (def) await def.mount(el);
}
