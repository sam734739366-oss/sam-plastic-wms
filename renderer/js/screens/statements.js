import { register } from '../router.js';
import { api } from '../api.js';
import { toast, renderTable, esc } from '../ui.js';
import { fmtMoney, fmtNum } from '../fmt.js';

const TYPE_LABEL = { customer: 'عميل', supplier: 'مورد', both: 'عميل ومورد' };
const TYPE_TAG = { customer: 'salem', supplier: 'new', both: 'muharraz' };
const DOC_LABEL = {
  invoice: 'فاتورة', purchase: 'شراء', payment: 'سند دفع/قبض',
  sale_return: 'مرتجع بيع', purchase_return: 'مرتجع شراء',
};

function signMoney(v) {
  return v > 0 ? `<span class="tag salem">لنا ${fmtMoney(v)}</span>`
    : v < 0 ? `<span class="tag talef">علينا ${fmtMoney(-v)}</span>`
      : '<span class="muted">—</span>';
}

async function doPrint(title, metaLines, headers, rows, foot = '') {
  try {
    const settings = await api.invoke('settings:get');
    await api.invoke('print:open', {
      kind: 'report', title, settings,
      metaLines: ['تاريخ الطباعة: ' + new Date().toLocaleString('ar'), ...metaLines],
      headers, rows: rows.map(r => r.map(v => esc(v))), foot,
    });
  } catch (e) { toast(String(e.message || e), 'err'); }
}

