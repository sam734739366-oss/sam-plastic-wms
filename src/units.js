const GRAMS_PER_KG = 1000;

function toPieces(quantity, unit, item = {}, piecesPerBox = null) {
  const q = Number(quantity);
  switch (unit) {
    case 'piece': return Math.round(q);
    case 'carton': return Math.round(q * (item.pieces_per_carton || 0));
    case 'bag': return Math.round(q * (item.pieces_per_bag || 0));
    case 'kg': return weightToPieces(q, item.weight_grams);
    case 'ton': return weightToPieces(q * 1000, item.weight_grams);
    case 'box': return Math.round(q * (piecesPerBox || 0));
    case 'bale': return Math.round(q);
    default: throw new Error(`وحدة غير معروفة: ${unit}`);
  }
}

function weightToPieces(weightKg, weightGrams) {
  if (!weightGrams) throw new Error('الصنف ليس له وزن جرام — أدخل الكمية بالعدد');
  return Math.round((weightKg * GRAMS_PER_KG) / weightGrams);
}

function piecesToWeightKg(pieces, weightGrams) {
  return (pieces * weightGrams) / GRAMS_PER_KG;
}

function fmt(n, decimals = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function formatQty(pieces, item = {}) {
  const parts = [`${fmt(pieces)} ${item.unit_name || 'حبة'}`];
  if (item.pieces_per_carton && pieces >= item.pieces_per_carton) {
    const c = Math.floor(pieces / item.pieces_per_carton);
    const r = pieces % item.pieces_per_carton;
    parts.push(r > 0 ? `${fmt(c)} كرتون + ${fmt(r)} حبة` : `${fmt(c)} كرتون`);
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

module.exports = { toPieces, piecesToWeightKg, formatQty, fmt };
