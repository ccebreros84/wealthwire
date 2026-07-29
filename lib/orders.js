import * as XLSX from 'xlsx';

export const BANKS = [
  'LGT', 'UBS', 'Julius Baer', 'Pictet', 'VP Bank',
  'Lombard Odier', 'Vontobel', 'ZKB', 'Rahn+Bodmer', 'Bordier',
];

// The order sheet contract. `label` must match the template header exactly.
export const COLUMNS = [
  { key: 'instrument', label: 'Instrument',      width: '1.25fr', required: true,  hint: 'Name of the security' },
  { key: 'isin',       label: 'ISIN',            width: '124px',  required: true,  hint: '12 characters, e.g. CH0038863350', mono: true },
  { key: 'assetClass', label: 'Asset class',     width: '98px',   required: false, optional: true, hint: 'EQUITY or ETF - nothing else is supported' },
  { key: 'side',       label: 'Side',            width: '64px',   required: true,  hint: 'BUY or SELL', mono: true },
  { key: 'quantity',   label: 'Quantity',        width: '86px',   required: true,  hint: 'Positive number', mono: true, align: 'right' },
  { key: 'orderType',  label: 'Order type',      width: '92px',   required: false, hint: 'MARKET or LIMIT' },
  { key: 'limit',      label: 'Limit',           width: '80px',   required: false, hint: 'Price for LIMIT orders', mono: true, align: 'right' },
  { key: 'ccy',        label: 'CCY',             width: '56px',   required: true,  hint: '3-letter currency', mono: true },
  { key: 'account',    label: 'Custody account', width: '1fr',    required: true,  hint: 'Account at the custodian', mono: true },
  { key: 'ref',        label: 'Client ref',      width: '1fr',    required: false, hint: 'Your own reference', mono: true },
];

const HEADERS = COLUMNS.map(c => c.label);
const REQUIRED_HEADERS = COLUMNS.filter(c => !c.optional).map(c => c.label);
const normalise = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

const SAMPLE = [
  ['Nestlé SA',                    'CH0038863350', 'EQUITY', 'BUY',  500, 'MARKET', '',    'CHF', '0835-4471.02', 'MUELLER-01'],
  ['Roche Holding GS',             'CH0012032048', 'EQUITY', 'BUY',  200, 'LIMIT',  256.0, 'CHF', '0835-4471.02', 'MUELLER-02'],
  ['UBS Group AG',                 'CH0244767585', 'EQUITY', 'SELL', 900, 'MARKET', '',    'CHF', '0835-9920.01', 'KELLER-04'],
  ['ABB Ltd',                      'CH0012221716', 'EQUITY', 'SELL', 350, 'MARKET', '',    'CHF', '0835-9920.01', 'KELLER-05'],
  ['iShares Core SPI UCITS ETF',   'CH0237935652', 'ETF',    'BUY',  120, 'MARKET', '',    'CHF', '0835-4471.02', 'MUELLER-03'],
];

