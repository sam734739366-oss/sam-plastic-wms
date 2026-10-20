const CURRENCIES = {
  YER: { code: 'YER', name: 'ريال يمني', symbol: 'ر.ي' },
  SAR: { code: 'SAR', name: 'ريال سعودي', symbol: 'ر.س' },
  USD: { code: 'USD', name: 'دولار أمريكي', symbol: '$' },
};

let CURRENT = 'YER';

export function setCurrency(code) {
  CURRENT = CURRENCIES[code] ? code : 'YER';
}

export function currencyList() { return Object.values(CURRENCIES); }

export function currencyInfo() { return CURRENCIES[CURRENT]; }

export function fmtNum(n, d = 2) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d });
}

export function fmtMoney(n) {
  const c = CURRENCIES[CURRENT];
  return `${fmtNum(n, 2)} ${c.symbol}`;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
