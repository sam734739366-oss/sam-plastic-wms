import { register, go } from '../router.js';
import { api, currentUser } from '../api.js';
import {
  toast, renderTable, attachRowMenu, rowActions, openModal, esc, canWrite,
  itemCombo, unitOf, confirmDialog,
} from '../ui.js';import { fmtNum, today } from '../fmt.js';

// ===== استلام الإنتاج — المستند الموحّد (v2) =====
// حلّ محل «نتيجة الإنتاج» و«استلام التام»: يُختار تصريح الصرف فتظهر كراتينه،
// ويُسجَّل لكل كرتون سليم / تالف قبل / تالف بعد، فيُوزَّع الأثر تلقائياً:
//   سليم (+الفائض) → تام سليم   |   تالف بعد → تام تالف   |   تالف قبل → خام تالف
//   العجز (مصروف > منتج) يُسجَّل في الفارق بلا حركة مخزون، والفائض يُضاف للتام السليم.
// المصدر والعملة يُورَثان من تصريح الصرف، وكراتين خام العميل لا تمسّ سلات المصنع.

const BUCKET_OF = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' };

function sourceBadge(row) {
  return row.source === 'customer'
    ? `<span class="tag new">خام عميل${row.party_name ? ' — ' + esc(row.party_name) : ''}</span>`
    : '<span class="tag salem">خام المصنع</span>';
}

function varianceTag(v) {
  const n = Number(v) || 0;
  if (n > 0) return `<span class="tag talef">عجز ${fmtNum(n, 0)}</span>`;
  if (n < 0) return `<span class="tag muharraz">فائض ${fmtNum(-n, 0)}</span>`;
  return '<span class="tag salem">مطابق</span>';
}

