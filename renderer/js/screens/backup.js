import { register } from '../router.js';
import { api, isManager } from '../api.js';
import { toast, confirmDialog, implicationsDialog, renderTable, esc } from '../ui.js';

function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' م.ب';
  return Math.round(bytes / 1024) + ' ك.ب';
}

register('backup', {
  title: 'النسخ الاحتياطي',
  async mount(el) {
    if (!isManager()) { el.innerHTML = '<div class="card"><p class="muted">فقط المدير يمكنه النسخ الاحتياطي والاسترجاع.</p></div>'; return; }
    let cloudFolder = '';
    try {
      const s = await api.invoke('settings:get');
      cloudFolder = (s && s.cloud_folder) || '';
    } catch { /* الإعدادات غير متاحة */ }

    el.innerHTML = `
      <div class="card">
        <div class="page-head"><h2>النسخ الاحتياطي</h2>
          <p class="muted">تُنشأ نسخة تلقائياً عند تشغيل البرنامج ويومياً وعند الإغلاق، وتُنسخ أيضاً إلى المجلد السحابي إن كان محدداً في الإعدادات.</p></div>
        <div class="actions">
          <button class="btn primary" id="btn-now">نسخ احتياطي الآن</button>
          <button class="btn" id="btn-folder">فتح مجلد النسخ</button>
        </div>
        <p class="muted" style="margin:10px 0 0;font-size:12.5px;line-height:1.9">
          المجلد السحابي الحالي: <b dir="ltr">${esc(cloudFolder || 'غير محدد — حدّده من شاشة الإعدادات')}</b>.
          اجعله مجلداً يزامنه OneDrive أو Google Drive أو أي خدمة مماثلة؛ فذلك هو نسخك الاحتياطي الثاني خارج الجهاز.
        </p>
      </div>
      <div class="card">
        <div class="page-head"><h2>إصدار القاعدة v2 والحذف النهائي</h2></div>
        <p class="muted" style="line-height:1.95;margin:0 0 8px">
          مع الإصدار 2.0.0 الحذف مادي: لا يبقى المستند معلَّقاً بحالة إلغاء، بل يُمحى هو وحركاته وقيوده من الدفتر وتُردّ الأرصدة فوراً.
          عند أول تشغيل لإصدار جديد على قاعدة قديمة (schema_version أقل من 2) ينقل النظام القاعدة القديمة كاملة
          إلى ملف <b dir="ltr">samplastic_v1_backup.db</b> بجوارها (مع ملفاتها المؤقتة) ويبني قاعدة جديدة فارغة —
          فلا يُحذف أي ملف قاعدة أبداً، ويمكن الرجوع إلى القديمة باسترجاع نسخة منها.
        </p>
        <div class="guide-tip">قبل أي استرجاع لنسخة قديمة: خذ نسخة احتياطية من الوضع الحالي أولاً، فالاسترجاع يستبدل كل البيانات.</div>
      </div>
      <div class="card">
        <div class="page-head"><h2>النسخ المحفوظة</h2></div>
        <div id="list-wrap"></div>
      </div>`;

    async function load() {
      try {
        const rows = await api.invoke('backup:list');
        renderTable(el.querySelector('#list-wrap'), [
          { key: 'name', label: 'اسم النسخة' },
          { key: 'size', label: 'الحجم', render: r => fmtSize(r.size) },
          { key: 'mtime', label: 'وقت النسخة', render: r => new Date(r.mtime).toLocaleString('ar') },
          {
            key: 'actions', label: '',
            render: (r) => `<button class="btn mini danger" data-restore="${esc(r.path)}">استرجاع</button>`,
          },
        ], rows);
        el.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => restore(b.dataset.restore));
        if (!rows.length) el.querySelector('#list-wrap').innerHTML = '<p class="muted">لا نسخ محفوظة بعد.</p>';
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function restore(filePath) {
      try {
        if (!(await confirmDialog('سيتم استبدال جميع البيانات الحالية بمحتوى هذه النسخة.'))) return;
        if (!(await implicationsDialog('استرجاع نسخة احتياطية', [
          'سيُغلق الاتصال بقاعدة البيانات الحالية وتُستبدل بالكامل بنسخة الاسترجاع.',
          'كل ما أُدخل بعد تاريخ النسخة سيُفقد نهائياً.',
          'يُنصح بعمل نسخة احتياطية الآن قبل الاسترجاع.',
        ]))) return;
        await api.invoke('backup:restore', filePath);
        toast('تم الاسترجاع بنجاح — أعد تشغيل البرنامج لتطبيق البيانات', 'ok');
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    el.querySelector('#btn-now').onclick = async () => {
      try {
        const r = await api.invoke('backup:now');
        toast('تم إنشاء النسخة: ' + r.name + (r.cloud_path ? ' (ونُسخت للمجلد السحابي)' : ''), 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    };
    el.querySelector('#btn-folder').onclick = async () => {
      try { await api.invoke('backup:openFolder'); } catch (e) { toast(String(e.message || e), 'err'); }
    };

    await load();
  },
});
