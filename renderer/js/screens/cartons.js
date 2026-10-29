import { register, go } from '../router.js';
import { api } from '../api.js';
import { toast, renderTable, esc } from '../ui.js';
import { fmtNum } from '../fmt.js';

const STATUS_LABEL = { in_stock: 'بالمخزن', issued: 'مصروف بانتظار الاستلام', finished: 'أُنتج واستُلم' };
const STATUS_TAG = { in_stock: 'salem', issued: 'new', finished: 'muharraz' };

function restHtml(r) {
  if (r.rest == null) return '—';
  if (r.rest > 0) return `<span class="tag talef">عجز ${fmtNum(r.rest, 0)}</span>`;
  if (r.rest < 0) return `<span class="tag muharraz">فائض ${fmtNum(-r.rest, 0)}</span>`;
  return '<span class="tag salem">مطابق</span>';
}

async function doPrint(rows, issues) {
  try {
    const settings = await api.invoke('settings:get');
    const headers = ['الكرتون', 'الصنف', 'فاتورة الدخول', 'الحالة', 'تصريح الصرف', 'سند استلام الإنتاج', 'الحبات', 'سليم', 'تالف قبل', 'تالف بعد', 'الفارق'];
    const r = rows.map(c => [
      c.carton_number, `${c.item_code} — ${c.item_name}`, c.purchase_number || (c.receipt_number ? 'خام عميل' : '—'),
      STATUS_LABEL[c.status] || c.status, c.issue_number || '—', c.receipt_number || '—', fmtNum(c.pieces, 0),
      c.good_pieces == null ? '—' : fmtNum(c.good_pieces, 0),
      c.defect_before == null ? '—' : fmtNum(c.defect_before, 0),
      c.defect_after == null ? '—' : fmtNum(c.defect_after, 0),
      c.rest == null ? '—' : (c.rest > 0 ? `عجز ${fmtNum(c.rest, 0)}` : c.rest < 0 ? `فائض ${fmtNum(-c.rest, 0)}` : 'مطابق'),
    ]);
    const footLines = issues.map(x =>
      `تصريح ${x.doc_number}: المصروف ${fmtNum(x.issued_pieces, 0)} — السليم المعلن بالكراتين ${fmtNum(x.declared_good, 0)} — المستلَم في المخزون ${fmtNum(x.received_pieces, 0)} — ${x.receive_diff > 0 ? `فائض تسوية ${fmtNum(x.receive_diff, 0)}` : x.receive_diff < 0 ? `لم يُستلم بعد ${fmtNum(-x.receive_diff, 0)}` : 'مطابق'}`);
    await api.invoke('print:open', {
      kind: 'report', title: 'متابعة دورة الكراتين', settings,
      metaLines: ['تاريخ الطباعة: ' + new Date().toLocaleString('ar'),
        `عدد الكراتين: ${rows.length} — المستلَم مقابل المصروف لكل تصريح صرف`],
      headers, rows: r.map(x => x.map(v => esc(v))),
      foot: footLines.map(l => `<div>${esc(l)}</div>`).join(''),
    });
  } catch (e) { toast(String(e.message || e), 'err'); }
}

