const form = document.getElementById('login-form');
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const u = await window.api.invoke('auth:login',
    document.getElementById('username').value, document.getElementById('password').value);
  if (!u) { document.getElementById('login-error').classList.remove('hidden'); return; }
  sessionStorage.setItem('user', JSON.stringify(u));
  location.href = 'app.html';
});
