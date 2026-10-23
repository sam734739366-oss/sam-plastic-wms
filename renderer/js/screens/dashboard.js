import { register } from '../router.js';
import { api } from '../api.js';
import { fmtMoney, fmtNum } from '../fmt.js';
import { openWindow } from '../wm.js';
import { monthlyBars, donut, hBars } from '../charts.js';

function card(id, iconSvg, label, tone) {
  return `<div class="stat"><div class="icon ${tone}">${iconSvg}</div><div><div class="num" id="${id}">—</div><div class="lbl">${label}</div></div></div>`;
}

const emptyHtml = (msg) => `<div class="chart-empty">${msg}</div>`;

function renderCharts(root, c) {
  const hasMonthly = c.monthly.some((m) => Number(m.purchases) > 0);
  root.querySelector('#ch-monthly').innerHTML = hasMonthly
    ? monthlyBars({
      labels: c.monthly.map((m) => m.label),
      series: [
        { name: 'مشتريات', color: '#3b6cf0', values: c.monthly.map((m) => m.purchases) },
      ],
    })
    : emptyHtml('لا توجد مشتريات خلال آخر 6 أشهر');

  root.querySelector('#ch-buckets').innerHTML = donut({
    segments: [
      { label: 'سليم', value: c.buckets[0].value, color: '#16a34a' },
      { label: 'تالف', value: c.buckets[1].value, color: '#dc2626' },
      { label: 'محرز', value: c.buckets[2].value, color: '#6d28d9' },
    ],
  }) || emptyHtml('لا يوجد مخزون مسجّل بعد');

  const topRows = c.top_items.map((t) => ({ label: t.name, value: t.qty }));
  root.querySelector('#ch-top').innerHTML = topRows.length
    ? hBars({ rows: topRows, color: '#d9a441', color2: '#ffe3a3', fmt: (v) => fmtNum(v, 0) + ' حبة' })
    : emptyHtml('لا توجد أصناف بمخزون سليم بعد');
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
      <div class="dash-head" style="margin-bottom:18px">
        <div>
          <h2 style="margin:0;font-size:20px;color:#0f172a">نظرة عامة على المصنع</h2>
          <p class="muted" style="margin:4px 0 0">مؤشرات المخزون والحركة اليومية والإنتاج</p>
        </div>
        <button id="btn-guide" class="btn guide-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h6M9 11h5"/></svg>
          دليل المستخدم
        </button>
      </div>
      <div class="stats">
        ${card('s-items', ICONS.box, 'عدد الأصناف', 't1')}
        ${card('s-salem', ICONS.check, 'رصيد سليم (حبة)', 't2')}
        ${card('s-talef', ICONS.warn, 'رصيد تالف (حبة)', 't3')}
        ${card('s-muharraz', ICONS.layers, 'رصيد محرز (حبة)', 't4')}
        ${card('s-today', ICONS.docs, 'مستندات اليوم', 't2')}
        ${card('s-purchases', ICONS.coins, 'مشتريات الشهر', 't1')}
        ${card('s-cartons', ICONS.carton, 'كراتين معلقة بالمخزن', 't4')}
      </div>
      <div class="charts-grid">
        <div class="card">
          <h2>المشتريات — آخر 6 أشهر</h2>
          <div id="ch-monthly"></div>
        </div>
        <div class="card">
          <h2>توزيع المخزون (سليم / تالف / محرز)</h2>
          <div id="ch-buckets"></div>
        </div>
        <div class="card">
          <h2>أعلى الأصناف رصيداً سليماً</h2>
          <div id="ch-top"></div>
        </div>
      </div>`;
    el.querySelector('#btn-guide').onclick = () => openWindow('guide');
    try {
      const d = await api.invoke('dashboard:summary');
      el.querySelector('#s-items').textContent = d.items_count;
      el.querySelector('#s-salem').textContent = fmtNum(d.salem_pieces, 0);
      el.querySelector('#s-talef').textContent = fmtNum(d.talef_pieces, 0);
      el.querySelector('#s-muharraz').textContent = fmtNum(d.muharraz_pieces, 0);
      el.querySelector('#s-today').textContent = d.today_docs;
      el.querySelector('#s-purchases').textContent = fmtMoney(d.month_purchases);
      el.querySelector('#s-cartons').textContent = d.pending_cartons;
    } catch (e) { /* لا شيء */ }
    try {
      const c = await api.invoke('dashboard:charts');
      renderCharts(el, c);
    } catch (e) { /* لا شيء */ }
  }
});
