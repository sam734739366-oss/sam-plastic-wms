import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import {
  toast, implicationsDialog, renderTable, attachRowMenu, rowActions, openModal, esc, canWrite,
} from '../ui.js';
import { fmtMoney, today } from '../fmt.js';

// سندات القبض والدفع: قبض = يحصل المصنع نقداً ويُخصم من ذمة العميل
// دفع = يُخرج المصنع نقداً ويُخصم من ذمته للمورد
register('payments', {
  title: 'سندات القبض والدفع',
  async mount(el) {
    const writable = canWrite();
    async function load() {
      const rows = await api.invoke('payments:list');
      el.innerHTML = `
        <div class="toolbar">${writable ? '<button class="btn primary" id="btn-add">+ سند جديد</button>' : '<span class="muted">وضع عرض فقط — لا يمكن الإنشاء أو التعديل أو الحذف</span>'}</div>
        <div class="help-card" style="margin-bottom:12px">سند القبض يُسجَّل عندما يدفع لك عميل نقداً (يقل رصيده الآجل ويزيد رصيد النقدية)، وسند الدفع عندما تدفع أنت لمورد نقداً (يقل رصيده الآجل وينقص من النقدية). حذف السند نهائي: يُمحى القيد من دفتر الأستاذ وتعود النقدية والذمة لما قبله.</div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      if (writable) el.querySelector('#btn-add').onclick = () => form(null);
      const sumIn = rows.filter(r => r.direction === 'in').reduce((a, r) => a + (Number(r.amount) || 0), 0);
      const sumOut = rows.filter(r => r.direction === 'out').reduce((a, r) => a + (Number(r.amount) || 0), 0);
      el.querySelector('#summary').innerHTML =
        `عدد السندات: <b>${rows.length}</b> — إجمالي القبض: <b>${fmtMoney(sumIn)}</b> — إجمالي الدفع: <b>${fmtMoney(sumOut)}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'party_name', label: 'الطرف', render: r => r.party_name || '—' },
        { key: 'direction', label: 'النوع', render: r => r.direction === 'in' ? '<span class="tag salem">قبض (وارد)</span>' : '<span class="tag talef">دفع (صادر)</span>' },
        { key: 'amount', label: 'المبلغ', render: r => fmtMoney(r.amount) },
        { key: 'notes', label: 'ملاحظات', render: r => esc(r.notes || '—') },
      ], rows);
      attachRowMenu(el.querySelector('#table-wrap'), (ri) => rowActions({
        id: rows[ri].id,
        entity: 'payments',
        valueKind: 'money',
        label: 'سند النقدية',
        view: (id) => view(id),
        print: (id) => printDoc(id),
        edit: (id) => edit(id),
        reload: load,
        readOnly: !writable,
      }));
    }

    async function printDoc(id) {
      try {
        const doc = await api.invoke('payments:get', id);
        await api.invoke('print:open', { kind: 'payment', doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('payments:get', id);
        const bal = await api.invoke('ledger:party-balance', doc.party_id);
        openModal(`سند ${doc.direction === 'in' ? 'قبض' : 'دفع'} ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>الطرف:</b> ${esc(doc.party_name || '—')}
            &nbsp; <b>النوع:</b> ${doc.direction === 'in' ? 'قبض (وارد للنقدية)' : 'دفع (صادر من النقدية)'}</p>
          <p style="line-height:2"><b>المبلغ:</b> ${fmtMoney(doc.amount)} &nbsp; <b>رصيد الطرف الحالي:</b> ${fmtMoney(bal)}</p>
          <p class="muted" style="margin-top:6px">رصيد موجب = ذمة على الطرف لنا، رصيد سالب = ذمة لنا عنده.</p>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'payment', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('payments:get', id);
        const ok = await implicationsDialog('تعديل سند', [
          'سيُلغى الأثر المحاسبي الحالي للسند ويُعاد تسجيله بالقيم الجديدة.',
        ]);
        if (!ok) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const parties = await api.invoke('parties:list', null);
      const suggest = doc ? null : await api.invoke('payments:suggest');
      const back = openModal(doc ? `تعديل سند ${esc(doc.doc_number)}` : 'سند قبض/دفع جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم السند *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>الطرف (عميل/مورد) *</label>
            <select id="f-party"><option value="">— اختر الطرف —</option>
              ${parties.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)} (${p.type === 'supplier' ? 'مورد' : p.type === 'customer' ? 'عميل' : 'عميل/مورد'})</option>`).join('')}
            </select></div>
          <div class="field"><label>نوع السند *</label>
            <select id="f-dir">
              <option value="in" ${doc && doc.direction === 'in' ? 'selected' : ''}>قبض — نقد يدخل من الطرف</option>
              <option value="out" ${doc && doc.direction === 'out' ? 'selected' : ''}>دفع — نقد يخرج للطرف</option>
            </select></div>
          <div class="field"><label>المبلغ *</label><input id="f-amount" class="num" type="number" min="0" step="any" value="${esc(doc ? doc.amount : '')}"></div>
          <div class="field"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <div class="help-card">القبض يقلل ذمة العميل ويزيد النقدية — الدفع يقلل ذمتك للمورد وينقص النقدية. يظهر الأثر مباشرة في تقارير الحسابات ورصيد النقدية.</div>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            await api.invoke('payments:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              party_id: Number(b.querySelector('#f-party').value),
              direction: b.querySelector('#f-dir').value,
              amount: parseFloat(b.querySelector('#f-amount').value) || 0,
              notes: b.querySelector('#f-notes').value,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
    }

    await load();
  }
});
