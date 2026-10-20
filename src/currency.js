const CURRENCIES = {
  YER: { code: 'YER', name: 'ريال يمني', symbol: 'ر.ي' },
  SAR: { code: 'SAR', name: 'ريال سعودي', symbol: 'ر.س' },
  USD: { code: 'USD', name: 'دولار أمريكي', symbol: '$' },
};

function currencyOf(code) {
  return CURRENCIES[code] || CURRENCIES.YER;
}

function fmtMoney(n, code) {
  const c = currencyOf(code);
  const v = Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${v} ${c.symbol}`;
}

module.exports = { CURRENCIES, currencyOf, fmtMoney };
