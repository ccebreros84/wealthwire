import * as XLSX from 'xlsx';

export const BANKS = [
  'LGT', 'UBS', 'Julius Baer', 'Pictet', 'VP Bank',
  'Lombard Odier', 'Vontobel', 'ZKB', 'Rahn+Bodmer', 'Bordier',
];

// The order sheet contract. `label` must match the template header exactly.
export const COLUMNS = [
  { key: 'instrument', label: 'Instrument',      width: '1.25fr', required: true,  hint: 'Name of the security' },
  { key: 'isin',       label: 'ISIN',            width: '124px',  required: true,  hint: '12 characters, e.g. CH0038863350', mono: true },
  { key: 'side',       label: 'Side',            width: '64px',   required: true,  hint: 'BUY or SELL', mono: true },
  { key: 'quantity',   label: 'Quantity',        width: '86px',   required: true,  hint: 'Positive number', mono: true, align: 'right' },
  { key: 'orderType',  label: 'Order type',      width: '92px',   required: false, hint: 'MARKET or LIMIT' },
  { key: 'limit',      label: 'Limit',           width: '80px',   required: false, hint: 'Price for LIMIT orders', mono: true, align: 'right' },
  { key: 'ccy',        label: 'CCY',             width: '56px',   required: true,  hint: '3-letter currency', mono: true },
  { key: 'account',    label: 'Custody account', width: '1fr',    required: true,  hint: 'Account at the custodian', mono: true },
  { key: 'ref',        label: 'Client ref',      width: '1fr',    required: false, hint: 'Your own reference', mono: true },
];

const HEADERS = COLUMNS.map(c => c.label);
const normalise = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

const SAMPLE = [
  ['Nestlé SA',           'CH0038863350', 'BUY',  500, 'MARKET', '',       'CHF', '0835-4471.02', 'MUELLER-01'],
  ['Roche Holding GS',    'CH0012032048', 'BUY',  200, 'LIMIT',  256.0,    'CHF', '0835-4471.02', 'MUELLER-02'],
  ['UBS Group AG',        'CH0244767585', 'SELL', 900, 'MARKET', '',       'CHF', '0835-9920.01', 'KELLER-04'],
  ['ABB Ltd',             'CH0012221716', 'SELL', 350, 'MARKET', '',       'CHF', '0835-9920.01', 'KELLER-05'],
];

// ── template ────────────────────────────────────────────────
export function downloadTemplate() {
  const wb = XLSX.utils.book_new();

  const orders = XLSX.utils.aoa_to_sheet([HEADERS, ...SAMPLE]);
  orders['!cols'] = [
    { wch: 24 }, { wch: 16 }, { wch: 8 }, { wch: 10 },
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
  const missing = HEADERS.filter(h => !header.includes(normalise(h)));
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