register('production', {
  title: 'استلام الإنتاج',
  async mount(el) {
    const writable = canWrite();

    async function load() {
      const [rows, open] = await Promise.all([
        api.invoke('production:list'),
        writable ? api.invoke('issues:openForReceipt') : Promise.resolve([]),
      ]);
      el.innerHTML = `
        <div class="help-card">
          <b>استلام الإنتاج = نتيجة الإنتاج + استلام التام في مستند واحد.</b>
          اختر تصريح الصرف فيظهر كل كرتونه، تُدخل لكل كرتون: <b>سليم</b> و<b>تالف قبل</b> و<b>تالف بعد</b>،
          فيُوزّع البرنامج الأثر بنفسه: السليم (+الفائض) إلى <b>تام سليم</b>، والتالف بعد الإنتاج إلى <b>تام تالف</b>،
          والتالف قبل الإنتاج إلى <b>خام تالف</b> لصنف الخام الذي جاء منه الكرتون.
          <div class="muted" style="margin-top:6px">العجز (مصروف أكثر من منتج) يُسجَّل في الفارق بلا حركة مخزون،
            والفائض يُضاف إلى التام السليم. الأكياس تُستهلك من صنف الأكياس المرتبط بالصنف النهائي.
            وكراتين خام العميل لا تمسّ مخزون المصنع: تالفها يُخصم من عهدة العميل في سند تالف آلي.</div>
          <div class="help-actions">
            <button class="btn small" id="go-issues">تصاريح الصرف</button>
            <button class="btn small" id="go-cartons">متابعة الكراتين</button>
          </div>
        </div>
        <div class="toolbar">
          ${writable ? '<button class="btn primary" id="btn-add">+ استلام إنتاج</button>' : '<span class="muted">وضع عرض فقط — لا يمكن الإنشاء أو التعديل أو الحذف</span>'}
          <span class="spacer"></span>
          ${open.length ? `<span class="tag muharraz" style="align-self:center">تصريحات بانتظار الاستلام: ${open.length}</span>` : ''}
        </div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;

      el.querySelector('#go-issues').onclick = () => go('issues');
      el.querySelector('#go-cartons').onclick = () => go('cartons');
      if (writable) el.querySelector('#btn-add').onclick = () => form(null);

      el.querySelector('#summary').innerHTML =
        `عدد السندات: <b>${rows.length}</b> — إجمالي المنتَج المسجَّل: <b>${fmtNum(rows.reduce((a, r) => a + (Number(r.total_pieces) || 0), 0), 0)}</b> حبة`
        + ` — تام سليم: <b>${fmtNum(rows.reduce((a, r) => a + (Number(r.good_pieces) || 0) + (Number(r.surplus_pieces) || 0), 0), 0)}</b>`
        + ` — تالف: <b>${fmtNum(rows.reduce((a, r) => a + (Number(r.defect_before_pieces) || 0) + (Number(r.defect_after_pieces) || 0), 0), 0)}</b>`;

      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'issue_number', label: 'تصريح الصرف', render: r => r.issue_number ? `<span dir="ltr">${esc(r.issue_number)}</span>` : '—' },
        { key: 'source', label: 'المصدر', render: r => sourceBadge(r) },
        { key: 'fg_name', label: 'الصنف النهائي', render: r => `${esc(r.fg_code)} — ${esc(r.fg_name)}` },
        { key: 'machine_name', label: 'المكينة', render: r => r.machine_name || '—' },
        { key: 'shift_name', label: 'الوردية', render: r => r.shift_name || '—' },
        { key: 'cartons_count', label: 'الكراتين', render: r => fmtNum(r.cartons_count, 0) },
        { key: 'issued_pieces', label: 'مصروف', render: r => fmtNum(r.issued_pieces, 0) },
        { key: 'good_pieces', label: 'سليم', render: r => fmtNum(r.good_pieces, 0) },
        { key: 'defect_before_pieces', label: 'تالف قبل', render: r => fmtNum(r.defect_before_pieces, 0) },
        { key: 'defect_after_pieces', label: 'تالف بعد', render: r => fmtNum(r.defect_after_pieces, 0) },
        { key: 'variance_pieces', label: 'الفارق', render: r => varianceTag(r.variance_pieces) },
      ], rows);

      attachRowMenu(el.querySelector('#table-wrap'), (ri) => rowActions({
        id: rows[ri].id,
        entity: 'production',
        valueKind: 'pieces',
        label: 'سند استلام الإنتاج',
        view: (id) => view(id),
        print: (id) => printDoc(id),
        edit: writable ? (id) => edit(id) : null,
        reload: load,
      }));

      if (!rows.length) {
        el.querySelector('#table-wrap').innerHTML =
          '<p class="muted">لا سندات استلام بعد — سجّل تصريح صرف بكراتين مرقمة ثم افتح «+ استلام إنتاج».</p>';
      }
    }

    // ===== طباعة السند: جدول كراتين على مقاس التقارير (لا قالب خاص به بعد) =====
    async function printDoc(id) {
      try {
        const doc = await api.invoke('production:get', id);
        const settings = await api.invoke('settings:get');
        const headers = ['الكرتون', 'صنف الخام', 'حبات الكرتون', 'سليم', 'تالف قبل', 'تالف بعد', 'الفارق', 'ملاحظات'];
        const rows = (doc.cartons || []).map(c => [
          c.carton_number, `${c.raw_code} — ${c.raw_name}`, fmtNum(c.carton_pieces, 0),
          fmtNum(c.good_pieces, 0), fmtNum(c.defect_before_pieces, 0), fmtNum(c.defect_after_pieces, 0),
          fmtNum((Number(c.carton_pieces) || 0) - (Number(c.good_pieces) || 0) - (Number(c.defect_before_pieces) || 0) - (Number(c.defect_after_pieces) || 0), 0),
          c.notes || '',
        ]);
        const foot = `<div class="notes"><b>المصروف: ${fmtNum(doc.issued_pieces, 0)} — التام السليم: ${fmtNum(doc.good_pieces, 0)}`
          + ` (شاملاً فائض ${fmtNum(doc.surplus_pieces, 0)}) — تالف قبل: ${fmtNum(doc.defect_before_pieces, 0)}`
          + ` — تالف بعد: ${fmtNum(doc.defect_after_pieces, 0)} — الفارق: ${fmtNum(doc.variance_pieces, 0)}`
          + ` — أكياس مستخدمة: ${fmtNum(doc.bags_used, 0)}</b>${doc.notes ? `<div>ملاحظات: ${esc(doc.notes)}</div>` : ''}</div>`;
        await api.invoke('print:open', {
          kind: 'report', title: `استلام إنتاج — ${doc.doc_number}`, settings,
          metaLines: [
            `التاريخ: ${doc.doc_date}`,
            `تصريح الصرف: ${doc.issue_number || '—'}`,
            `الصنف النهائي: ${doc.fg_code} — ${doc.fg_name}`,
            `المخزن: ${doc.warehouse_name || '—'}`,
            `المصدر: ${doc.source === 'customer' ? `خام العميل ${doc.party_name || ''}` : 'خام المصنع'}`,
            `المكينة: ${doc.machine_name || '—'} — الوردية: ${doc.shift_name || '—'} — المستلم: ${doc.receiver_name || '—'}`,
          ],
          headers, rows: rows.map(r => r.map(v => esc(v))), foot,
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('production:get', id);
        const fgUnit = unitOf(doc);
        const rawTotals = {};
        for (const c of doc.cartons || []) {
          const k = `${c.raw_code} — ${c.raw_name}`;
          rawTotals[k] = (rawTotals[k] || 0) + (Number(c.defect_before_pieces) || 0);
        }
        openModal(`استلام إنتاج ${esc(doc.doc_number)}`, `
          <p style="line-height:2">
            <b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>المصدر:</b> ${doc.source === 'customer' ? 'خام عميل' : 'خام المصنع'}
            ${doc.party_name ? `&nbsp; <b>العميل:</b> ${esc(doc.party_name)}` : ''}<br>
            <b>تصريح الصرف:</b> <span dir="ltr">${esc(doc.issue_number || '—')}</span>
            &nbsp; <b>الصنف النهائي:</b> ${esc(doc.fg_code)} — ${esc(doc.fg_name)}
            &nbsp; <b>مخزن الاستلام:</b> ${esc(doc.warehouse_name || '—')}<br>
            <b>المكينة:</b> ${esc(doc.machine_name || '—')} &nbsp; <b>الوردية:</b> ${esc(doc.shift_name || '—')}
            &nbsp; <b>المستلم:</b> ${esc(doc.receiver_name || '—')}</p>
          <div class="recon-strip">
            <span>مصروف <b>${fmtNum(doc.issued_pieces, 0)}</b></span>
            <span>سليم <b>${fmtNum(doc.good_pieces, 0)}</b></span>
            <span>تالف قبل <b>${fmtNum(doc.defect_before_pieces, 0)}</b></span>
            <span>تالف بعد <b>${fmtNum(doc.defect_after_pieces, 0)}</b></span>
            <span>إجمالي المنتج <b>${fmtNum(doc.total_pieces, 0)}</b></span>
            <span>الفارق ${varianceTag(doc.variance_pieces)}</span>
            ${Number(doc.bags_used) > 0 ? `<span>أكياس <b>${fmtNum(doc.bags_used, 0)}</b> (كسور ${fmtNum(doc.breaks, 0)})</span>` : ''}
          </div>
          <table class="data"><thead><tr><th>الكرتون</th><th>الخام</th><th>حبات الكرتون</th><th>سليم</th><th>تالف قبل</th><th>تالف بعد</th><th>الفارق</th><th>ملاحظات</th></tr></thead>
          <tbody>${(doc.cartons || []).map(c => `<tr>
            <td><span dir="ltr">${esc(c.carton_number)}</span></td>
            <td>${esc(c.raw_code)} — ${esc(c.raw_name)}</td>
            <td>${fmtNum(c.carton_pieces, 0)}</td>
            <td>${fmtNum(c.good_pieces, 0)}</td>
            <td>${fmtNum(c.defect_before_pieces, 0)}</td>
            <td>${fmtNum(c.defect_after_pieces, 0)}</td>
            <td>${fmtNum((Number(c.carton_pieces) || 0) - (Number(c.good_pieces) || 0) - (Number(c.defect_before_pieces) || 0) - (Number(c.defect_after_pieces) || 0), 0)}</td>
            <td>${esc(c.notes || '')}</td></tr>`).join('')}</tbody></table>
          <p style="margin-top:10px;line-height:1.9"><b>أين استقرّت الكميات:</b><br>
            تام سليم (${fmtNum((Number(doc.good_pieces) || 0) + (Number(doc.surplus_pieces) || 0), 0)} ${esc(fgUnit)}) — تام تالف (${fmtNum(doc.defect_after_pieces, 0)} ${esc(fgUnit)})
            في ${esc(doc.warehouse_name || '—')}<br>
            ${Object.entries(rawTotals).map(([k, v]) => `خام تالف (${fmtNum(v, 0)}): ${esc(k)}`).join('<br>') || 'لا تالف قبل الإنتاج'}
            ${doc.source === 'customer' ? '<br><span class="tag new">خام عميل: لا سلات للمصنع — التالف كله في سند تالف آلي على عهدة العميل</span>' : ''}</p>
          ${doc.moves && doc.moves.length ? `<p style="margin-top:8px" class="muted"><b>حركات المخزون:</b> ${doc.moves.map(m =>
            `${esc(m.code)} ${m.qty_in_pieces ? `+${fmtNum(m.qty_in_pieces, 0)}` : `-${fmtNum(m.qty_out_pieces, 0)}`} ${esc(m.bucket ? BUCKET_OF[m.bucket] : '')} — ${esc(m.notes || '')}`).join(' • ')}</p>` : ''}
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { b.remove(); await printDoc(id); } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('production:get', id);
        const ok = await confirmDialog('التعديل يردّ أثر السند الحالي بالكامل ثم يعيد تطبيقه بالقيم الجديدة، والكراتين غير المدرجة تعود مصروفة بلا نتيجة. متابعة؟');
        if (!ok) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    // ===== النموذج =====
    async function form(doc) {
      const [items, warehouses, machines, shifts, openPermits] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('warehouses:list'),
        api.invoke('machines:list'),
        api.invoke('shifts:list'),
        api.invoke('issues:openForReceipt'),
      ]);
      const suggest = doc ? null : await api.invoke('production:suggest');

      // تصريح الصرف المُعدَّل به قد لا يكون في قائمة الانتظار (كراتينه أُنتجت) فيُضاف يدوياً
      const permits = [...openPermits];
      if (doc && !permits.some(p => p.id === doc.issue_permit_id)) {
        permits.unshift({
          id: doc.issue_permit_id, doc_number: doc.issue_number, doc_date: doc.doc_date,
          source: doc.source, party_id: doc.party_id, party_name: doc.party_name,
          machine_name: doc.machine_name, shift_name: doc.shift_name,
          issued_pieces: doc.issued_pieces, pending_cartons: 0,
        });
      }

      const back = openModal(doc ? `تعديل استلام إنتاج ${esc(doc.doc_number)}` : 'سند استلام إنتاج جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم السند *</label><input id="f-num" value="${esc(doc ? doc.doc_number : (suggest || ''))}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field full"><label>تصريح الصرف *</label>
            <select id="f-issue"><option value="">— اختر تصريحاً لديه كراتين مصروفة —</option>
              ${permits.map(p => `<option value="${p.id}" ${doc && doc.issue_permit_id === p.id ? 'selected' : ''}>
                ${esc(p.doc_number)} — ${esc(p.doc_date)}${p.machine_name ? ' — ' + esc(p.machine_name) : ''}${p.party_name ? ' — خام ' + esc(p.party_name) : ''} (كراتين بانتظار: ${fmtNum(p.pending_cartons, 0)})</option>`).join('')}
            </select>
            <span class="muted" style="font-size:11px">المصدر والعميل يُورَثان من التصريح — لا يُختاران هنا</span></div>
          <div class="field"><label>الصنف النهائي المنتَج *</label><div id="f-fg-wrap"></div></div>
          <div class="field"><label>مخزن استلام التام *</label>
            <select id="f-wh">${warehouses.map(w => `<option value="${w.id}" ${doc && doc.warehouse_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
          <div class="field"><label>المكينة</label>
            <select id="f-machine"><option value="">—</option>
              ${machines.map(m => `<option value="${m.id}" ${(doc ? doc.machine_id : null) === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
          <div class="field"><label>الوردية</label>
            <select id="f-shift"><option value="">—</option>
              ${shifts.map(s => `<option value="${s.id}" ${(doc ? doc.shift_id : null) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
          <div class="field"><label>اسم المستلم</label><input id="f-receiver" value="${esc(doc ? doc.receiver_name || '' : '')}"></div>
          <div class="field"><label>المصدر (من التصريح)</label><div id="f-source" class="muted">—</div></div>
        </div>
        <div id="permit-line" class="summary-line" style="margin:6px 0 10px"></div>
        <h4 class="del-h">كراتين التصريح — أدخل النتيجة لكل كرتون</h4>
        <table class="doc-lines carton-lines">
          <thead><tr>
            <th>الكرتون</th><th>صنف الخام</th><th>حبات الكرتون</th>
            <th>سليم</th><th>تالف قبل</th><th>تالف بعد</th><th>فارق الكرتون</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="crow"></tbody>
        </table>
        <p id="carton-empty" class="muted">اختر تصريح الصرف لعرض كراتينه.</p>
        <div class="recon-strip" id="recon"></div>
        <div class="form-grid" style="margin-top:10px">
          <div class="field"><label>أكياس مكتملة</label><input id="f-bags" type="number" min="0" step="1" value="${doc ? doc.bags || 0 : 0}"></div>
          <div class="field"><label>كسور (حبات بعد آخر كيس)</label><input id="f-breaks" type="number" min="0" step="1" value="${doc ? doc.breaks || 0 : 0}"></div>
          <div class="field full"><label>ملاحظات</label><textarea id="f-notes" rows="2">${esc(doc ? doc.notes || '' : '')}</textarea></div>
        </div>
        <p id="bag-line" class="muted" style="line-height:1.8"></p>`,
        [{
          label: 'حفظ', class: 'primary', onClick: async (b) => {
            try {
              const cartons = cartonLines(b);
              if (!b.querySelector('#f-issue').value) throw new Error('اختر تصريح الصرف أولاً');
              const fgId = Number(b.querySelector('#f-fg-wrap .p-item').value);
              if (!fgId) throw new Error('اختر الصنف النهائي المنتَج');
              if (!b.querySelector('#f-wh').value) throw new Error('اختر مخزن استلام التام');
              if (!cartons.length) throw new Error('أدخل نتيجة كرتون واحد على الأقل');
              const fg = items.find(i => i.id === fgId);
              const bags = Number(b.querySelector('#f-bags').value) || 0;
              const breaks = Number(b.querySelector('#f-breaks').value) || 0;
              if (bags > 0 || breaks > 0) {
                const per = Number(fg.pieces_per_bag) || 0;
                if (per <= 0) throw new Error(`الصنف ${fg.code} ليس له «عدد القطع في الكيس» — أضفه من شاشة الأصناف أو اترك الأكياس فارغة`);
                if (!fg.bag_item_id) throw new Error(`الصنف ${fg.code} غير مربوط بصنف أكياس — اربطه من شاشة الأصناف أو اترك الأكياس فارغة`);
                const packed = bags * per + breaks;
                const rec = await api.invoke('production:reconcile', { cartons });
                if (packed > rec.fg_good) throw new Error(`الأكياس المُدخلة (${fmtNum(packed, 0)} حبة) تتجاوز التام السليم (${fmtNum(rec.fg_good, 0)} حبة)`);
              }
              const res = await api.invoke('production:save', {
                id: doc ? doc.id : null,
                doc_number: b.querySelector('#f-num').value,
                doc_date: b.querySelector('#f-date').value,
                issue_permit_id: Number(b.querySelector('#f-issue').value),
                fg_item_id: fgId,
                warehouse_id: Number(b.querySelector('#f-wh').value),
                machine_id: b.querySelector('#f-machine').value ? Number(b.querySelector('#f-machine').value) : null,
                shift_id: b.querySelector('#f-shift').value ? Number(b.querySelector('#f-shift').value) : null,
                receiver_name: b.querySelector('#f-receiver').value || null,
                notes: b.querySelector('#f-notes').value || null,
                bags, breaks, cartons,
              }, currentUser().id);
              b.remove();
              const v = Number(res.variance) || 0;
              toast(`تم حفظ السند — التام السليم ${fmtNum(res.good, 0)} حبة`
                + (v > 0 ? ` — عجز ${fmtNum(v, 0)} مسجّل في الفارق` : v < 0 ? ` — فائض ${fmtNum(-v, 0)} أُضيف للتام السليم` : ' — مطابق'), 'ok');
              await load();
            } catch (e) { toast(String(e.message || e), 'err'); }
          },
        },
        { label: 'إلغاء', onClick: (b) => b.remove() }]);

      const itemById = (id) => items.find(i => i.id === Number(id));
      const crow = back.querySelector('#crow');
      const emptyMsg = back.querySelector('#carton-empty');
      const reconEl = back.querySelector('#recon');
      const permitLine = back.querySelector('#permit-line');
      const bagLine = back.querySelector('#bag-line');
      const fgCombo = itemCombo(items, () => { back.querySelector('#f-fg-wrap .p-item').dispatchEvent(new Event('change')); });
      back.querySelector('#f-fg-wrap').appendChild(fgCombo.box);
      let permit = null;

      // ===== الكراتين =====
      // في التعديل تُدمج كراتين السند المسجّلة (حالتها finished) مع كراتين التصريح التي لم تُستلم بعد
      function cartonLines(root) {
        return [...root.querySelectorAll('.crow')].map(r => {
          const g = Number(r.querySelector('.c-good').value) || 0;
          const b1 = Number(r.querySelector('.c-before').value) || 0;
          const a1 = Number(r.querySelector('.c-after').value) || 0;
          if (g + b1 + a1 <= 0) return null;   // السطر الفارغ لا يُرسَل: الخلفية ترفضه
          return {
            carton_id: Number(r.dataset.cid),
            good_pieces: g,
            defect_before_pieces: b1,
            defect_after_pieces: a1,
            notes: r.querySelector('.c-notes').value || null,
          };
        }).filter(Boolean);
      }

      function addCartonRow(c) {
        const tr = document.createElement('tr');
        tr.className = 'crow';
        tr.dataset.cid = String(c.carton_id);
        tr.dataset.cno = c.carton_number;
        tr.dataset.pieces = String(c.pieces);
        tr.dataset.raw = c.raw_code;
        tr.dataset.rawname = c.raw_name;
        tr.innerHTML = `
          <td><span dir="ltr">${esc(c.carton_number)}</span></td>
          <td>${esc(c.raw_code)} — ${esc(c.raw_name)}</td>
          <td>${fmtNum(c.pieces, 0)} <span class="muted">${esc(unitOf({ unit_name: c.raw_unit }))}</span></td>
          <td><input class="c-good num" type="number" min="0" step="1" value="${c.good_pieces ?? 0}"></td>
          <td><input class="c-before num" type="number" min="0" step="1" value="${c.defect_before_pieces ?? 0}"></td>
          <td><input class="c-after num" type="number" min="0" step="1" value="${c.defect_after_pieces ?? 0}"></td>
          <td class="c-rest muted">—</td>
          <td><input class="c-notes" placeholder="ملاحظات" value="${esc(c.notes || '')}"></td>
          <td class="del"><button class="btn mini danger c-del" type="button">×</button></td>`;
        crow.appendChild(tr);
        tr.querySelector('.c-del').onclick = async () => {
          if (Number(tr.dataset.saved) === 1
            && !(await confirmDialog('هذا الكرتون مُسجَّل في السند المحفوظ: إخفاؤه من القائمة يعني ألّا يُستلم له شيء ويعود مصروفاً بلا نتيجة. متابع؟'))) return;
          tr.remove(); refresh();
        };
        tr.querySelectorAll('.c-good, .c-before, .c-after').forEach(inp => { inp.oninput = refresh; });
        return tr;
      }

      async function loadCartons(permitId, keepExisting) {
        if (!keepExisting) crow.innerHTML = '';
        if (!permitId) { emptyMsg.textContent = 'اختر تصريح الصرف لعرض كراتينه.'; refresh(); return; }
        let fresh = [];
        try { fresh = await api.invoke('production:cartonsForIssue', Number(permitId)); } catch (e) { toast(String(e.message || e), 'err'); }
        if (!keepExisting) {
          if (!fresh.length) {
            emptyMsg.textContent = 'لا كراتين مصروفة بانتظار النتيجة على هذا التصريح — كلها مُستلمة أو لم يُصرف منه شيء.';
          } else {
            emptyMsg.textContent = '';
            for (const c of fresh) addCartonRow(c);
          }
        } else {
          // التعديل: كراتين السند أولاً (بقيمها المحفوظة) ثم ما بقي مصروفاً بلا نتيجة
          emptyMsg.textContent = '';
          const seen = new Set();
          for (const c of (doc && doc.cartons ? doc.cartons : [])) {
            seen.add(c.carton_id);
            const tr = addCartonRow({
              carton_id: c.carton_id, carton_number: c.carton_number, pieces: c.carton_pieces,
              raw_code: c.raw_code, raw_name: c.raw_name, raw_unit: c.raw_unit,
              good_pieces: c.good_pieces, defect_before_pieces: c.defect_before_pieces,
              defect_after_pieces: c.defect_after_pieces, notes: c.notes,
            });
            tr.dataset.saved = '1';
          }
          for (const c of fresh) if (!seen.has(c.carton_id)) addCartonRow(c);
          if (!doc.cartons.length && !fresh.length) emptyMsg.textContent = 'لا كراتين على هذا التصريح.';
        }
        refresh();
      }

      function renderPermit() {
        const pid = Number(back.querySelector('#f-issue').value);
        permit = permits.find(p => p.id === pid) || null;
        if (!permit) {
          permitLine.innerHTML = '<span class="muted">لم يُختر تصريح بعد.</span>';
          back.querySelector('#f-source').textContent = '—';
          return;
        }
        back.querySelector('#f-source').innerHTML = permit.source === 'customer'
          ? `خام عميل — ${esc(permit.party_name || 'بدون اسم')}`
          : 'خام المصنع';
        permitLine.innerHTML = `تصريح <b dir="ltr">${esc(permit.doc_number)}</b> (${esc(permit.doc_date)}) —`
          + ` المكينة: <b>${esc(permit.machine_name || '—')}</b> — الوردية: <b>${esc(permit.shift_name || '—')}</b> —`
          + ` المصروف من كراتينه: <b>${fmtNum(permit.issued_pieces, 0)}</b> حبة — كراتين بانتظار النتيجة: <b>${fmtNum(permit.pending_cartons, 0)}</b>`
          + (permit.source === 'customer' ? ' — <span class="tag new">عهدة عميل: لا سلات للمصنع</span>' : '');
        // المكينة والوردية تُورَثان من التصريح إن لم تُختارا
        if (!back.querySelector('#f-machine').value && permit.machine_id) back.querySelector('#f-machine').value = String(permit.machine_id);
        if (!back.querySelector('#f-shift').value && permit.shift_id) back.querySelector('#f-shift').value = String(permit.shift_id);
      }

      // ===== شريط التسوية الحي =====
      async function refresh() {
        const lines = cartonLines(back);
        for (const tr of crow.querySelectorAll('.crow')) {
          const g = Number(tr.querySelector('.c-good').value) || 0;
          const b1 = Number(tr.querySelector('.c-before').value) || 0;
          const a1 = Number(tr.querySelector('.c-after').value) || 0;
          const rest = (Number(tr.dataset.pieces) || 0) - (g + b1 + a1);
          const cell = tr.querySelector('.c-rest');
          cell.textContent = g + b1 + a1 === 0 ? '—'
            : rest > 0 ? `عجز ${fmtNum(rest, 0)}` : rest < 0 ? `فائض ${fmtNum(-rest, 0)}` : 'مطابق';
          cell.className = 'c-rest ' + (rest > 0 ? 'danger-text' : rest < 0 ? 'muted' : 'ok-text');
        }
        const fg = itemById(back.querySelector('#f-fg-wrap .p-item').value);
        const per = Number(fg && fg.pieces_per_bag) || 0;
        const bags = Number(back.querySelector('#f-bags').value) || 0;
        const breaks = Number(back.querySelector('#f-breaks').value) || 0;
        const packed = per > 0 ? bags * per + breaks : 0;
        const usedBags = per > 0 ? Math.ceil(packed / per) : 0;
        bagLine.innerHTML = fg
          ? (per > 0
            ? `كيس الصنف ${esc(fg.code)} = <b>${fmtNum(per, 0)}</b> ${esc(unitOf(fg))}`
              + (packed ? ` — المُدخل <b>${fmtNum(packed, 0)}</b> ${esc(unitOf(fg))} في <b>${fmtNum(usedBags, 0)}</b> كيس (يُخصم من صنف الأكياس المرتبط)` : '')
              + (fg.bag_item_id ? '' : ' — <span class="danger-text">الصنف غير مربوط بصنف أكياس: اترك الأكياس فارغة أو اربطه من شاشة الأصناف</span>')
            : `الصنف ${esc(fg.code)} ليس له «حبات الكيس» — املأها من شاشة الأصناف إن أردت تسجيل أكياس`)
          : 'اختر الصنف النهائي أولاً';
        if (!lines.length) { reconEl.innerHTML = '<span class="muted">لا نتيجة مُدخلة بعد — التسوية تظهر هنا أثناء الكتابة.</span>'; return; }
        let rec;
        try { rec = await api.invoke('production:reconcile', { cartons: lines }); } catch (e) { toast(String(e.message || e), 'err'); return; }
        const rawDefects = new Map();
        for (const tr of crow.querySelectorAll('.crow')) {
          const b1 = Number(tr.querySelector('.c-before').value) || 0;
          if (b1 > 0) rawDefects.set(tr.dataset.raw, (rawDefects.get(tr.dataset.raw) || 0) + b1);
        }
        const cust = permit && permit.source === 'customer';
        const fgUnit = fg ? unitOf(fg) : 'حبة';
        reconEl.innerHTML = `
          <div class="recon-row">
            <span>مصروف <b>${fmtNum(rec.issued, 0)}</b></span>
            <span>سليم <b>${fmtNum(rec.good, 0)}</b></span>
            <span>تالف قبل <b>${fmtNum(rec.defect_before, 0)}</b></span>
            <span>تالف بعد <b>${fmtNum(rec.defect_after, 0)}</b></span>
            <span>إجمالي المنتج <b>${fmtNum(rec.total, 0)}</b></span>
            <span>الفارق ${varianceTag(rec.variance)}${rec.shortage ? ` — عجز ${fmtNum(rec.shortage, 0)}` : ''}${rec.surplus ? ` — فائض ${fmtNum(rec.surplus, 0)}` : ''}</span>
          </div>
          <div class="recon-row recon-land">
            ${cust
              ? `<span>تالف خام العميل <b>${fmtNum(rec.defect_before + rec.defect_after, 0)}</b> → سند تالف آلي على عهدة <b>${esc(permit.party_name || '')}</b> (بلا حركة على سلات المصنع)</span>`
              : `<span>تام سليم <b>${fmtNum(rec.fg_good, 0)} ${esc(fgUnit)}</b> → سلة <b>سليم</b></span>
                 <span>تام تالف <b>${fmtNum(rec.defect_after, 0)} ${esc(fgUnit)}</b> → سلة <b>تالف</b></span>
                 <span>خام تالف <b>${fmtNum(rec.defect_before, 0)}</b> → ${rawDefects.size
                  ? [...rawDefects].map(([k, v]) => `<b>${fmtNum(v, 0)}</b> (${esc(k)})`).join('، ')
                  : 'لا شيء'} → سلة <b>تالف</b> لصنف الخام</span>`}
            ${rec.shortage ? `<span>العجز <b>${fmtNum(rec.shortage, 0)}</b> يُسجَّل نصاً في الفارق بلا حركة مخزون</span>` : ''}
            ${usedBags > 0 ? `<span>أكياس <b>${fmtNum(usedBags, 0)}</b> → تُخصم من صنف الأكياس (سلة <b>سليم</b>)</span>` : ''}
          </div>`;
      }

      back.querySelector('#f-issue').onchange = async () => {
        renderPermit();
        await loadCartons(back.querySelector('#f-issue').value, false);
      };
      back.querySelector('#f-fg-wrap').addEventListener('change', () => refresh());
      back.querySelector('#f-bags').oninput = () => refresh();
      back.querySelector('#f-breaks').oninput = () => refresh();
      back.querySelector('#f-wh').onchange = () => refresh();

      if (doc) {
        fgCombo.setValue(doc.fg_item_id);
        renderPermit();
        await loadCartons(doc.issue_permit_id, true);
      } else {
        renderPermit();
        refresh();
      }
    }

    await load();
  },
});
