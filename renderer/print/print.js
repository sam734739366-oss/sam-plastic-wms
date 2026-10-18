const frame = document.getElementById('frame');

window.api.onPrintContent(function (payload) {
  if (payload && payload.html) {
    document.getElementById('docTitle').textContent = payload.title || 'معاينة الطباعة';
    frame.srcdoc = payload.html;
    frame.onload = function () {
      try { frame.contentWindow.focus(); } catch (e) { /* ignore */ }
    };
  }
});

document.getElementById('btnPrint').addEventListener('click', function () {
  try {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch (e) {
    alert('تعذرت الطباعة: ' + e.message);
  }
});

document.getElementById('btnClose').addEventListener('click', function () {
  window.close();
});
