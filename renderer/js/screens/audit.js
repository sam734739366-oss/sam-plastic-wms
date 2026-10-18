import { register } from '../router.js';
import { api } from '../api.js';
import { toast, renderTable, esc } from '../ui.js';

const ACTION_LABEL = { create: 'إضافة', update: 'تعديل', delete: 'حذف', void: 'إلغاء', login: 'دخول' };

register('audit', {
  title: 'سجل التدقيق',
  async mount(el) {
    const users = await api.invoke('users:list');
    el.innerHTML = `
      <div class="toolbar">
        <input id="f-from" type="date">
        <input id="f-to" type="date">
        <select id="f-user"><option value="">كل المستخدمين</option>
          ${users.map(u => `<option value="${u.id}">${esc(u.username)}</option>`).join('')}</select>
        <button class="btn primary" id="btn-run">عرض</button>
      </div>
      <div id="table-wrap"></div>`;

    async function load() {
      try {
        const rows = await api.invoke('reports:audit', {
          from: el.querySelector('#f-from').value || null,
          to: el.querySelector('#f-to').value || null,
          userId: Number(el.querySelector('#f-user').value) || null,
        });
        renderTable(el.querySelector('#table-wrap'), [
          { key: 'created_at', label: 'الوقت' },
          { key: 'user_name', label: 'المستخدم', render: r => r.user_name || '—' },
          { key: 'action', label: 'الإجراء', render: r => ACTION_LABEL[r.action] || r.action },
          { key: 'entity', label: 'الكيان' },
          { key: 'entity_id', label: 'رقم السجل', render: r => r.entity_id ?? '' },
        ], rows);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    el.querySelector('#btn-run').onclick = load;
    el.querySelectorAll('#f-from, #f-to, #f-user').forEach(s => s.onchange = load);
    await load();
  },
});
