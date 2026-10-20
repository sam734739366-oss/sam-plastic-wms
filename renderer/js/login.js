const form = document.getElementById('login-form');
const btn = document.getElementById('login-btn');
const errEl = document.getElementById('login-error');
const card = document.querySelector('.login-card');

// توليد الجزيئات العائمة في الخلفية
(function particles() {
  const host = document.getElementById('particles');
  if (!host) return;
  const colors = ['rgba(151,184,255,.6)', 'rgba(122,158,255,.4)', 'rgba(217,164,65,.5)'];
  for (let i = 0; i < 26; i++) {
    const p = document.createElement('span');
    p.className = 'particle';
    const size = 2.5 + Math.random() * 4;
    p.style.left = (Math.random() * 100) + '%';
    p.style.width = p.style.height = size + 'px';
    p.style.background = colors[i % 3];
    p.style.animationDuration = (6.5 + Math.random() * 8) + 's';
    p.style.animationDelay = (-Math.random() * 14) + 's';
    host.appendChild(p);
  }
})();

// إظهار / إخفاء كلمة المرور
const toggleBtn = document.getElementById('toggle-pass');
const passInput = document.getElementById('password');
if (toggleBtn && passInput) {
  const eyeOpen = toggleBtn.querySelector('.eye-open');
  const eyeClosed = toggleBtn.querySelector('.eye-closed');
  toggleBtn.addEventListener('click', () => {
    const show = passInput.type === 'password';
    passInput.type = show ? 'text' : 'password';
    if (eyeOpen) eyeOpen.classList.toggle('hidden', show);
    if (eyeClosed) eyeClosed.classList.toggle('hidden', !show);
    passInput.focus();
  });
}

// اهتزاز البطاقة عند خطأ الدخول (دون تعطيل حركاتها المستمرة)
function shakeCard() {
  if (!card) return;
  card.style.transition = 'transform .07s ease';
  const seq = [0, -9, 8, -6, 4, -2, 0];
  seq.forEach((x, i) => setTimeout(() => {
    card.style.transform = x ? `translateX(${x}px)` : '';
  }, i * 55));
  setTimeout(() => { card.style.transition = ''; }, seq.length * 55 + 120);
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> جارٍ الدخول…';
  errEl.classList.add('hidden');
  errEl.classList.remove('shake');
  try {
    const u = await window.api.invoke('auth:login',
      document.getElementById('username').value, document.getElementById('password').value);
    if (!u) {
      errEl.classList.remove('hidden');
      void errEl.offsetWidth; // إعادة تشغيل حركة الاهتزاز
      errEl.classList.add('shake');
      shakeCard();
      btn.disabled = false;
      btn.innerHTML = orig;
      delete btn.dataset.busy;
      return;
    }
    sessionStorage.setItem('user', JSON.stringify(u));
    document.body.classList.add('leaving');
    setTimeout(() => { location.href = 'app.html'; }, 340);
  } catch (e) {
    errEl.textContent = String((e && e.message) || e || 'تعذر الاتصال بالبرنامج');
    errEl.classList.remove('hidden');
    shakeCard();
    btn.disabled = false;
    btn.innerHTML = orig;
    delete btn.dataset.busy;
  }
});
