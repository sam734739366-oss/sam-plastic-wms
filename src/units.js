const GRAMS_PER_KG = 1000;

// وحدات الصنف الأساسية (وحدة واحدة لكل صنف)
const BASE_UNITS = ['علبة', 'حبة', 'غطاء', 'كيس', 'كرتون', 'امبول'];

function weightToPieces(weightKg, weightGrams) {
  if (!weightGrams) throw new Error('الصنف ليس له وزن جرام — أدخل الكمية بالعدد');
  return Math.round((weightKg * GRAMS_PER_KG) / weightGrams);
}

function needPack(q, per, packName) {
  if (!per) throw new Error(`الصنف ليس له عدد حبات في ${packName}`);
  return Math.round(q * per);
}

function toPieces(quantity, unit, item = {}) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q < 0) throw new Error('كمية غير صالحة');
  // وحدة الصنف الأساسية أو القطعة/الحبة دائماً تعني قطعة واحدة
  if (unit === item.unit_name || unit === 'قطعة' || unit === 'حبة') return Math.round(q);
  switch (unit) {
    case 'علبة': case 'غطاء': case 'امبول': return Math.round(q);
    case 'كرتون': return needPack(q, item.pieces_per_carton, 'الكرتون');
    case 'شدة': return needPack(q, item.pieces_per_shadda, 'الشدة');
    case 'كيس': return needPack(q, item.pieces_per_bag, 'الكيس');
    case 'كجم': return weightToPieces(q, item.weight_grams);
    case 'طن': return weightToPieces(q * 1000, item.weight_grams);
    default: throw new Error(`وحدة غير معروفة: ${unit}`);
  }
}

// وحدات الإدخال المتاحة لصنف في مستند: وحدته الأساسية + العبوات + الوزن
function unitOptions(item = {}) {
  const opts = [{ value: item.unit_name || 'حبة', label: item.unit_name || 'حبة' }];
  if (item.pieces_per_carton && item.unit_name !== 'كرتون') opts.push({ value: 'كرتون', label: `كرتون (${item.pieces_per_carton})` });
  if (item.pieces_per_shadda) opts.push({ value: 'شدة', label: `شدة (${item.pieces_per_shadda})` });
  if (item.pieces_per_bag && item.unit_name !== 'كيس') opts.push({ value: 'كيس', label: `كيس (${item.pieces_per_bag})` });
  if (item.weight_grams) opts.push({ value: 'كجم', label: 'كجم' }, { value: 'طن', label: 'طن' });
  return opts;
}

function piecesToWeightKg(pieces, weightGrams) {
  return (pieces * weightGrams) / GRAMS_PER_KG;
}

function fmt(n, decimals = 2) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function formatQty(pieces, item = {}) {
  const parts = [`${fmt(pieces)} ${item.unit_name || 'حبة'}`];
  if (item.pieces_per_carton && pieces >= item.pieces_per_carton) {
    const c = Math.floor(pieces / item.pieces_per_carton);
    const r = pieces % item.pieces_per_carton;
    parts.push(r > 0 ? `${fmt(c)} كرتون + ${fmt(r)} حبة` : `${fmt(c)} كرتون`);
  }
  if (item.pieces_per_shadda && pieces >= item.pieces_per_shadda) {
    const b = Math.floor(pieces / item.pieces_per_shadda);
    const r = pieces % item.pieces_per_shadda;
    parts.push(r > 0 ? `${fmt(b)} شدة + ${fmt(r)} حبة` : `${fmt(b)} شدة`);
  }
  if (item.pieces_per_bag && pieces >= item.pieces_per_bag) {
    const b = Math.floor(pieces / item.pieces_per_bag);
    const r = pieces % item.pieces_per_bag;
    parts.push(r > 0 ? `${fmt(b)} كيس + ${fmt(r)} حبة` : `${fmt(b)} كيس`);
  }
  if (item.weight_grams) {
    const kg = piecesToWeightKg(pieces, item.weight_grams);
    parts.push(kg >= 1000 ? `${fmt(kg / 1000, 3)} طن` : `${fmt(kg, 3)} كجم`);
  }
  return parts.join(' — ');
}

module.exports = { BASE_UNITS, toPieces, unitOptions, piecesToWeightKg, formatQty, fmt };
