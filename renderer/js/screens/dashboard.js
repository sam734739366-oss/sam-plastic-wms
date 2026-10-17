import { register } from '../router.js';
import { api } from '../api.js';

register('dashboard', {
  title: 'الرئيسية',
  async mount(el) {
    el.innerHTML = `<div class="stats">
      <div class="stat"><div class="num" id="s-raw">—</div><div class="lbl">أصناف الخام</div></div>
      <div class="stat"><div class="num" id="s-fg">—</div><div class="lbl">أصناف الإنتاج التام</div></div>
      <div class="stat"><div class="num" id="s-today">—</div><div class="lbl">مستندات اليوم</div></div>
      <div class="stat"><div class="num" id="s-balance">—</div><div class="lbl">رصيد التام (حبة)</div></div>
    </div>`;
    try {
      const d = await api.invoke('dashboard:summary');
      el.querySelector('#s-raw').textContent = d.raw_items;
      el.querySelector('#s-fg').textContent = d.fg_items;
      el.querySelector('#s-today').textContent = d.today_docs;
      el.querySelector('#s-balance').textContent = Number(d.fg_balance).toLocaleString('en-US');
    } catch (e) { /* لا شيء */ }
  }
});