// ── template ────────────────────────────────────────────────
export function downloadTemplate() {
  const wb = XLSX.utils.book_new();

  const orders = XLSX.utils.aoa_to_sheet([HEADERS, ...SAMPLE]);
  orders['!cols'] = [
    { wch: 26 }, { wch: 16 }, { wch: 12 }, { wch: 8 }, { wch: 10 },
    { wch: 12 }, { wch: 10 }, { wch: 7 }, { wch: 18 }, { wch: 16 },
  ];
  orders['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, orders, 'Orders');

  const help = XLSX.utils.aoa_to_sheet([
    ['WealthWire order sheet'],
    [],
    ['Keep the header row exactly as it is. Add one order per row, starting on row 2.'],
    ['Delete the four example rows before you upload your own orders.'],
    [],
    ['Column', 'Required', 'Notes'],
    ...COLUMNS.map(c => [c.label, c.required ? 'Yes' : 'No', c.hint]),
    [],
    ['Checks WealthWire runs on upload'],
    ['Header row matches this template'],
    ['Every required field is filled'],
    ['ISIN is 12 characters and passes its check digit'],
    ['Side is BUY or SELL'],
    ['Quantity is a positive number'],
    ['Custody account is present'],
    ['Duplicate instrument + side + account raises a warning, not an error'],
    [],
    ['What WealthWire can route'],
    ['Cash equities and ETFs only.'],
    ['Bonds and other debt, funds that are not ETFs, ETCs/ETPs/ETNs, and any'],
    ['derivative (option, warrant, future, swap, structured product) are rejected.'],
    ['Set Asset class to EQUITY or ETF to be explicit. If you leave it blank we'],
    ['infer it from the ISIN and the instrument name.'],
  ]);
  help['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 46 }];
  XLSX.utils.book_append_sheet(wb, help, 'How to use');

  XLSX.writeFile(wb, 'wealthwire-order-template.xlsx', { compression: true });
}

// ── parsing ─────────────────────────────────────────────────
let seq = 0;

export async function parseFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { cellDates: false });
  const sheetName = wb.SheetNames.find(n => normalise(n) === 'orders') || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return { headerError: 'That file has no readable sheet.', rows: [] };

  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: false, defval: '' });
  if (!grid.length) return { headerError: 'That sheet is empty.', rows: [] };

  const header = grid[0].map(normalise);
  const missing = REQUIRED_HEADERS.filter(h => !header.includes(normalise(h)));
  if (missing.length) {
    return {
      headerError: 'The header row does not match the template. Missing: ' + missing.join(', ') + '.',
      rows: [],
    };
  }
  const index = {};
  COLUMNS.forEach(c => { index[c.key] = header.indexOf(normalise(c.label)); });

  const rows = grid.slice(1)
    .filter(r => r.some(cell => String(cell).trim() !== ''))
    .map(r => {
      const row = { id: ++seq };
      COLUMNS.forEach(c => { row[c.key] = String(r[index[c.key]] == null ? '' : r[index[c.key]]).trim(); });
      row.side = row.side.toUpperCase();
      row.ccy = row.ccy.toUpperCase();
      row.isin = row.isin.toUpperCase().replace(/\s/g, '');
      row.orderType = row.orderType ? row.orderType.toUpperCase() : 'MARKET';
      return row;
    });

  return { headerError: rows.length ? null : 'The sheet has a valid header but no order rows.', rows };
}

// ── validation ──────────────────────────────────────────────
export function isinValid(raw) {
  const s = String(raw || '').toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  let digits = '';
  for (const ch of s.slice(0, 11)) digits += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
  let sum = 0, dbl = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return (10 - (sum % 10)) % 10 === Number(s[11]);
}

// ── instrument eligibility ──────────────────────────────────────────────────
// WealthWire routes cash equities and ETFs. Everything else is rejected before
// it can reach a FIX session. If the sheet declares an asset class we take it;
// otherwise we infer one from the ISIN prefix and the instrument name.
export const ELIGIBLE = ['EQUITY', 'ETF'];

const RE_ETF   = /\betfs?\b|\bucits\s+etf\b/i;
const RE_ETP   = /\betcs?\b|\betps?\b|\betns?\b/i;
// Deliberately high precision. A false positive blocks a legitimate order, so
// bare words that double as company names (future, option, treasury, senior,
// bill, barrier, call, put) are NOT used - real listed issuers carry them:
// Future plc, Option Care Health, Treasury Wine Estates, Senior plc, BILL
// Holdings, Barrier Therapeutics, Callaway Golf. Use the Asset class column
// when a name is genuinely ambiguous.
const RE_DEBT  = /\b(bonds?|anleihe|obligations?|notes|debentures?|gilts?|bund|floaters?|frn|at1|t[-\s]?bills?|treasury\s+(bill|note|bond)s?|senior\s+(note|bond|unsecured)s?|subordinated\s+(note|bond|debt)s?|perpetual\s+(note|bond)s?|convertible\s+bonds?)\b|\d[\d.,]*\s*%/i;
const RE_DERIV = /\b(warrants?|futures|swaps?|cfds?|certificates?|zertifikat\w*|autocall\w*|structured\s+products?|reverse\s+convertibles?|barrier\s+reverse\s+convertibles?|turbos?|knock[-\s]?outs?|mini[-\s]?futures?|(call|put)\s+options?)\b/i;
const RE_FUND  = /\b(fund|funds|sicav|fcp|mutual|feeder|umbrella|anlagefonds)\b/i;

