import { register } from '../router.js';
import { api } from '../api.js';

register('dashboard', {
  title: 'الرئيسية',
  async mount(el) {
    el.innerHTML = `<div class="stats">
      <div class="stat"><div class="icon t1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="M3.3 8.3 12 13l8.7-4.7"/><path d="M12 13v8"/></svg></div><div><div class="num" id="s-raw">—</div><div class="lbl">أصناف الخام</div></div></div>
      <div class="stat"><div class="icon t3"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg></div><div><div class="num" id="s-fg">—</div><div class="lbl">أصناف الإنتاج التام</div></div></div>
      <div class="stat"><div class="icon t2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M6 6V4h12v2"/><path d="M5 6l1 14h12l1-14"/></svg></div><div><div class="num" id="s-today">—</div><div class="lbl">مستندات اليوم</div></div></div>
      <div class="stat"><div class="icon t4"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/></svg></div><div><div class="num" id="s-balance">—</div><div class="lbl">رصيد التام (حبة)</div></div></div>
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
