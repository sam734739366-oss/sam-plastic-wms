import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

register('production', {
  title: 'نتيجة الإنتاج',
  async mount(el) {
    async function load() {
      const [pending, done] = await Promise.all([
        api.invoke('production:pending'),
        api.invoke('production:done'),
      ]);
      el.innerHTML = `
        <h2 class="section-title">كراتين بانتظار النتيجة</h2>
        <div id="pending-wrap"></div>
        <h2 class="section-title">نتائج مسجلة</h2>
        <div id="done-wrap"></div>`;
      renderTable(el.querySelector('#pending-wrap'), [
        { key: 'carton_number', label: 'الكرتون' },
        { key: 'item_code', label: 'الكود', render: r => `${esc(r.item_code)} — ${esc(r.item_name)}` },
        { key: 'issue_number', label: 'تصريح الصرف' },
        { key: 'issue_date', label: 'تاريخ الصرف' },
        { key: 'machine_name', label: 'المكينة', render: r => r.machine_name || '—' },
        { key: 'shift_name', label: 'الوردية', render: r => r.shift_name || '—' },
        { key: 'pieces', label: 'الحبات', render: r => Number(r.pieces).toLocaleString('en-US') },
        { key: 'actions', label: '', render: r => `<button class="btn mini primary" data-result="${r.carton_id}">تسجيل النتيجة</button>` },
      ], pending);
      el.querySelectorAll('[data-result]').forEach(b => b.onclick = () => resultForm(Number(b.dataset.result), false));
      if (!pending.length) {
        el.querySelector('#pending-wrap').innerHTML = '<p class="muted">لا توجد كراتين بانتظار النتيجة</p>';
      }
      renderTable(el.querySelector('#done-wrap'), [
        { key: 'carton_number', label: 'الكرتون' },
        { key: 'item_code', label: 'الصنف', render: r => `${esc(r.item_code)} — ${esc(r.item_name)}` },
        { key: 'issue_number', label: 'التصريح' },
        { key: 'result_date', label: 'التاريخ' },
        { key: 'good_pieces', label: 'سليم', render: r => Number(r.good_pieces).toLocaleString('en-US') },
        { key: 'defect_before', label: 'تالف قبل', render: r => Number(r.defect_before).toLocaleString('en-US') },
        { key: 'defect_after', label: 'تالف بعد', render: r => Number(r.defect_after).toLocaleString('en-US') },
        {
          key: 'rest', label: 'غير محسوب', render: r => {
            const rest = r.pieces - (r.good_pieces + r.defect_before + r.defect_after);
            return rest > 0 ? `<span class="tag new">${rest.toLocaleString('en-US')}</span>` : '—';
          }
        },
        { key: 'actions', label: '', render: r => `<button class="btn mini" data-edit="${r.carton_id}">تعديل</button>
          <button class="btn mini danger" data-del="${r.carton_id}">حذف</button>` },
      ], done);
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => resultForm(Number(b.dataset.edit), true));
      el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => delResult(Number(b.dataset.del)));
      if (!done.length) {
        el.querySelector('#done-wrap').innerHTML = '<p class="muted">لا توجد نتائج مسجلة بعد</p>';
      }
    }

    async function delResult(cartonId) {
      try {
        if (!(await confirmDialog('سيُحذف سجل النتيجة ويعود الكرتون لقائمة الانتظار (مصروف بلا نتيجة). متابعة؟'))) return;
        await api.invoke('production:delete', cartonId, currentUser().id);
        toast('تم حذف النتيجة', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function resultForm(cartonId, isEdit) {
      try {
        const row = await api.invoke('production:get', cartonId);
        const back = openModal(
          isEdit ? `تعديل نتيجة — كرتون ${esc(row.carton_number)}` : `تسجيل نتيجة — كرتون ${esc(row.carton_number)}`,
          `
          <p style="line-height:2">
            <b>الصنف:</b> ${esc(row.item_code)} — ${esc(row.item_name)} &nbsp;
            <b>التصريح:</b> ${esc(row.issue_number || '—')} &nbsp;
            <b>حبات الكرتون:</b> ${Number(row.pieces).toLocaleString('en-US')}</p>
          <div class="form-grid">
            <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(row.result_date || today())}"></div>
            <div class="field"><label>سليم</label><input id="f-good" type="number" min="0" value="${row.good_pieces ?? 0}"></div>
            <div class="field"><label>تالف قبل النفخ</label><input id="f-before" type="number" min="0" value="${row.defect_before ?? 0}"></div>
            <div class="field"><label>تالف بعد النفخ</label><input id="f-after" type="number" min="0" value="${row.defect_after ?? 0}"></div>
            <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(row.notes || '')}"></div>
          </div>
          <p id="sum-line" class="muted" style="margin-top:8px"></p>`,
          [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
            try {
              const good = Number(b.querySelector('#f-good').value) || 0;
              const before = Number(b.querySelector('#f-before').value) || 0;
              const after = Number(b.querySelector('#f-after').value) || 0;
              const sum = good + before + after;
              if (sum > row.pieces && !(await confirmDialog(`المجموع (${sum.toLocaleString('en-US')}) أكبر من حبات الكرتون (${Number(row.pieces).toLocaleString('en-US')}). متابعة الحفظ؟`))) return;
              const res = await api.invoke('production:save', {
                carton_id: cartonId,
                result_date: b.querySelector('#f-date').value,
                good_pieces: good, defect_before: before, defect_after: after,
                notes: b.querySelector('#f-notes').value,
              }, currentUser().id);
              const restMsg = res.rest > 0 ? ` — غير محسوب: ${res.rest.toLocaleString('en-US')}` : '';
              b.remove(); toast(`تم حفظ النتيجة${restMsg}`, 'ok'); await load();
            } catch (e) { toast(String(e.message || e), 'err'); }
          } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
        const update = () => {
          const good = Number(back.querySelector('#f-good').value) || 0;
          const before = Number(back.querySelector('#f-before').value) || 0;
          const after = Number(back.querySelector('#f-after').value) || 0;
          const sum = good + before + after;
          const rest = row.pieces - sum;
          back.querySelector('#sum-line').innerHTML =
            `المجموع: <b>${sum.toLocaleString('en-US')}</b> من ${Number(row.pieces).toLocaleString('en-US')} حبة — ${rest > 0 ? `الباقي <b>${rest.toLocaleString('en-US')}</b> غير محسوب` : rest < 0 ? '<span class="error">تجاوز بعدد الحبات!</span>' : 'مكتمل'}`;
        };
        ['#f-good', '#f-before', '#f-after'].forEach(s => back.querySelector(s).oninput = update);
        update();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    await load();
  }
});