const KLASS_LABEL = {
  DEBT: 'bond or other debt instrument',
  DERIVATIVE: 'derivative',
  FUND: 'fund that is not an ETF',
  ETP: 'ETC, ETP or ETN',
};

export function classifyInstrument(row) {
  const declared = String(row.assetClass || '').trim().toUpperCase();
  if (declared) return { klass: declared, declared: true };

  const name = String(row.instrument || '');
  const isin = String(row.isin || '').toUpperCase();

  if (RE_ETF.test(name)) return { klass: 'ETF', declared: false };
  if (RE_ETP.test(name)) return { klass: 'ETP', declared: false };
  if (isin.startsWith('XS')) return { klass: 'DEBT', declared: false };
  if (RE_DEBT.test(name)) return { klass: 'DEBT', declared: false };
  if (RE_DERIV.test(name)) return { klass: 'DERIVATIVE', declared: false };
  if (RE_FUND.test(name)) return { klass: 'FUND', declared: false };
  return { klass: 'EQUITY', declared: false };
}

export const klassLabel = k => KLASS_LABEL[k] || String(k || '').toLowerCase();

export function validate(rows) {
  const issues = {};   // rowId -> { field: { level, message } }
  const seen = new Map();
  let errors = 0, warnings = 0;

  const flag = (row, field, level, message) => {
    issues[row.id] = issues[row.id] || {};
    if (issues[row.id][field] && issues[row.id][field].level === 'error') return;
    issues[row.id][field] = { level, message };
    if (level === 'error') errors++; else warnings++;
  };

  rows.forEach(row => {
    COLUMNS.filter(c => c.required).forEach(c => {
      if (!row[c.key]) flag(row, c.key, 'error', c.label + ' is required');
    });

    if (row.isin) {
      if (row.isin.length !== 12) flag(row, 'isin', 'error', 'ISIN must be 12 characters, this one has ' + row.isin.length);
      else if (!isinValid(row.isin)) flag(row, 'isin', 'error', 'ISIN check digit does not match');
    }
    if (row.side && row.side !== 'BUY' && row.side !== 'SELL') {
      flag(row, 'side', 'error', 'Side must be BUY or SELL');
    }
    if (row.quantity) {
      const q = Number(String(row.quantity).replace(/[' ]/g, '').replace(',', '.'));
      if (!Number.isFinite(q) || q <= 0) flag(row, 'quantity', 'error', 'Quantity must be a positive number');
    }
    if (row.ccy && !/^[A-Z]{3}$/.test(row.ccy)) {
      flag(row, 'ccy', 'error', 'Currency must be a 3-letter code');
    }
    if (row.orderType === 'LIMIT' && !row.limit) {
      flag(row, 'limit', 'warning', 'LIMIT order without a limit price');
    }

    const cls = classifyInstrument(row);
    if (cls.declared) {
      if (!ELIGIBLE.includes(cls.klass)) {
        flag(row, 'assetClass', 'error',
          'WealthWire routes cash equities and ETFs only - this row is marked ' + cls.klass);
      } else {
        // Declared eligible, but the name says otherwise. Worth a look, not a block.
        const inferred = classifyInstrument({ ...row, assetClass: '' });
        if (!ELIGIBLE.includes(inferred.klass)) {
          flag(row, 'instrument', 'warning',
            'Marked ' + cls.klass + ' but this looks like a ' + klassLabel(inferred.klass));
        }
      }
    } else if (!ELIGIBLE.includes(cls.klass)) {
      flag(row, 'instrument', 'error',
        'Looks like a ' + klassLabel(cls.klass) + '. WealthWire routes cash equities and ETFs only.');
    }

    const key = [row.isin, row.side, row.account].join('|');
    if (row.isin && seen.has(key)) {
      flag(row, 'instrument', 'warning', 'Same instrument, side and account as row ' + seen.get(key));
    } else if (row.isin) {
      seen.set(key, rows.indexOf(row) + 1);
    }
  });

  return { issues, errors, warnings };
}

export const qty = row => Number(String(row.quantity || '').replace(/[' ]/g, '').replace(',', '.')) || 0;

// ── pricing, notional, currency ─────────────────────────────────────────────
// Demo only. There is no market data in this app: every price below is either
// the limit price the user typed, or a stable pseudo-price derived from the
// ISIN so the same sheet always produces the same figures. Never present these
// as real market prices.
export function hashString(s) {
  const str = String(s);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function priceFor(row) {
  const lim = Number(String(row.limit || '').replace(/[' ]/g, '').replace(',', '.'));
  if (Number.isFinite(lim) && lim > 0) return Math.round(lim * 100) / 100;
  const h = hashString(row.isin || row.instrument || 'x');
  return Math.round((15 + (h % 48500) / 100) * 100) / 100;   // 15.00 – 500.00
}

export const notionalOf = row => Math.round(qty(row) * priceFor(row) * 100) / 100;

export function currencyBreakdown(rows) {
  const totals = {};
  let grand = 0;
  rows.forEach(r => {
    const ccy = (r.ccy || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy)) return;
    const n = notionalOf(r);
    totals[ccy] = (totals[ccy] || 0) + n;
    grand += n;
  });
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { ccy: '', amount: 0, share: 0, dominant: false, grand: 0, entries: [] };
  const [ccy, amount] = entries[0];
  const share = grand ? amount / grand : 0;
  return { ccy, amount, share, dominant: share >= 0.6, grand, entries };
}

// 1234567.8 -> "1'234'568"   (Swiss grouping, whole units)
export function fmtAmount(n) {
  const r = Math.round(Number(n) || 0);
  return String(r).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

// 1234567 -> "1.23m"  /  245100 -> "245k"
export function fmtCompact(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e9) return (n / 1e9).toFixed(2) + 'bn';
  if (v >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (v >= 1e4) return Math.round(n / 1e3) + 'k';
  return fmtAmount(n);
}

// ── execution export ────────────────────────────────────────────────────────
export function execStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export function downloadExecutions(rows, execs) {
  const wb = XLSX.utils.book_new();

  const header = [
    ...HEADERS,
    'Status', 'Filled qty', 'Avg price (simulated)', 'Notional', 'Execution ID', 'Completed at', 'Reject reason',
  ];

  const body = rows.map(row => {
    const e = execs[row.id] || {};
    const filled = e.status === 'filled';
    return [
      ...COLUMNS.map(c => row[c.key]),
      (e.status || 'pending').toUpperCase(),
      e.filledQty || 0,
      filled ? e.price : '',
      filled ? Math.round(e.filledQty * e.price * 100) / 100 : '',
      e.execId || '',
      e.completedAt || '',
      e.reason || '',
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws['!cols'] = [
    { wch: 24 }, { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 10 },
    { wch: 7 }, { wch: 18 }, { wch: 16 },
    { wch: 10 }, { wch: 11 }, { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 20 }, { wch: 34 },
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws, 'Executions');

  const values = Object.values(execs);
  const filled = values.filter(e => e.status === 'filled');
  const rejected = values.filter(e => e.status === 'rejected');
  const cb = currencyBreakdown(rows);
  const filledNotional = rows.reduce((a, r) => {
    const e = execs[r.id];
    return a + (e && e.status === 'filled' ? e.filledQty * e.price : 0);
  }, 0);

  const summary = XLSX.utils.aoa_to_sheet([
    ['WealthWire execution report'],
    ['Generated', execStamp()],
    [],
    ['Orders', rows.length],
    ['Filled', filled.length],
    ['Rejected', rejected.length],
    [],
    ['Predominant currency', cb.ccy || '-'],
    ['Share of notional', cb.grand ? Math.round(cb.share * 100) + '%' : '-'],
    ['Ordered notional', Math.round(cb.amount)],
    ['Filled notional', Math.round(filledNotional)],
    [],
    ['This is a demo. No order was sent to any bank and no price shown here is a'],
    ['real market price. Prices are taken from the limit column where present,'],
    ['and are otherwise generated deterministically from the ISIN.'],
  ]);
  summary['!cols'] = [{ wch: 26 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, summary, 'Summary');

  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const name = 'wealthwire-executions-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.xlsx';
  XLSX.writeFile(wb, name, { compression: true });
  return name;
}
