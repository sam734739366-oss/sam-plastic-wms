export function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

export function confirmDialog(msg) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" style="min-width:340px"><h3>تأكيد</h3>
      <p style="line-height:1.8">${msg}</p>
      <div class="actions"><button class="btn danger" id="c-yes">نعم</button>
      <button class="btn" id="c-no">إلغاء</button></div></div>`;
    back.querySelector('#c-yes').onclick = () => { back.remove(); resolve(true); };
    back.querySelector('#c-no').onclick = () => { back.remove(); resolve(false); };
    document.body.appendChild(back);
  });
}

export function implicationsDialog(title, lines) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal"><h3>${title}</h3>
      <ul style="padding-right:20px;line-height:2">${lines.map(l => `<li>${l}</li>`).join('')}</ul>
      <div class="actions"><button class="btn primary" id="i-ok">فهمت، متابعة</button>
      <button class="btn" id="i-cancel">إلغاء العملية</button></div></div>`;
    back.querySelector('#i-ok').onclick = () => { back.remove(); resolve(true); };
    back.querySelector('#i-cancel').onclick = () => { back.remove(); resolve(false); };
    document.body.appendChild(back);
  });
}

export function renderTable(el, columns, rows) {
  el.innerHTML = `<table class="data"><thead><tr>${columns.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${c.render ? c.render(r) : (r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function openModal(title, bodyHtml, buttons) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal"><h3>${title}</h3>${bodyHtml}<div class="actions"></div></div>`;
  const act = back.querySelector('.actions');
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = `btn ${b.class || ''}`; btn.textContent = b.label;
    btn.onclick = () => b.onClick(back);
    act.appendChild(btn);
  }
  document.body.appendChild(back);
  return back;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
