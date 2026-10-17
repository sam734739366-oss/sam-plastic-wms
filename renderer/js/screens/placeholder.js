import { register } from '../router.js';

export function placeholder(name, label) {
  register(name, {
    title: label,
    async mount(el) {
      el.innerHTML = `<div class="card"><h2>${label}</h2>
        <p class="muted">هذه الشاشة ستتوفر في مرحلة لاحقة من التنفيذ.</p></div>`;
    }
  });
}
