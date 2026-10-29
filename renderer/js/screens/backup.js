import { register } from '../router.js';
import { api, currentUser, isManager } from '../api.js';
import { toast, confirmDialog, implicationsDialog, openModal, renderTable, esc } from '../ui.js';

function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' م.ب';
  return Math.round(bytes / 1024) + ' ك.ب';
}

// تقرير الإصلاح بصيغة مقروءة — يُستخدم للمعاينة قبل التنفيذ وللملخص بعده
function reportHtml(report) {
  if (!report.items.length) {
    return '<p class="muted">لا توجد حركات تالف قديمة على كراتين خام عميل — لا شيء يُصلح.</p>';
  }
  const groups = report.items.map((g) => `
    <div style="margin:10px 0 4px"><b>${esc(g.code || '—')} ${esc(g.name || '')}</b>
      &nbsp; عدّاد التالف ${fmtNum(g.qty_talef)} − ${fmtNum(g.total)} = ${fmtNum(g.after)}
      ${g.shortfall ? '<span class="tag talef">العدّاد لا يكفي — سيُترك للمراجعة</span>' : ''}</div>
    <table class="mini"><tbody>${g.cartons.map((c) => `<tr>
        <td>${esc(c.cartonNumber)}</td><td>${fmtNum(c.defects)} حبة</td>
        <td>${c.viaCarton ? 'كرتون عميل' : 'تصريح عميل'}</td>
        <td>${esc(c.owner || 'بلا عميل')}</td>
        <td>${c.hasScrapDoc ? 'سند التالف موجود' : 'بلا سند'}</td></tr>`).join('')}</tbody></table>`).join('');
  const warn = [];
  if (report.orphans.length) warn.push(`كراتين بلا نتيجة إنتاج محفوظة (تالف يتيم): ${report.orphans.length}`);
  if (report.insufficient.length) warn.push(`أصناف تتجاوز الخصم عدّادها وتُترك للمراجعة: ${report.insufficient.map((i) => i.code || '—').join('، ')}`);
  return `
    <p class="muted" style="margin:0">حركات قديمة: <b>${fmtNum(report.rowCount)}</b>
      &nbsp; كراتين: <b>${fmtNum(report.cartonCount)}</b>
      &nbsp; إجمالي التالف المنقول: <b>${fmtNum(report.totalDefects)}</b> حبة
      &nbsp; سندات عملاء ناقصة: <b>${fmtNum(report.missingScrap.length)}</b></p>
    ${warn.length ? `<div class="g-tip" style="border:1px solid #f3ddb0;background:#fef9ec;border-radius:8px;padding:8px 12px;margin:10px 0">${warn.map(esc).join('<br>')}</div>` : ''}
    ${groups}`;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
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
          <button class="btn" id="btn-legacy">إصلاح البيانات القديمة</button>
        </div>
        <p class="muted" style="margin:8px 0 0;font-size:12px">
          «إصلاح البيانات القديمة» ينقل تالف الإنتاج المسجَّل خطأً في مخزون المصنع على كراتين خام العميل
          إلى رصيد العميل نفسه، ويُخصم من عداد تالف الصنف. تُنشأ نسخة احتياطية تلقائياً قبل أي تغيير،
          ولا يُمسّ أي صنف لا يتّسع عدّاده للخصم.
        </p>
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

    // إصلاح البيانات القديمة: معاينة ← تأكيد ← تنفيذ (نسخة احتياطية ثم خصم وحذف ثم تحقّق)
    el.querySelector('#btn-legacy').onclick = async () => {
      let report;
      try { report = await api.invoke('backup:legacyReport'); }
      catch (e) { toast(String(e.message || e), 'err'); return; }
      if (!report.items.length) { toast('لا شيء يُصلح — لا توجد حركات تالف قديمة على كراتين العملاء', 'ok'); return; }
      openModal('إصلاح البيانات القديمة — معاينة', reportHtml(report), [
        { label: 'إصلاح مع سندات العملاء', class: 'primary', onClick: (b) => { b.remove(); runFix(false); } },
        { label: 'إصلاح بدون سندات', onClick: (b) => { b.remove(); runFix(true); } },
        { label: 'إلغاء', onClick: (b) => b.remove() },
      ]);
    };

    async function runFix(skipScrapDocs) {
      try {
        const ok = await implicationsDialog('تأكيد إصلاح البيانات القديمة', [
          'تُنشأ نسخة احتياطية تلقائياً قبل أي تغيير، وتظهر في قائمة النسخ أدناه.',
          'سيُخصم تالف الكراتين من عدّادات تالف أصناف المصنع وتُحذف حركاته القديمة.',
          'الأصناف التي لا يتّسع عدّادها للخصم تُترك بلا تغيير وتحتاج مراجعة يدوية.',
          skipScrapDocs ? 'لن تُنشأ سندات تالف للعملاء، فيبقى التالف غير محمول على أرصدتهم.'
            : 'ستُنشأ سندات تالف تحمل التالف على رصيد كل عميل.',
        ]);
        if (!ok) return;
        const r = await api.invoke('backup:legacyFix', { skipScrapDocs }, currentUser().id);
        const d = r.done;
        const bad = d.skipped.length > 0 || r.check.residual > 0 || r.check.perItem.some((p) => !p.match);
        const lines = [
          `حركات تالف قديمة حُذفت: ${fmtNum(d.removed)}`,
          `حبات خُصمت من عدّادات تالف المصنع: ${fmtNum(d.subtracted)}`,
          skipScrapDocs ? 'سندات تالف للعملاء: لم تُنشأ' : `سندات تالف جديدة للعملاء: ${fmtNum(d.createdScrap)}`,
          r.backup ? `النسخة الاحتياطية: ${r.backup.name}` : 'لا حاجة لنسخة احتياطية — لم يوجد ما يُصلح',
          r.check.residual ? `⚠ حركات قديمة متبقية: ${fmtNum(r.check.residual)}` : 'الحركات القديمة المتبقية: 0',
          ...d.skipped.map((s) => `⚠ صنف ${s.code}: العدّاد ${fmtNum(s.counter)} والمطلوب ${fmtNum(s.need)} — تُرك للمراجعة`),
          ...r.check.perItem.filter((p) => !p.match).map((p) => `⚠ صنف ${p.code}: عدّاد=${fmtNum(p.counter)} صافي الحركات=${fmtNum(p.net)} غير متطابق`),
        ];
        openModal('نتيجة إصلاح البيانات القديمة',
          `<p style="margin:0 0 8px"><b>${bad ? 'تم جزئياً — يحتاج مراجعة' : 'تم بنجاح'}</b></p>
           <ul style="margin:0;padding-right:20px;line-height:1.9">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`,
          [{ label: 'إغلاق', class: 'primary', onClick: (b) => b.remove() }]);
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    await load();
  },
});
