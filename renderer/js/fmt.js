export function fmtNum(n, d = 2) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d }); }
export function fmtMoney(n) { return fmtNum(n, 2) + ' ريال'; }
export function today() { return new Date().toISOString().slice(0, 10); }
