import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, implicationsDialog, renderTable, openModal, esc } from '../ui.js';

const DISP_LABEL = { to_recycled: 'إرجاع محرز', to_stock: 'إرجاع للمخزون', to_supplier: 'استرجاع مورد', sold_scrap: 'بيع خردة' };

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

register('scrap', {
  title: 'التالف ومصيره',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('scrap:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ تسجيل تالف</button></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم' },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'item_code', label: 'الصنف', render: r => `${esc(r.item_code)} — ${esc(r.item_name)}` },
        { key: 'disposition', label: 'المصير', render: r => DISP_LABEL[r.disposition] || r.disposition },
        { key: 'warehouse_name', label: 'المخزن', render: r => r.warehouse_name || '—' },
        { key: 'party_name', label: 'الطرف', render: r => r.party_name || '—' },
        { key: 'pieces', label: 'الحبات', render: r => Number(r.pieces).toLocaleString('en-US') },
        { key: 'weight_kg', label: 'الوزن كجم', render: r => Number(r.weight_kg || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) },
        { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغى</span>' : 'نشط' },
        {
          key: 'actions', label: '',
          render: (r) => `<button class="btn mini" data-view="${r.id}">عرض</button>
            <button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-void="${r.id}">إلغاء</button>`,
        },
      ], rows);
      el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view(Number(b.dataset.view)));
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(Number(b.dataset.edit)));
      el.querySelectorAll('[data-void]').forEach(b => b.onclick = () => voidDoc(Number(b.dataset.void)));
    }

    async function view(id) {
      try {
        const doc = await api.invoke('scrap:get', id);
        openModal(`سند تالف ${esc(doc.doc_number)}`, `
          <p style="line-height:2">
            <b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>الصنف:</b> ${esc(doc.item_code)} — ${esc(doc.item_name)}<br>
            <b>المصير:</b> ${DISP_LABEL[doc.disposition]} &nbsp; <b>المخزن:</b> ${esc(doc.warehouse_name || '—')} &nbsp; <b>الطرف:</b> ${esc(doc.party_name || '—')}<br>
            <b>الحبات:</b> ${Number(doc.pieces).toLocaleString('en-US')} &nbsp; <b>الوزن:</b> ${Number(doc.weight_kg || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} كجم
            ${doc.price ? `&nbsp; <b>السعر:</b> ${Number(doc.price).toLocaleString('en-US')}` : ''}</p>
          ${doc.notes ? `<p><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'scrap', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('scrap:get', id);
        if (!(await implicationsDialog('تعديل سند تالف', [
          'ستُعكس حركة المخزون الحالية ويُعاد تطبيق السند بالقيم الجديدة.',
        ]))) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('scrap:get', id);
        if (!(await implicationsDialog('إلغاء سند تالف', [
          `سيُلغى أثر السند ${esc(doc.doc_number)} على المخزون (ورصيد العميل إن وُجد).`,
        ]))) return;
        await api.invoke('scrap:void', id, currentUser().id);
        toast('تم إلغاء السند', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, parties, warehouses] = await Promise.all([
        api.invoke('items:list', null),
        api.invoke('parties:list', null),
        api.invoke('warehouses:list'),
      ]);
      const scrapItems = items.filter(i => i.item_group !== 4);
      const suggest = doc ? null : await api.invoke('scrap:suggest');
      const partiesOpts = parties.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)} (${p.type === 'supplier' ? 'مورد' : p.type === 'customer' ? 'عميل' : 'مورد وعميل'})</option>`).join('');
      const whOpts = warehouses.map(w => `<option value="${w.id}" ${doc && doc.warehouse_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');

      const back = openModal(doc ? `تعديل سند تالف ${esc(doc.doc_number)}` : 'تسجيل تالف جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم السند *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>الصنف *</label>
            <select id="f-item">${scrapItems.map(i => `<option value="${i.id}" ${doc && doc.item_id === i.id ? 'selected' : ''}>${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select></div>
          <div class="field"><label>مصير التالف *</label>
            <select id="f-disp">
              ${Object.entries(DISP_LABEL).map(([v, l]) => `<option value="${v}" ${doc && doc.disposition === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div class="field"><label>المخزن</label>
            <select id="f-wh"><option value="">—</option>${whOpts}</select></div>
          <div class="field"><label>الطرف (مورد/عميل)</label>
            <select id="f-party"><option value="">—</option>${partiesOpts}</select></div>
          <div class="field"><label>الحبات</label><input id="f-pieces" type="number" min="0" value="${doc ? doc.pieces : ''}"></div>
          <div class="field"><label>الوزن كجم</label><input id="f-weight" type="number" min="0" step="any" value="${doc ? doc.weight_kg : ''}"></div>
          <div class="field"><label>السعر (بيع خردة)</label><input id="f-price" type="number" min="0" step="any" value="${doc ? doc.price || '' : ''}"></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const partyId = b.querySelector('#f-party').value ? Number(b.querySelector('#f-party').value) : null;
            const isCustomerParty = partyId && parties.find(p => p.id === partyId && (p.type === 'customer' || p.type === 'both'));
            await api.invoke('scrap:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              item_id: Number(b.querySelector('#f-item').value),
              disposition: b.querySelector('#f-disp').value,
              warehouse_id: b.querySelector('#f-wh').value ? Number(b.querySelector('#f-wh').value) : null,
              party_id: partyId,
              pieces: Number(b.querySelector('#f-pieces').value) || 0,
              weight_kg: Number(b.querySelector('#f-weight').value) || 0,
              price: b.querySelector('#f-price').value ? Number(b.querySelector('#f-price').value) : null,
              notes: b.querySelector('#f-notes').value,
              _isCustomerParty: isCustomerParty,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
      back.querySelector('.modal').style.minWidth = '640px';
      const updateVis = () => {
        const disp = back.querySelector('#f-disp').value;
        back.querySelector('#f-wh').closest('.field').style.display = disp === 'to_supplier' ? 'none' : '';
        back.querySelector('#f-price').closest('.field').style.display = disp === 'sold_scrap' ? '' : 'none';
      };
      back.querySelector('#f-disp').onchange = updateVis;
      updateVis();
    }

    await load();
  }
});
