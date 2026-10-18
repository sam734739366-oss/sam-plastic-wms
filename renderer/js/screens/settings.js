import { register } from '../router.js';
import { api, currentUser, isManager } from '../api.js';
import { toast, esc } from '../ui.js';

register('settings', {
  title: 'الإعدادات',
  async mount(el) {
    if (!isManager()) { el.innerHTML = '<div class="card"><p class="muted">فقط المدير يمكنه تعديل الإعدادات.</p></div>'; return; }
    const s = await api.invoke('settings:get');
    el.innerHTML = `<div class="card">
      <div class="page-head"><h2>إعدادات المصنع</h2></div>
      <div class="form-grid">
        <label class="field"><span>اسم المصنع</span><input id="f-factory" value="${esc(s.factory_name || '')}"></label>
        <label class="field"><span>الهاتف</span><input id="f-phone" value="${esc(s.factory_phone || '')}"></label>
        <label class="field"><span>العنوان</span><input id="f-address" value="${esc(s.factory_address || '')}"></label>
        <label class="field"><span>العملة</span><input id="f-currency" value="${esc(s.currency || 'ريال يمني')}"></label>
        <label class="field"><span>مقاس طباعة المستندات</span><select id="f-docsize">
          <option value="A4" ${s.doc_page_size === 'A4' ? 'selected' : ''}>A4</option>
          <option value="A5" ${s.doc_page_size === 'A5' ? 'selected' : ''}>A5</option>
        </select></label>
        <label class="field"><span>مقاس طباعة التقارير</span><select id="f-reportsize">
          <option value="A4" ${s.report_page_size === 'A4' ? 'selected' : ''}>A4</option>
          <option value="A5" ${s.report_page_size === 'A5' ? 'selected' : ''}>A5</option>
        </select></label>
        <label class="field full"><span>المجلد السحابي (تُنسخ إليه النسخ الاحتياطية تلقائياً — OneDrive أو ما شابه)</span><input id="f-cloud" value="${esc(s.cloud_folder || '')}" placeholder="مثال: C:\Users\Elite\OneDrive\سام بلاستيك"></label>
      </div>
      <div class="actions"><button id="save" class="btn primary">حفظ الإعدادات</button></div>
    </div>`;
    el.querySelector('#save').onclick = async () => {
      try {
        await api.invoke('settings:save', {
          factory_name: el.querySelector('#f-factory').value,
          factory_phone: el.querySelector('#f-phone').value,
          factory_address: el.querySelector('#f-address').value,
          currency: el.querySelector('#f-currency').value,
          doc_page_size: el.querySelector('#f-docsize').value,
          report_page_size: el.querySelector('#f-reportsize').value,
          cloud_folder: el.querySelector('#f-cloud').value
        }, currentUser().id);
        toast('تم حفظ الإعدادات', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }
});
