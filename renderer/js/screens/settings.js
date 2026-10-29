import { register } from '../router.js';
import { api, currentUser, isManager } from '../api.js';
import { toast, esc } from '../ui.js';
import { setCurrency, currencyList, currencyInfo, fmtMoney } from '../fmt.js';

register('settings', {
  title: 'الإعدادات',
  async mount(el) {
    if (!isManager()) {
      el.innerHTML = '<div class="card"><p class="muted">فقط المدير يمكنه تعديل الإعدادات.</p></div>';
      return;
    }
    const s = await api.invoke('settings:get');
    const cur = s.currency || 'YER';
    const currencies = currencyList();

    el.innerHTML = `
      <div class="toolbar"></div>
      <div class="summary-line">عملة النظام الحالية: <b>${esc(currencyInfo().name)}</b> — مثال على العرض: <b>${esc(fmtMoney(1234567.5))}</b></div>
      <div class="card">
        <div class="page-head"><h2>بيانات المصنع</h2></div>
        <div class="form-grid">
          <div class="field"><label>اسم المصنع</label><input id="f-factory" value="${esc(s.factory_name || '')}"></div>
          <div class="field"><label>الهاتف</label><input id="f-phone" value="${esc(s.factory_phone || '')}" dir="ltr"></div>
          <div class="field"><label>العنوان</label><input id="f-address" value="${esc(s.factory_address || '')}"></div>
          <div class="field full"><label>المجلد السحابي (تُنسخ إليه النسخ الاحتياطية تلقائياً — OneDrive أو ما شابه)</label>
            <input id="f-cloud" value="${esc(s.cloud_folder || '')}" placeholder="مثال: C:\\Users\\Elite\\OneDrive\\سام بلاستيك" dir="ltr"></div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="page-head"><h2>العملة</h2></div>
        <div class="form-grid">
          <div class="field full"><label>عملة النظام (تُستخدم في كل المبالغ والتقارير والمطبوعات)</label>
            <select id="f-currency">
              ${currencies.map(c => `<option value="${c.code}" ${cur === c.code ? 'selected' : ''}>${esc(c.name)} (${c.symbol})</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="page-head"><h2>الطباعة</h2></div>
        <div class="form-grid">
          <div class="field"><label>مقاس طباعة المستندات</label><select id="f-docsize">
            <option value="A4" ${s.doc_page_size === 'A4' ? 'selected' : ''}>A4</option>
            <option value="A5" ${s.doc_page_size === 'A5' ? 'selected' : ''}>A5</option>
          </select></div>
          <div class="field"><label>مقاس طباعة التقارير</label><select id="f-reportsize">
            <option value="A4" ${s.report_page_size === 'A4' ? 'selected' : ''}>A4</option>
            <option value="A5" ${s.report_page_size === 'A5' ? 'selected' : ''}>A5</option>
          </select></div>
          <div class="field full"><span class="muted" style="font-size:11.5px">
            يظهر اسم التطبيق «سام بلاستيك» ورقم الهاتف تلقائياً في زاوية ترويسة كل مستند مطبوع — أكمل الهاتف في بطاقة «البيانات الأساسية».
          </span></div>
          <div class="field"><label>تذييل الطباعة — يمين</label><input id="f-foot-r" value="${esc(s.footer_right || '')}" placeholder="مثال: سام بلاستيك"></div>
          <div class="field"><label>تذييل الطباعة — وسط</label><input id="f-foot-c" value="${esc(s.footer_center || '')}" placeholder="مثال: شكراً لتعاملكم معنا"></div>
          <div class="field"><label>تذييل الطباعة — يسار</label><input id="f-foot-l" value="${esc(s.footer_left || '')}" placeholder="مثال: هاتف الدعم: 05xxxxxxxx"></div>
        </div>
      </div>
      <div class="toolbar" style="margin-top:14px">
        <button id="save" class="btn primary">حفظ الإعدادات</button>
      </div>`;

    el.querySelector('#f-currency').addEventListener('change', (e) => {
      const c = currencies.find(x => x.code === e.target.value);
      const preview = c ? `${Number(1234567.5).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.symbol}` : '';
      el.querySelector('.summary-line').innerHTML =
        `عملة النظام الحالية: <b>${esc(c?.name || '')}</b> — مثال على العرض: <b>${esc(preview)}</b>`;
    });

    el.querySelector('#save').onclick = async () => {
      try {
        const values = {
          factory_name: el.querySelector('#f-factory').value,
          factory_phone: el.querySelector('#f-phone').value,
          factory_address: el.querySelector('#f-address').value,
          cloud_folder: el.querySelector('#f-cloud').value,
          currency: el.querySelector('#f-currency').value,
          doc_page_size: el.querySelector('#f-docsize').value,
          report_page_size: el.querySelector('#f-reportsize').value,
          // تُرسل دائماً: settings:save تمسح الجدول ثم تعيد الإدراج بما يُمرَّر إليها
          footer_right: el.querySelector('#f-foot-r').value,
          footer_center: el.querySelector('#f-foot-c').value,
          footer_left: el.querySelector('#f-foot-l').value,
        };
        await api.invoke('settings:save', values, currentUser().id);
        setCurrency(values.currency);
        el.querySelector('.summary-line').innerHTML =
          `عملة النظام الحالية: <b>${esc(currencyInfo().name)}</b> — مثال على العرض: <b>${esc(fmtMoney(1234567.5))}</b>`;
        toast('تم حفظ الإعدادات', 'ok');
      } catch (e) {
        toast(String(e.message || e), 'err');
      }
    };
  }
});