register('cartons', {
  title: 'متابعة الكراتين',
  async mount(el) {
    const { cartons, issues } = await api.invoke('cartons:cycle');
    const inStock = cartons.filter(c => c.status === 'in_stock').length;
    const issued = cartons.filter(c => c.status === 'issued').length;
    const finished = cartons.filter(c => c.status === 'finished').length;
    const surplus = cartons.reduce((s, c) => s + (c.rest > 0 ? c.rest : 0), 0);
    const shortage = cartons.reduce((s, c) => s + (c.rest < 0 ? -c.rest : 0), 0);

    el.innerHTML = `
      <div class="help-card">
        <b>دورة الكرتون كاملة من الدخول حتى الاستلام:</b>
        يشتري المصنع خاماً بكراتين مرقمة (فاتورة شراء بوحدة كرتون) أو يستلم خام عميل (سند نفخ للغير) ←
        يُصرف للإنتاج بتصريح صرف ← يُسجَّل لكل كرتون نتيجة في <b>استلام الإنتاج</b> (سليم / تالف قبل / تالف بعد) ←
        يدخل السليم (+الفائض) إلى مخزن التام تلقائياً من نفس السند.
        <div class="muted" style="margin-top:6px">هذه الشاشة للمتابعة فقط: لا تُنشئ ولا تعدّل شيئاً، والأرصدة محسوبة من الحركات نفسها مرة واحدة بلا تكرار.</div>
        <div class="help-actions"><button class="btn small" id="go-purchases">فواتير الشراء</button>
          <button class="btn small" id="go-issues">تصاريح الصرف</button>
          <button class="btn small" id="go-production">استلام الإنتاج</button></div>
      </div>
      <div class="toolbar"><button class="btn primary" id="btn-print">طباعة المتابعة</button></div>
      <div id="summary" class="summary-line"></div>
      <h2 class="section-title">دورة الكراتين</h2>
      <div id="cartons-wrap"></div>
      <h2 class="section-title">المستلَم مقابل المصروف لكل تصريح صرف</h2>
      <div id="issues-wrap"></div>`;

    el.querySelector('#go-purchases').onclick = () => go('purchases');
    el.querySelector('#go-issues').onclick = () => go('issues');
    el.querySelector('#go-production').onclick = () => go('production');
    el.querySelector('#btn-print').onclick = () => doPrint(cartons, issues);

    el.querySelector('#summary').innerHTML =
      `بالمخزن: <b>${fmtNum(inStock, 0)}</b> — مصروفة بانتظار الاستلام: <b>${fmtNum(issued, 0)}</b> — أُنتجت واستُلمت: <b>${fmtNum(finished, 0)}</b>`
      + (shortage ? ` — إجمالي العجز: <b>${fmtNum(shortage, 0)}</b> حبة` : '')
      + (surplus ? ` — إجمالي الفائض: <b>${fmtNum(surplus, 0)}</b> حبة` : '');

    renderTable(el.querySelector('#cartons-wrap'), [
      { key: 'carton_number', label: 'الكرتون', render: r => `<span dir="ltr">${esc(r.carton_number)}</span>` },
      { key: 'item_code', label: 'الصنف', render: r => `${esc(r.item_code)} — ${esc(r.item_name)}` },
      { key: 'source', label: 'المصدر', render: r => r.source === 'customer' ? `<span class="tag new">عهدة ${esc(r.party_name || 'عميل')}</span>` : '<span class="tag salem">خام المصنع</span>' },
      { key: 'purchase_number', label: 'فاتورة الدخول', render: r => r.purchase_number ? `<span dir="ltr">${esc(r.purchase_number)}</span>` : '—' },
      { key: 'status', label: 'الحالة', render: r => `<span class="tag ${STATUS_TAG[r.status] || ''}">${STATUS_LABEL[r.status] || r.status}</span>` },
      { key: 'issue_number', label: 'تصريح الصرف', render: r => r.issue_number ? `<span dir="ltr">${esc(r.issue_number)}</span> — ${esc(r.issue_doc_date || '')}` : '—' },
      { key: 'receipt_number', label: 'سند استلام الإنتاج', render: r => r.receipt_number ? `<span dir="ltr">${esc(r.receipt_number)}</span>` : '—' },
      { key: 'pieces', label: 'الحبات', render: r => fmtNum(r.pieces, 0) },
      { key: 'good_pieces', label: 'سليم', render: r => r.good_pieces == null ? '—' : fmtNum(r.good_pieces, 0) },
      { key: 'defects', label: 'تالف', render: r => r.good_pieces == null ? '—' : fmtNum((r.defect_before || 0) + (r.defect_after || 0), 0) },
      { key: 'rest', label: 'الفارق', render: restHtml },
    ], cartons);

    renderTable(el.querySelector('#issues-wrap'), [
      { key: 'doc_number', label: 'تصريح الصرف', render: r => `<span dir="ltr">${esc(r.doc_number)}</span> — ${esc(r.doc_date)}` },
      { key: 'issued_pieces', label: 'المصروف من الكراتين', render: r => fmtNum(r.issued_pieces, 0) },
      { key: 'declared_good', label: 'السليم المعلن بالكراتين', render: r => fmtNum(r.declared_good, 0) },
      { key: 'received_pieces', label: 'المستلَم في المخزون (سليم + فائض)', render: r => fmtNum(r.received_pieces, 0) },
      {
        key: 'receive_diff', label: 'فائض / لم يُستلم بعد', render: r =>
          r.receive_diff > 0 ? `<span class="tag muharraz">فائض تسوية ${fmtNum(r.receive_diff, 0)}</span>`
            : r.receive_diff < 0 ? `<span class="tag talef">بقي ${fmtNum(-r.receive_diff, 0)}</span>`
              : '<span class="muted">مطابق</span>',
      },
    ], issues);

    if (!cartons.length) {
      el.querySelector('#cartons-wrap').innerHTML = '<p class="muted">لا توجد كراتين بعد — اشترِ خاماً بوحدة كرتون برقم بادئة لتظهر هنا.</p>';
    }
    if (!issues.length) {
      el.querySelector('#issues-wrap').innerHTML = '<p class="muted">لا توجد تصاريح صرف بعد.</p>';
    }
  },
});
