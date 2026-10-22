// ===== رسومات بيانية SVG خالصة =====
// تعمل دون اتصال بالإنترنت ودون أي مكتبات خارجية، وتُرسم باحترافية متناسقة مع هوية الواجهة.
import { fmtNum } from './fmt.js';

const num = (n) => Number(n) || 0;

function trim(x) {
  const r = Math.round(x * 100) / 100;
  return String(r).replace(/\.0+$/, '').replace(/(\.\d)0+$/, '$1');
}

// صيغة مختصرة للمبالغ الكبيرة على محاور الرسوم: 12500000 → 12.5 مليون
export function compact(v) {
  const abs = Math.abs(num(v));
  if (abs >= 1e9) return trim(num(v) / 1e9) + ' مليار';
  if (abs >= 1e6) return trim(num(v) / 1e6) + ' مليون';
  if (abs >= 1e3) return trim(num(v) / 1e3) + ' ألف';
  return trim(num(v));
}

// أعمدة مزدوجة لآخر 6 أشهر (مبيعات/مشتريات) — الأشهر من اليمين (الأقدم) إلى اليسار (الأحدث)
export function monthlyBars({ labels, series }) {
  const W = 760, H = 280;
  const padR = 8, padL = 8, padT = 30, padB = 36;
  const plotW = W - padR - padL;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...series.flatMap((s) => s.values.map(num)));
  const n = labels.length;
  const slot = plotW / n;
  const bw = Math.min(30, slot * 0.3);
  const gap = 6;

  let inner = '';
  // خطوط الشبكة الأفقية وتسميات القيم
  const grid = 4;
  for (let g = 0; g <= grid; g++) {
    const val = (max * g) / grid;
    const y = padT + plotH - (plotH * g) / grid;
    inner += `<line x1="${padR}" y1="${y}" x2="${W - padL}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`;
    inner += `<text x="${padR + 4}" y="${y - 4}" font-size="10" fill="#94a3b8" text-anchor="start">${compact(val)}</text>`;
  }
  // الأعمدة
  series.forEach((s, si) => {
    s.values.forEach((v, i) => {
      const h = (num(v) / max) * plotH;
      if (h <= 0) return;
      const right = padR + plotW - i * slot; // الحافة اليمنى لفتحة الشهر (الاتجاه من اليمين لليسار)
      const center = right - slot / 2;
      const x = si === 0 ? center - gap / 2 - bw : center + gap / 2;
      const y = padT + plotH - h;
      inner += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${Math.max(h, 1.5).toFixed(1)}" rx="4" fill="${s.color}"><title>${s.name} — ${labels[i]}: ${fmtNum(v)}</title></rect>`;
      inner += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="9.5" fill="#64748b" text-anchor="middle">${compact(num(v))}</text>`;
    });
  });
  // تسميات الأشهر
  labels.forEach((lb, i) => {
    const right = padR + plotW - i * slot;
    const center = right - slot / 2;
    inner += `<text x="${center.toFixed(1)}" y="${H - 12}" font-size="11" fill="#64748b" text-anchor="middle">${lb}</text>`;
  });

  const legend = '<div class="chart-legend">'
    + series.map((s) => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.name}</span>`).join('')
    + '</div>';
  return legend + `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img">${inner}</svg></div>`;
}

// دائرة مجوفة (دونات) لتوزيع سليم/تالف/محرز مع وسيلة إيضاح مفصلة
export function donut({ segments, centerLabel = 'حبة' }) {
  const total = segments.reduce((a, s) => a + num(s.value), 0);
  if (total <= 0) return '';
  const R = 84, C = 120, SW = 30;
  let inner = `<g transform="rotate(-90 ${C} ${C})">`;
  let cum = 0;
  for (const s of segments) {
    const pct = (num(s.value) / total) * 100;
    if (pct > 0) {
      inner += `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${SW}" pathLength="100" stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}" stroke-dashoffset="${(-cum).toFixed(2)}"><title>${s.label}: ${fmtNum(s.value, 0)} ${centerLabel}</title></circle>`;
    }
    cum += pct;
  }
  inner += '</g>';
  inner += `<text x="${C}" y="${C - 5}" font-size="19" font-weight="800" fill="#0f172a" text-anchor="middle">${fmtNum(total, 0)}</text>`;
  inner += `<text x="${C}" y="${C + 16}" font-size="11" fill="#94a3b8" text-anchor="middle">إجمالي ${centerLabel}</text>`;
  const legend = '<div class="chart-legend donut-legend">'
    + segments.map((s) => {
      const pct = total ? (num(s.value) / total) * 100 : 0;
      return `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span><span>${s.label}: <b>${fmtNum(s.value, 0)}</b> (${trim(pct)}٪)</span></span>`;
    }).join('')
    + '</div>';
  return `<div class="donut-flex"><div class="chart-wrap donut-svg"><svg viewBox="0 0 240 240" role="img">${inner}</svg></div>${legend}</div>`;
}

// أشرطة أفقية (RTL): التسمية يميناً والشريط يمتد نحو اليسار، والقيمة داخل الشريط إن اتسع
let uid = 0;
export function hBars({ rows, color = '#3b6cf0', color2, fmt = (v) => fmtNum(v) }) {
  uid += 1;
  const gid = `hbg${uid}`;
  const max = Math.max(1, ...rows.map((r) => num(r.value)));
  const W = 760, RH = 48;
  const H = rows.length * RH + 12;
  const labelW = 190;
  const barX0 = labelW + 18;              // بداية منطقة الأشرطة (يمين)
  const barW = W - barX0 - 30;            // أقصى طول للشريط
  let defs = '';
  let fill = color;
  if (color2) {
    defs = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">`
      + `<stop offset="0" stop-color="${color2}"/><stop offset="1" stop-color="${color}"/>`
      + '</linearGradient></defs>';
    fill = `url(#${gid})`;
  }
  let inner = defs;
  rows.forEach((r, i) => {
    const cy = 8 + i * RH + 10;
    const v = num(r.value);
    const len = (v / max) * barW;
    const rightEdge = barX0 + barW;       // الحافة اليمنى الثابتة للشريط
    const lx = rightEdge - len;           // الشريط يمتد نحو اليسار
    const label = String(r.label || '');
    const clipped = label.length > 26 ? label.slice(0, 25) + '…' : label;
    inner += `<text x="${barX0 - 14}" y="${cy + 13}" font-size="12" fill="#334155" text-anchor="end">${clipped}</text>`;
    inner += `<rect x="${lx.toFixed(1)}" y="${cy}" width="${Math.max(len, 2).toFixed(1)}" height="22" rx="8" fill="${fill}"><title>${label}: ${fmt(v)}</title></rect>`;
    if (len > barW * 0.55) {
      // القيمة داخل الشريط بلون أبيض عند طرفه الأيمن
      inner += `<text x="${rightEdge - 12}" y="${cy + 15}" font-size="11.5" font-weight="700" fill="#fff" text-anchor="end">${fmt(v)}</text>`;
    } else {
      inner += `<text x="${(lx - 9).toFixed(1)}" y="${cy + 15}" font-size="11.5" fill="#64748b" text-anchor="end">${fmt(v)}</text>`;
    }
  });
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img">${inner}</svg></div>`;
}
