import { register } from '../router.js';
import { api } from '../api.js';
import { fmtMoney, fmtNum } from '../fmt.js';

function card(id, iconSvg, label, tone) {
  return `<div class="stat"><div class="icon ${tone}">${iconSvg}</div><div><div class="num" id="${id}">—</div><div class="lbl">${label}</div></div></div>`;
}

const ICONS = {
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="M3.3 8.3 12 13l8.7-4.7"/><path d="M12 13v8"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>',
  docs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/></svg>',
  coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.8 9.2a3 3 0 1 0-5.6 1.6"/><path d="M9.2 14.8a3 3 0 1 0 5.6-1.6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  carton: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M6 6V4h12v2"/><path d="M5 6l1 14h12l1-14"/></svg>',
};

register('dashboard', {
  title: 'الرئيسية',
  async mount(el) {
    el.innerHTML = `
      <div style="margin-bottom:18px">
        <h2 style="margin:0;font-size:20px;color:#0f172a">نظرة عامة على المصنع</h2>
        <p class="muted" style="margin:4px 0 0">مؤشرات المخزون والحركة اليومية والحسابات</p>
      </div>
      <div class="stats">
        ${card('s-items', ICONS.box, 'عدد الأصناف', 't1')}
        ${card('s-salem', ICONS.check, 'رصيد سليم (حبة)', 't2')}
        ${card('s-talef', ICONS.warn, 'رصيد تالف (حبة)', 't3')}
        ${card('s-muharraz', ICONS.layers, 'رصيد محرز (حبة)', 't4')}
        ${card('s-today', ICONS.docs, 'مستندات اليوم', 't2')}
        ${card('s-purchases', ICONS.coins, 'مشتريات الشهر', 't1')}
        ${card('s-sales', ICONS.coins, 'مبيعات الشهر', 't3')}
        ${card('s-cartons', ICONS.carton, 'كراتين معلقة بالمخزن', 't4')}
        ${card('s-cash', ICONS.coins, 'رصيد النقدية', 't1')}
        ${card('s-cust', ICONS.warn, 'ذمم العملاء (لنا)', 't3')}
        ${card('s-supp', ICONS.warn, 'ذمم الموردين (علينا)', 't2')}
      </div>`;
    try {
      const d = await api.invoke('dashboard:summary');
      el.querySelector('#s-items').textContent = d.items_count;
      el.querySelector('#s-salem').textContent = fmtNum(d.salem_pieces, 0);
      el.querySelector('#s-talef').textContent = fmtNum(d.talef_pieces, 0);
      el.querySelector('#s-muharraz').textContent = fmtNum(d.muharraz_pieces, 0);
      el.querySelector('#s-today').textContent = d.today_docs;
      el.querySelector('#s-purchases').textContent = fmtMoney(d.month_purchases);
      el.querySelector('#s-sales').textContent = fmtMoney(d.month_sales);
      el.querySelector('#s-cartons').textContent = d.pending_cartons;
      el.querySelector('#s-cash').textContent = fmtMoney(d.cash_balance);
      el.querySelector('#s-cust').textContent = fmtMoney(d.customers_due);
      el.querySelector('#s-supp').textContent = fmtMoney(d.suppliers_due);
    } catch (e) { /* لا شيء */ }
  }
});
