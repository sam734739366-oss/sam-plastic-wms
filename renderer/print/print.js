const frame = document.getElementById('frame');
const paperEl = document.getElementById('paper');
const paperWrap = document.getElementById('paperWrap');
const zoomLabel = document.getElementById('zoomLabel');
const emptyEl = document.getElementById('empty');

const PAGE_W_MM = { 'A4': 210, 'A5': 148, 'A6': 105, 'letter': 216, 'legal': 216 };
let paper = 'A5';
let zoom = 1;
let fitMode = false;

function pageWidthMm(p) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*mm\s*$/i.exec(String(p || ''));
  if (m) return parseFloat(m[1]);
  return PAGE_W_MM[String(p || '').toUpperCase()] || 148;
}

function measureFrame() {
  try {
    const doc = frame.contentDocument;
    if (doc && doc.documentElement) {
      const h = doc.documentElement.scrollHeight;
      frame.style.height = (h + 6) + 'px';
    }
  } catch (e) { /* ignore */ }
}

function applyZoom() {
  const mm = pageWidthMm(paper);
  const basePx = mm * 96 / 25.4;
  if (fitMode) {
    const avail = Math.max(240, paperWrap.clientWidth - 48);
    zoom = Math.min(1.6, Math.max(0.4, avail / basePx));
  }
  zoom = Math.min(2.5, Math.max(0.4, zoom));
  paperEl.style.width = (basePx * zoom) + 'px';
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  measureFrame();
}

window.api.onPrintContent(function (payload) {
  if (payload && payload.html) {
    document.getElementById('docTitle').textContent = payload.title || 'معاينة الطباعة';
    paper = payload.paper || 'A5';
    zoom = 1;
    fitMode = false;
    paperEl.style.display = '';
    emptyEl.style.display = 'none';
    frame.srcdoc = payload.html;
    frame.onload = function () {
      applyZoom();
      try { frame.contentWindow.focus(); } catch (e) { /* ignore */ }
    };
  } else {
    paperEl.style.display = 'none';
    emptyEl.style.display = '';
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

document.getElementById('btnZoomIn').addEventListener('click', function () {
  fitMode = false; zoom += 0.1; applyZoom();
});
document.getElementById('btnZoomOut').addEventListener('click', function () {
  fitMode = false; zoom -= 0.1; applyZoom();
});
document.getElementById('btnFit').addEventListener('click', function () {
  fitMode = true; applyZoom();
});
window.addEventListener('resize', function () {
  if (fitMode) applyZoom(); else measureFrame();
});

document.getElementById('btnClose').addEventListener('click', function () {
  window.close();
});
