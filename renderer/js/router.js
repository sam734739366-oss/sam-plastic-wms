// ===== مسار الصفحات =====
// الصفحات الرئيسية تُعرض دائماً داخل منطقة ثابتة (#screen) في قلب البرنامج —
// تغيير الاختيار من القائمة يستبدل المحتوى ولا يفتح نوافذ.
// النوافذ (بأزرار التصغير والتكبير والإغلاق) مخصصة للمنبثقات فقط: الفواتير
// والسندات والنماذج ودليل المستخدم، وتديرها wm.js بشكل مستقل.
const screens = {};
let current = 'dashboard';
export function register(name, def) { screens[name] = def; }
export function getDef(name) { return screens[name]; }
export function currentScreen() { return current; }
export function go(name) {
  current = name;
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.screen === name));
  const el = document.getElementById('screen');
  if (!el) return;
  el.innerHTML = '';
  const def = screens[name];
  if (def) def.mount(el);
}
