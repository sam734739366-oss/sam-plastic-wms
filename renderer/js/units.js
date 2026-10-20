// نسخة الواجهة من تحويلات الوحدات — للعرض الفوري في نماذج المستندات
const UNITS = ['علبة', 'حبة', 'غطاء', 'كيس', 'كرتون', 'امبول'];

function unitOptionsFor(item) {
  if (!item) return [{ value: 'حبة', label: 'حبة' }];
  const opts = [{ value: item.unit_name || 'حبة', label: item.unit_name || 'حبة' }];
  if (item.pieces_per_carton && item.unit_name !== 'كرتون') {
    opts.push({ value: 'كرتون', label: `كرتون (${item.pieces_per_carton})` });
  }
  if (item.pieces_per_shadda) opts.push({ value: 'شدة', label: `شدة (${item.pieces_per_shadda})` });
  if (item.pieces_per_bag && item.unit_name !== 'كيس') opts.push({ value: 'كيس', label: `كيس (${item.pieces_per_bag})` });
  if (item.weight_grams) opts.push({ value: 'كجم', label: 'كجم' }, { value: 'طن', label: 'طن' });
  return opts;
}

function toPieces(quantity, unit, item) {
  const q = Number(quantity) || 0;
  if (unit === item?.unit_name || unit === 'قطعة' || unit === 'حبة') return Math.round(q);
  switch (unit) {
    case 'علبة': case 'غطاء': case 'امبول': return Math.round(q);
    case 'كرتون': return item?.pieces_per_carton ? Math.round(q * item.pieces_per_carton) : null;
    case 'شدة': return item?.pieces_per_shadda ? Math.round(q * item.pieces_per_shadda) : null;
    case 'كيس': return item?.pieces_per_bag ? Math.round(q * item.pieces_per_bag) : null;
    case 'كجم': return item?.weight_grams ? Math.round((q * 1000) / item.weight_grams) : null;
    case 'طن': return item?.weight_grams ? Math.round((q * 1000000) / item.weight_grams) : null;
    default: return null;
  }
}

function piecesToWeightKg(pieces, weightGrams) {
  return weightGrams ? (pieces * weightGrams) / 1000 : 0;
}

function qtyLabel(pieces, item) {
  if (!item) return `${pieces} حبة`;
  const parts = [];
  if (item.pieces_per_carton && pieces >= item.pieces_per_carton) {
    const c = Math.floor(pieces / item.pieces_per_carton);
    const r = pieces % item.pieces_per_carton;
    parts.push(r > 0 ? `${c} كرتون + ${r}` : `${c} كرتون`);
  }
  if (item.pieces_per_shadda && pieces >= item.pieces_per_shadda) {
    const b = Math.floor(pieces / item.pieces_per_shadda);
    const r = pieces % item.pieces_per_shadda;
    parts.push(r > 0 ? `${b} شدة + ${r}` : `${b} شدة`);
  }
  if (item.pieces_per_bag && pieces >= item.pieces_per_bag) {
    const b = Math.floor(pieces / item.pieces_per_bag);
    const r = pieces % item.pieces_per_bag;
    parts.push(r > 0 ? `${b} كيس + ${r}` : `${b} كيس`);
  }
  const head = `${pieces} ${item.unit_name || 'حبة'}`;
  return parts.length ? `${head} (${parts.join(' — ')})` : head;
}

export { UNITS, unitOptionsFor, toPieces, piecesToWeightKg, qtyLabel };