register('statements', {
  title: 'كشوفات الحسابات',
  async mount(el) {
    const parties = await api.invoke('parties:list');

    async function load(tab = 'summary') {
      el.innerHTML = `
        <div class="toolbar tabs">
          <button class="btn ${tab === 'summary' ? 'primary' : ''}" id="tab-summary">ملخص الذمم</button>
          <button class="btn ${tab === 'statement' ? 'primary' : ''}" id="tab-statement">كشف حساب طرف</button>
          <button class="btn ${tab === 'cash' ? 'primary' : ''}" id="tab-cash">تقرير النقدية</button>
        </div>
        <div id="tab-body"></div>`;
      const body = el.querySelector('#tab-body');
      el.querySelector('#tab-summary').onclick = () => load('summary');
      el.querySelector('#tab-statement').onclick = () => load('statement');
      el.querySelector('#tab-cash').onclick = () => load('cash');

      if (tab === 'summary') {
        body.innerHTML = `<div class="toolbar"><button class="btn primary" id="btn-print">طباعة الملخص</button></div>
          <div id="summary" class="summary-line"></div><div id="table-wrap"></div>
          <div class="help-card"><b>كيف تقرأ الذمم؟</b>
            «لنا» تعني أن المبلغ مستحق لصالح المصنع على الطرف (ذمة عليه). «علينا» تعني أن المبلغ مستحق للطرف على المصنع (ذمة له).
            تتولد الحركات تلقائياً من الفواتير (نقدي/آجل) والمرتجعات وسندات القبض والدفع.</div>`;
        const [sum, recv, cash] = await Promise.all([
          api.invoke('ledger:parties-summary'),
          api.invoke('ledger:receivables'),
          api.invoke('ledger:cash-balance'),
        ]);
        body.querySelector('#summary').innerHTML =
          `ذمم العملاء (لنا): <b>${fmtMoney(recv.customers_due)}</b> — ذمم الموردين (علينا): <b>${fmtMoney(recv.suppliers_due)}</b> — رصيد النقدية: <b>${fmtMoney(cash)}</b>`;
        renderTable(body.querySelector('#table-wrap'), [
          { key: 'name', label: 'الطرف' },
          { key: 'type', label: 'النوع', render: r => `<span class="tag ${TYPE_TAG[r.type] || ''}">${TYPE_LABEL[r.type] || r.type}</span>` },
          { key: 'debit', label: 'مدين (عليه)', render: r => fmtMoney(r.debit) },
          { key: 'credit', label: 'دائن (له)', render: r => fmtMoney(r.credit) },
          { key: 'net', label: 'الصافي', render: r => signMoney(r.net) },
        ], sum);
        body.querySelector('#btn-print').onclick = () => doPrint('ملخص ذمم الأطراف',
          [`ذمم العملاء لنا: ${fmtMoney(recv.customers_due)}`, `ذمم الموردين علينا: ${fmtMoney(recv.suppliers_due)}`, `رصيد النقدية: ${fmtMoney(cash)}`],
          ['الطرف', 'النوع', 'مدين (عليه)', 'دائن (له)', 'الصافي'],
          sum.map(r => [r.name, TYPE_LABEL[r.type] || r.type, fmtNum(r.debit), fmtNum(r.credit),
            r.net > 0 ? `لنا ${fmtNum(r.net)}` : r.net < 0 ? `علينا ${fmtNum(-r.net)}` : '—']));
      } else if (tab === 'statement') {
        body.innerHTML = `
          <div class="form-grid">
            <div class="field"><label>الطرف</label>
              <select id="f-party"><option value="">— اختر الطرف —</option>
                ${parties.map(p => `<option value="${p.id}">${esc(p.name)} (${TYPE_LABEL[p.type] || p.type})</option>`).join('')}
              </select></div>
            <div class="field"><label>من تاريخ</label><input id="f-from" type="date"></div>
            <div class="field"><label>إلى تاريخ</label><input id="f-to" type="date"></div>
            <div class="field"><label>&nbsp;</label><button class="btn primary" id="btn-run">عرض الكشف</button></div>
          </div>
          <div id="st-wrap" class="muted">اختر طرفاً ثم اضغط «عرض الكشف»</div>`;
        body.querySelector('#btn-run').onclick = async () => {
          const pid = Number(body.querySelector('#f-party').value);
          if (!pid) { toast('اختر الطرف أولاً', 'err'); return; }
          try {
            const st = await api.invoke('ledger:statement', pid,
              body.querySelector('#f-from').value || null,
              body.querySelector('#f-to').value || null);
            const wrap = body.querySelector('#st-wrap');
            const totals = st.rows.reduce((a, r) => ({
              d: a.d + (r.side === 'debit' ? r.amount : 0),
              c: a.c + (r.side === 'credit' ? r.amount : 0),
            }), { d: 0, c: 0 });
            wrap.innerHTML = `
              <div class="toolbar"><button class="btn primary" id="btn-print">طباعة الكشف</button></div>
              <div id="summary" class="summary-line">
                كشف حساب: <b>${esc(st.party.name)}</b> — رصيد افتتاحي: <b>${signMoney(st.opening)}</b>
                — الرصيد الختامي: <b>${signMoney(st.closing)}</b>
              </div>
              <div id="table-wrap"></div>`;
            renderTable(wrap.querySelector('#table-wrap'), [
              { key: 'doc_date', label: 'التاريخ' },
              { key: 'doc_number', label: 'المستند', render: r => `<span dir="ltr">${esc(r.doc_number || '—')}</span>` },
              { key: 'label', label: 'البيان', render: r => `${DOC_LABEL[r.doc_type] || r.doc_type}${r.notes ? ' — ' + esc(r.notes) : ''}` },
              { key: 'd', label: 'مدين (عليه)', render: r => r.side === 'debit' ? fmtMoney(r.amount) : '—' },
              { key: 'c', label: 'دائن (له)', render: r => r.side === 'credit' ? fmtMoney(r.amount) : '—' },
              { key: 'running', label: 'الرصيد', render: r => signMoney(r.running) },
            ], st.rows);
            wrap.querySelector('#btn-print').onclick = () => doPrint(`كشف حساب — ${st.party.name}`,
              [`الفترة: ${body.querySelector('#f-from').value || 'البداية'} إلى ${body.querySelector('#f-to').value || 'اليوم'}`,
                `رصيد افتتاحي: ${st.opening > 0 ? 'لنا ' + fmtNum(st.opening) : st.opening < 0 ? 'علينا ' + fmtNum(-st.opening) : '0'}`],
              ['التاريخ', 'المستند', 'البيان', 'مدين', 'دائن', 'الرصيد'],
              st.rows.map(r => [r.doc_date, r.doc_number || '—',
                `${DOC_LABEL[r.doc_type] || r.doc_type}${r.notes ? ' — ' + r.notes : ''}`,
                r.side === 'debit' ? fmtNum(r.amount) : '', r.side === 'credit' ? fmtNum(r.amount) : '',
                r.running > 0 ? `لنا ${fmtNum(r.running)}` : r.running < 0 ? `علينا ${fmtNum(-r.running)}` : '0']),
              `<div class="notes"><b>إجمالي مدين: ${fmtNum(totals.d)} — إجمالي دائن: ${fmtNum(totals.c)} — الرصيد الختامي: ${st.closing > 0 ? 'لنا ' + fmtNum(st.closing) : st.closing < 0 ? 'علينا ' + fmtNum(-st.closing) : '0'}</b></div>`);
          } catch (e) { toast(String(e.message || e), 'err'); }
        };
      } else {
        body.innerHTML = `
          <div class="form-grid">
            <div class="field"><label>من تاريخ</label><input id="f-from" type="date"></div>
            <div class="field"><label>إلى تاريخ</label><input id="f-to" type="date"></div>
            <div class="field"><label>&nbsp;</label><button class="btn primary" id="btn-run">عرض التقرير</button></div>
          </div>
          <div id="cash-wrap" class="muted">اختر الفترة ثم اضغط «عرض التقرير»</div>`;
        body.querySelector('#btn-run').onclick = async () => {
          try {
            const rep = await api.invoke('ledger:cash-report',
              body.querySelector('#f-from').value || null,
              body.querySelector('#f-to').value || null);
            const wrap = body.querySelector('#cash-wrap');
            wrap.innerHTML = `
              <div class="toolbar"><button class="btn primary" id="btn-print">طباعة التقرير</button></div>
              <div id="summary" class="summary-line">
                وارد: <b>${fmtMoney(rep.totalIn)}</b> — صادر: <b>${fmtMoney(rep.totalOut)}</b> — صافي الفترة: <b>${fmtMoney(rep.net)}</b>
              </div>
              <div id="table-wrap"></div>`;
            renderTable(wrap.querySelector('#table-wrap'), [
              { key: 'doc_date', label: 'التاريخ' },
              { key: 'party_name', label: 'الطرف' },
              { key: 'label', label: 'البيان', render: r => `${DOC_LABEL[r.doc_type] || r.doc_type}${r.notes ? ' — ' + esc(r.notes) : ''}` },
              { key: 'in', label: 'وارد', render: r => r.cash_in > 0 ? fmtMoney(r.cash_in) : '—' },
              { key: 'out', label: 'صادر', render: r => r.cash_out > 0 ? fmtMoney(r.cash_out) : '—' },
            ], rep.rows);
            wrap.querySelector('#btn-print').onclick = () => doPrint('تقرير النقدية',
              [`الفترة: ${body.querySelector('#f-from').value || 'البداية'} إلى ${body.querySelector('#f-to').value || 'اليوم'}`,
                `وارد: ${fmtNum(rep.totalIn)} — صادر: ${fmtNum(rep.totalOut)} — صافي: ${fmtNum(rep.net)}`],
              ['التاريخ', 'الطرف', 'البيان', 'وارد', 'صادر'],
              rep.rows.map(r => [r.doc_date, r.party_name || '—',
                `${DOC_LABEL[r.doc_type] || r.doc_type}${r.notes ? ' — ' + r.notes : ''}`,
                r.cash_in > 0 ? fmtNum(r.cash_in) : '', r.cash_out > 0 ? fmtNum(r.cash_out) : '']));
          } catch (e) { toast(String(e.message || e), 'err'); }
        };
      }
    }

    await load('summary');
  }
});
