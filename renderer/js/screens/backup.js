import { register } from '../router.js';
import { api, currentUser, isManager } from '../api.js';
import { toast, confirmDialog, implicationsDialog, renderTable, esc } from '../ui.js';

function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' م.ب';
  return Math.round(bytes / 1024) + ' ك.ب';
}

register('backup', {
  title: 'النسخ الاحتياطي',
  async mount(el) {
    if (!isManager()) { el.innerHTML = '<div class="card"><p class="muted">فقط المدير يمكنه النسخ الاحتياطي والاسترجاع.</p></div>'; return; }
    el.innerHTML = `
      <div class="card">
        <div class="page-head"><h2>النسخ الاحتياطي</h2>
          <p class="muted">تُحفظ نسخة تلقائياً عند إغلاق البرنامج ويومياً، وتُنسخ أيضاً إلى المجلد السحابي إن حُدد في الإعدادات.</p></div>
        <div class="actions">
          <button class="btn primary" id="btn-now">نسخ احتياطي الآن</button>
          <button class="btn" id="btn-folder">فتح مجلد النسخ</button>
        </div>
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
