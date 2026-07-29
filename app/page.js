'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BANKS, COLUMNS, downloadTemplate, parseFile, validate, qty,
  priceFor, notionalOf, currencyBreakdown, fmtAmount, fmtCompact,
  downloadExecutions, execStamp, hashString,
} from '../lib/orders';

const C = {
  bg: '#070B12', panel: '#0D1421', line: '#1F2A3D', hair: '#141C2A',
  text: '#E8EDF4', sub: '#A8B4C6', muted: '#8D99AC', dim: '#64708A',
  accent: '#3CF08F', red: '#FF8C7F', amber: '#F0C25C', blue: '#5FA8FF',
};
const mono = "'IBM Plex Mono', monospace";
const GRID = COLUMNS.map(c => c.width).join(' ');

const card = { border: '1px solid ' + C.line, borderRadius: 10, background: C.panel };
const btn = {
  all: 'unset', boxSizing: 'border-box', cursor: 'pointer', textAlign: 'center',
  padding: '12px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600,
};
const primary = { ...btn, background: C.accent, color: '#06090F' };
const ghost = { ...btn, border: '1px solid ' + C.line, color: C.text, fontWeight: 500 };
const glass = {
  ...btn,
  background: 'rgba(255, 255, 255, 0.06)',
  border: '1px solid rgba(255, 255, 255, 0.16)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  color: C.text,
  fontWeight: 500,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
};

// Rejections a custodian could plausibly return for THIS order. Anything
// side- or type-specific is only offered to orders it can actually apply to,
// so a BUY never draws "insufficient position" and a MARKET order never draws
// a limit-price rejection.
const REJECT_ANY = [
  'Custody account not recognised at this custodian',
  'Instrument not tradable on the connected venue',
  'Order size exceeds the venue block limit',
  'ISIN not in the custodian instrument universe',
];

function rejectReasonsFor(row) {
  const list = [...REJECT_ANY];
  if (row.side === 'BUY') list.push('Insufficient cash for BUY');
  if (row.side === 'SELL') list.push('Insufficient position for SELL');
  if (row.orderType === 'LIMIT') list.push('Limit price outside the permitted price band');
  return list;
}

const FILTER_TONE = { BUY: C.accent, SELL: C.blue, REJECTED: C.red, WARNINGS: C.amber };
const FILTER_LABEL = {
  BUY: 'buy orders',
  SELL: 'sell orders',
  REJECTED: 'rejected orders',
  WARNINGS: 'orders with warnings',
};

// Order lifecycle, in the order a FIX session would report it.
// queued → sent → ack → ready → working → partial → filled
//                  └→ nack → rejected
const PHASE = {
  queued:   { label: 'QUEUED',   tone: C.dim,    note: 'waiting to be sent' },
  sent:     { label: 'SENT',     tone: C.blue,   note: 'awaiting ack' },
  ack:      { label: 'ACK',      tone: C.blue,   note: 'accepted by custodian' },
  ready:    { label: 'READY',    tone: C.blue,   note: 'queued at venue' },
  working:  { label: 'WORKING',  tone: C.amber,  note: 'live at venue' },
  partial:  { label: 'PARTIAL',  tone: C.amber,  note: '' },
  nack:     { label: 'NACK',     tone: C.red,    note: '' },
  rejected: { label: 'REJECTED', tone: C.red,    note: '' },
  filled:   { label: 'FILLED',   tone: C.accent, note: '' },
};

const TERMINAL = { rejected: true, filled: true };

function derivePhase(e, now) {
  if (e.willReject) {
    if (now < e.tSent) return { phase: 'queued', filled: 0 };
    if (now < e.tAck) return { phase: 'sent', filled: 0 };
    if (now < e.tRejected) return { phase: 'nack', filled: 0 };
    return { phase: 'rejected', filled: 0 };
  }
  if (now < e.tSent) return { phase: 'queued', filled: 0 };
  if (now < e.tAck) return { phase: 'sent', filled: 0 };
  if (now < e.tReady) return { phase: 'ack', filled: 0 };
  if (now < e.tWorking) return { phase: 'ready', filled: 0 };
  if (now >= e.tEnd) return { phase: 'filled', filled: e.target };
  const p = Math.max(0, Math.min(1, (now - e.tWorking) / Math.max(1, e.tEnd - e.tWorking)));
  const filled = Math.floor(e.target * p);
  return { phase: filled > 0 ? 'partial' : 'working', filled };
}

function Logo() {
  return (
    <svg width="30" height="20" viewBox="0 0 36 24" aria-hidden="true">
      <path d="M4 7 L 10.5 19 L 17 7 L 23.5 19 L 30 7" fill="none" stroke={C.text} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 7 L 29.4 7" fill="none" stroke={C.accent} strokeWidth="3.2" strokeLinecap="round" />
      <path d="M28.1 3.5 L 30 7" fill="none" stroke={C.accent} strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

function Stepper({ step }) {
  const steps = ['Upload', 'Validate', 'Confirm & route'];
  const at = { start: 0, validate: 1, confirm: 2 }[step] ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {steps.map((label, i) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: i <= at ? 1 : 0.4 }}>
            <span style={{
              width: 20, height: 20, borderRadius: '50%', display: 'grid', placeItems: 'center',
              fontFamily: mono, fontSize: 10,
              border: '1px solid ' + (i <= at ? C.accent : C.line),
              background: i < at ? C.accent : 'transparent',
              color: i < at ? '#06090F' : (i === at ? C.accent : C.dim),
            }}>{i < at ? '✓' : '0' + (i + 1)}</span>
            <span style={{ fontSize: 13, fontWeight: i === at ? 600 : 400, color: i === at ? C.text : C.muted }}>{label}</span>
          </div>
          {i < steps.length - 1 && <span style={{ width: 26, height: 1, background: C.line }} />}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, tone, sub, wide, onClick, active, disabled }) {
  const interactive = Boolean(onClick) && !disabled;
  const accent = tone || C.text;

  const base = {
    ...card,
    padding: '14px 16px',
    minWidth: wide ? 168 : 132,
    flex: wide ? '1 1 168px' : '1 1 132px',
    textAlign: 'left',
    transition: 'border-color 0.15s ease, background 0.15s ease, transform 0.1s ease',
    borderColor: active ? accent : C.line,
    background: active ? accent + '14' : C.panel,
  };

  const body = (
    <>
      <div style={{
        fontFamily: mono, fontSize: 10, letterSpacing: '0.1em',
        color: active ? accent : C.dim, marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {label}
        {interactive && (
          <span style={{ opacity: active ? 1 : 0.45, lineHeight: 0 }}>
            {active ? (
              <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 2.5 L 9.5 9.5 M 9.5 2.5 L 2.5 9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M1.5 2.5 L 10.5 2.5 L 7 6.5 L 7 10 L 5 9 L 5 6.5 Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
            )}
          </span>
        )}
      </div>
      <div style={{ fontSize: wide ? 22 : 26, fontWeight: 600, lineHeight: 1.05, color: accent }}>{value}</div>
      {sub && <div style={{ fontFamily: mono, fontSize: 10, color: C.dim, marginTop: 6 }}>{sub}</div>}
    </>
  );

  if (!interactive) return <div style={base}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={Boolean(active)}
      title={active ? 'Clear this filter' : 'Filter the blotter by ' + label.toLowerCase()}
      style={{
        font: 'inherit', margin: 0, appearance: 'none', WebkitAppearance: 'none',
        ...base, cursor: 'pointer', boxSizing: 'border-box', display: 'block', width: '100%',
      }}
    >
      {body}
    </button>
  );
}

export default function Page() {
  const [step, setStep] = useState('start');
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [headerError, setHeaderError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [bank, setBank] = useState('');

  const [gate, setGate] = useState(false);
  const [gateMode, setGateMode] = useState('access');   // 'access' | 'export'
  const [email, setEmail] = useState('');
  const [gateBanks, setGateBanks] = useState([]);
  const [bankInput, setBankInput] = useState('');
  const [sending, setSending] = useState(false);
  const [gateError, setGateError] = useState('');
  const [sent, setSent] = useState(false);
  const [downloaded, setDownloaded] = useState('');

  const [simState, setSimState] = useState('idle');     // 'idle' | 'running' | 'done'
  const [execs, setExecs] = useState({});
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState(null);           // null | 'BUY' | 'SELL' | 'REJECTED' | 'WARNINGS'

  const fileRef = useRef(null);

  const { issues, errors, warnings } = useMemo(() => validate(rows), [rows]);

  const summary = useMemo(() => {
    const buys = rows.filter(r => r.side === 'BUY');
    const sells = rows.filter(r => r.side === 'SELL');
    return {
      total: rows.length,
      buys: buys.length,
      sells: sells.length,
      instruments: new Set(rows.map(r => r.isin)).size,
      accounts: new Set(rows.map(r => r.account).filter(Boolean)).size,
    };
  }, [rows]);

  const ccy = useMemo(() => currencyBreakdown(rows), [rows]);

  const execStats = useMemo(() => {
    const v = Object.values(execs);
    return {
      filled: v.filter(e => e.status === 'filled').length,
      rejected: v.filter(e => e.status === 'rejected').length,
      pending: v.filter(e => e.status === 'pending').length,
      filledNotional: rows.reduce((a, r) => {
        const e = execs[r.id];
        return a + (e && e.status === 'filled' ? e.filledQty * e.price : 0);
      }, 0),
    };
  }, [execs, rows]);

  // Filtered view of the basket. Keeps each row's original position so the
  // "#" column still matches the uploaded sheet while a filter is on.
  const visible = useMemo(() => {
    const indexed = rows.map((row, i) => ({ row, i }));
    if (!filter) return indexed;
    if (filter === 'REJECTED') {
      return indexed.filter(({ row }) => execs[row.id] && execs[row.id].status === 'rejected');
    }
    if (filter === 'WARNINGS') {
      return indexed.filter(({ row }) => {
        const ri = issues[row.id];
        return Boolean(ri) && Object.values(ri).some(v => v.level === 'warning');
      });
    }
    return indexed.filter(({ row }) => row.side === filter);
  }, [rows, filter, execs, issues]);

  const toggleFilter = key => setFilter(f => (f === key ? null : key));

  const take = useCallback(async file => {
    if (!file) return;
    setBusy(true);
    setHeaderError(null);
    setFileName(file.name);
    try {
      const result = await parseFile(file);
      setHeaderError(result.headerError);
      setRows(result.rows);
      if (result.rows.length) setStep('validate');
    } catch (err) {
      console.error(err);
      setHeaderError('That file could not be read. Use .xlsx, .xls or .csv.');
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const setCell = (id, key, value) =>
    setRows(rs => rs.map(r => (r.id === id ? { ...r, [key]: key === 'side' || key === 'ccy' || key === 'isin' ? value.toUpperCase() : value } : r)));

  const reset = () => {
    setStep('start'); setRows([]); setFileName(''); setHeaderError(null); setBank('');
    setGate(false); setSent(false); setEmail(''); setGateBanks([]); setBankInput(''); setGateError('');
    setSimState('idle'); setExecs({}); setDownloaded(''); setGateMode('access'); setFilter(null);
  };

  const openGate = (mode) => {
    setGateMode(mode || 'access');
    setGateBanks(bank ? [bank] : []);
    setGateError('');
    setSent(false);
    setGate(true);
  };

  const addBank = name => {
    const n = (name || '').trim();
    if (n && !gateBanks.includes(n)) setGateBanks(b => [...b, n]);
    setBankInput('');
  };

  // ── simulation ────────────────────────────────────────────────────────────
  const startSimulation = () => {
    setGate(false);
    setFilter(null);
    const n = rows.length;
    const rejectCount = n >= 10 ? Math.floor(n * 0.1) : (n >= 3 ? 1 : 0);

    const ranked = [...rows].sort((a, b) => hashString(a.isin + a.id) - hashString(b.isin + b.id));
    const rejected = new Set(ranked.slice(0, rejectCount).map(r => r.id));

    const totalMs = Math.min(46000, 4000 + n * 850);
    const now = Date.now();
    const stagger = Math.min(140, 3500 / Math.max(1, n));
    const plan = {};

    rows.forEach((r, i) => {
      const h = hashString(r.isin + r.id);
      const willReject = rejected.has(r.id);
      const pool = rejectReasonsFor(r);

      const tSent = now + 300 + i * stagger;
      const tAck = tSent + 260 + (h % 560);                       // ack/nack lands first
      const tRejected = willReject ? tAck + 1100 : null;          // NACK stays visible ~1.1s
      const tReady = tAck + 160 + ((h >> 3) % 320);
      const tWorking = tReady + 260 + ((h >> 6) % 620);

      const frac = n <= 1 ? 1 : (i + 1) / n;
      const jitter = 0.7 + ((h >> 9) % 55) / 100;                 // 0.70 – 1.25
      const span = Math.max(1400, Math.min(totalMs, totalMs * frac * jitter));
      const tEnd = Math.min(tWorking + span, now + 55000);        // hard 60s ceiling

      plan[r.id] = {
        status: 'pending',
        phase: 'queued',
        filledQty: 0,
        target: qty(r),
        price: priceFor(r),
        willReject,
        reason: willReject ? pool[hashString(r.isin + r.side) % pool.length] : '',
        tSent, tAck, tRejected, tReady, tWorking, tEnd,
        execId: '',
        completedAt: '',
      };
    });

    setExecs(plan);
    setSimState('running');
  };

  useEffect(() => {
    if (simState !== 'running') return;
    const iv = setInterval(() => {
      setTick(t => t + 1);
      setExecs(prev => {
        const now = Date.now();
        const next = {};
        let changed = false;
        for (const id of Object.keys(prev)) {
          const e = prev[id];
          if (TERMINAL[e.phase]) { next[id] = e; continue; }

          const { phase, filled } = derivePhase(e, now);
          if (phase === e.phase && filled === e.filledQty) { next[id] = e; continue; }

          changed = true;
          const status = phase === 'filled' ? 'filled' : phase === 'rejected' ? 'rejected' : 'pending';
          const justSettled = TERMINAL[phase] && !TERMINAL[e.phase];

          next[id] = {
            ...e,
            phase,
            status,
            filledQty: filled,
            completedAt: justSettled ? execStamp() : e.completedAt,
            execId: phase === 'filled' && !e.execId
              ? 'WW-' + String(hashString(id + e.tEnd) % 1000000).padStart(6, '0')
              : e.execId,
          };
        }
        return changed ? next : prev;
      });
    }, 200);
    return () => clearInterval(iv);
  }, [simState]);

  useEffect(() => {
    if (simState !== 'running') return;
    const vals = Object.values(execs);
    if (vals.length && vals.every(e => TERMINAL[e.phase])) setSimState('done');
  }, [execs, simState]);

  // ── lead submit ───────────────────────────────────────────────────────────
  const submitLead = async e => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      setGateError('Enter a valid work email address.');
      return;
    }
    const banks = bankInput.trim() && !gateBanks.includes(bankInput.trim()) ? [...gateBanks, bankInput.trim()] : gateBanks;
    setSending(true);
    setGateError('');
    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          banks,
          orderCount: rows.length,
          source: gateMode === 'export' ? 'app-export' : 'app-route',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Request failed');

      if (gateMode === 'export') {
        try {
          const name = downloadExecutions(rows, execs);
          setDownloaded(name);
        } catch (err) {
          console.error(err);
          setDownloaded('');
        }
      }
      setSent(true);
    } catch (err) {
      setGateError(err.message === 'Failed to fetch' ? 'Network problem. Try again.' : err.message);
    } finally {
      setSending(false);
    }
  };

  const notionalLabel = ccy.dominant
    ? 'NOTIONAL · ' + ccy.ccy
    : (ccy.ccy ? 'NOTIONAL · ' + ccy.ccy + ' (MIXED)' : 'NOTIONAL');

  const notionalSub = !ccy.ccy
    ? 'no currency data'
    : ccy.dominant
      ? Math.round(ccy.share * 100) + '% of basket · simulated'
      : 'largest of ' + ccy.entries.length + ' currencies · ' + Math.round(ccy.share * 100) + '%';

  return (
    <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 40, background: 'rgba(7, 11, 18, 0.85)',
        backdropFilter: 'blur(14px)', borderBottom: '1px solid ' + C.hair,
      }}>
        <div style={{ maxWidth: 1320, margin: '0 auto', padding: '13px 22px', display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em' }}>
            <Logo />
            <span>Wealth<span style={{ color: C.accent }}>Wire</span></span>
          </div>
          <span style={{
            fontFamily: mono, fontSize: 10, letterSpacing: '0.12em', color: C.accent,
            border: '1px solid ' + C.accent + '55', borderRadius: 5, padding: '3px 7px',
          }}>DEMO</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20 }}>
            <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, letterSpacing: '0.08em' }}>NOTHING IS SENT TO ANY BANK</span>
            <a href="https://wealthwire.ch" style={{ fontSize: 13, color: C.sub }}>wealthwire.ch</a>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 1320, margin: '0 auto', padding: '26px 22px 80px', width: '100%', flex: 1 }}>
        <div style={{ marginBottom: 26 }}><Stepper step={step} /></div>

        {step === 'start' && (
          <div style={{ animation: 'ww-in 0.4s ease both' }}>
            <div style={{ maxWidth: 700, marginBottom: 30 }}>
              <h1 style={{ margin: '0 0 12px', fontSize: 'clamp(26px, 3.4vw, 38px)', letterSpacing: '-0.025em', lineHeight: 1.1 }}>
                Take an order sheet all the way to routed.
              </h1>
              <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55, color: C.sub }}>
                Download the template, fill it with your own orders, and upload it. WealthWire checks it the way it
                would before sending anything over FIX. No sign-in, no data leaves this browser until you ask us to
                get in touch.
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 18 }}>
              <div style={{ ...card, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: '0.12em', color: C.dim }}>STEP 01</div>
                <div style={{ fontSize: 17, fontWeight: 600 }}>Get the Excel template</div>
                <div style={{ fontSize: 13.5, lineHeight: 1.55, color: C.muted }}>
                  Nine columns, four example rows, and a sheet explaining every field and every check we run.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, margin: '2px 0 4px' }}>
                  {COLUMNS.map(c => (
                    <span key={c.key} style={{
                      fontFamily: mono, fontSize: 10.5, color: c.required ? C.sub : C.dim,
                      border: '1px solid ' + C.line, borderRadius: 5, padding: '4px 7px',
                    }}>{c.label}{c.required ? ' *' : ''}</span>
                  ))}
                </div>
                <button type="button" onClick={downloadTemplate} style={{ ...ghost, marginTop: 'auto' }}>
                  Download template (.xlsx)
                </button>
              </div>

              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); take(e.dataTransfer.files && e.dataTransfer.files[0]); }}
                style={{
                  ...card, padding: 22, display: 'flex', flexDirection: 'column', gap: 14,
                  borderStyle: 'dashed', borderColor: dragging ? C.accent : C.line,
                  background: dragging ? 'rgba(60, 240, 143, 0.05)' : C.panel,
                }}
              >
                <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: '0.12em', color: C.dim }}>STEP 02</div>
                <div style={{ fontSize: 17, fontWeight: 600 }}>Upload your order sheet</div>
                <div style={{ fontSize: 13.5, lineHeight: 1.55, color: C.muted }}>
                  Drop the file here, or pick it from your machine. .xlsx, .xls and .csv all work.
                </div>
                {headerError && (
                  <div style={{
                    display: 'flex', gap: 9, padding: '11px 13px', borderRadius: 7,
                    border: '1px solid ' + C.red + '55', background: C.red + '12', fontSize: 13, color: C.red, lineHeight: 1.5,
                  }}>{headerError}</div>
                )}
                <input
                  ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                  onChange={e => take(e.target.files && e.target.files[0])}
                />
                <button
                  type="button" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}
                  style={{ ...primary, marginTop: 'auto', opacity: busy ? 0.6 : 1 }}
                >
                  {busy ? 'Reading ' + fileName + '…' : 'Choose file'}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 'validate' && (
          <div style={{ animation: 'ww-in 0.4s ease both' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
              <div>
                <h2 style={{ margin: '0 0 6px', fontSize: 22, letterSpacing: '-0.02em' }}>Validate and review</h2>
                <div style={{ fontFamily: mono, fontSize: 11.5, color: C.dim }}>
                  {fileName} · {rows.length} ORDER{rows.length === 1 ? '' : 'S'}
                </div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5,
                  color: errors ? C.red : C.accent, border: '1px solid ' + (errors ? C.red : C.accent) + '55',
                  background: (errors ? C.red : C.accent) + '12', borderRadius: 6, padding: '6px 11px',
                }}>
                  {errors ? errors + ' blocking error' + (errors === 1 ? '' : 's') : 'No blocking errors'}
                </span>
                {warnings > 0 && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.amber,
                    border: '1px solid ' + C.amber + '55', background: C.amber + '12', borderRadius: 6, padding: '6px 11px',
                  }}>{warnings} warning{warnings === 1 ? '' : 's'}</span>
                )}
                <button type="button" onClick={reset} style={ghost}>Start over</button>
                <button
                  type="button" disabled={errors > 0 || !rows.length} onClick={() => setStep('confirm')}
                  style={{ ...primary, opacity: errors > 0 || !rows.length ? 0.35 : 1, cursor: errors > 0 ? 'not-allowed' : 'pointer' }}
                >
                  Continue to confirm
                </button>
              </div>
            </div>

            <div style={{ fontSize: 13, color: C.muted, marginBottom: 14, lineHeight: 1.55, maxWidth: 780 }}>
              Hard errors block routing, warnings do not. Edit any cell to fix it — the row revalidates as you type.
            </div>

            <div style={{ ...card, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <div style={{ minWidth: 1200 }}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '34px ' + GRID + ' 34px', gap: 10,
                    padding: '10px 15px', borderBottom: '1px solid ' + C.line,
                    fontFamily: mono, fontSize: 10, letterSpacing: '0.09em', color: C.dim,
                  }}>
                    <div>#</div>
                    {COLUMNS.map(c => <div key={c.key} style={{ textAlign: c.align === 'right' ? 'right' : 'left' }}>{c.label.toUpperCase()}</div>)}
                    <div />
                  </div>

                  {rows.map((row, i) => {
                    const rowIssues = issues[row.id] || {};
                    const bad = Object.values(rowIssues).some(v => v.level === 'error');
                    return (
                      <div key={row.id} style={{
                        display: 'grid', gridTemplateColumns: '34px ' + GRID + ' 34px', gap: 10,
                        padding: '4px 15px', borderBottom: '1px solid ' + C.hair, alignItems: 'center',
                        background: bad ? 'rgba(255, 140, 127, 0.05)' : 'transparent',
                      }}>
                        <div style={{ fontFamily: mono, fontSize: 11, color: bad ? C.red : '#4C5872' }}>{i + 1}</div>
                        {COLUMNS.map(c => {
                          const issue = rowIssues[c.key];
                          return (
                            <input
                              key={c.key}
                              value={row[c.key]}
                              title={issue ? issue.message : ''}
                              onChange={e => setCell(row.id, c.key, e.target.value)}
                              style={{
                                width: '100%', background: issue ? (issue.level === 'error' ? C.red + '1A' : C.amber + '14') : 'transparent',
                                border: '1px solid ' + (issue ? (issue.level === 'error' ? C.red + '99' : C.amber + '77') : 'transparent'),
                                borderRadius: 5, padding: '7px 8px', outline: 'none',
                                color: issue ? (issue.level === 'error' ? C.red : C.amber) : (c.mono ? C.sub : C.text),
                                fontFamily: c.mono ? mono : 'inherit',
                                fontSize: c.mono ? 12 : 13,
                                textAlign: c.align === 'right' ? 'right' : 'left',
                              }}
                            />
                          );
                        })}
                        <button
                          type="button" aria-label="Remove row"
                          onClick={() => setRows(rs => rs.filter(r => r.id !== row.id))}
                          style={{ all: 'unset', cursor: 'pointer', color: C.dim, lineHeight: 0, padding: 6 }}
                        >
                          <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2.5 2.5 L 9.5 9.5 M 9.5 2.5 L 2.5 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {(errors > 0 || warnings > 0) && (
              <div style={{ ...card, marginTop: 16, padding: '4px 0' }}>
                {rows.map((row, i) => {
                  const rowIssues = issues[row.id];
                  if (!rowIssues) return null;
                  return Object.entries(rowIssues).map(([field, issue]) => (
                    <div key={row.id + field} style={{
                      display: 'flex', gap: 12, alignItems: 'baseline', padding: '9px 16px',
                      borderBottom: '1px solid ' + C.hair, fontSize: 13,
                    }}>
                      <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, minWidth: 52 }}>ROW {i + 1}</span>
                      <span style={{ color: issue.level === 'error' ? C.red : C.amber, minWidth: 68, fontFamily: mono, fontSize: 11 }}>
                        {issue.level === 'error' ? 'ERROR' : 'WARNING'}
                      </span>
                      <span style={{ color: C.sub }}>{issue.message}</span>
                    </div>
                  ));
                })}
              </div>
            )}
          </div>
        )}

        {step === 'confirm' && (
          <div style={{ animation: 'ww-in 0.4s ease both' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
              <div>
                <h2 style={{ margin: '0 0 6px', fontSize: 22, letterSpacing: '-0.02em' }}>
                  {simState === 'idle' ? 'Confirm and route' : simState === 'running' ? 'Routing simulation' : 'Execution report'}
                </h2>
                <div style={{ fontFamily: mono, fontSize: 11.5, color: C.dim }}>
                  {simState === 'idle'
                    ? 'THE LAST SCREEN BEFORE ORDERS LEAVE THE BUILDING'
                    : simState === 'running'
                      ? 'SIMULATED FILLS · NOTHING REACHES ' + (bank || 'ANY BANK').toUpperCase()
                      : 'SIMULATED · ' + execStats.filled + ' FILLED · ' + execStats.rejected + ' REJECTED'}
                </div>
              </div>
              {simState === 'idle' && (
                <button type="button" onClick={() => setStep('validate')} style={{ ...ghost, marginLeft: 'auto' }}>Back to validation</button>
              )}
              {simState === 'done' && (
                <button type="button" onClick={reset} style={{ ...ghost, marginLeft: 'auto' }}>Try another sheet</button>
              )}
            </div>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
              <Stat
                wide
                label={notionalLabel}
                value={ccy.ccy ? fmtCompact(ccy.amount) : '—'}
                tone={C.accent}
                sub={notionalSub}
              />
              <Stat label="ORDERS" value={summary.total} />
              <Stat
                label="BUY" value={summary.buys} tone={C.accent}
                onClick={() => toggleFilter('BUY')} active={filter === 'BUY'} disabled={!summary.buys}
              />
              <Stat
                label="SELL" value={summary.sells} tone={C.blue}
                onClick={() => toggleFilter('SELL')} active={filter === 'SELL'} disabled={!summary.sells}
              />
              <Stat label="INSTRUMENTS" value={summary.instruments} />
              <Stat label="ACCOUNTS" value={summary.accounts} />
              {simState === 'idle'
                ? (
                  <Stat
                    label="WARNINGS" value={warnings} tone={warnings ? C.amber : C.text}
                    onClick={() => toggleFilter('WARNINGS')} active={filter === 'WARNINGS'} disabled={!warnings}
                  />
                )
                : (
                  <Stat
                    label="REJECTED" value={execStats.rejected} tone={execStats.rejected ? C.red : C.text}
                    onClick={() => toggleFilter('REJECTED')} active={filter === 'REJECTED'} disabled={!execStats.rejected}
                  />
                )}
            </div>

            {simState === 'idle' && (
              <div style={{ ...card, padding: 20, marginBottom: 18 }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Route this basket to</div>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>
                  Pick the custodian that holds these accounts. In the live product this is a FIX session; here it only
                  tells us which bank you need first.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {BANKS.map(b => (
                    <button
                      key={b} type="button" onClick={() => setBank(b)}
                      style={{
                        all: 'unset', cursor: 'pointer', padding: '9px 14px', borderRadius: 7, fontSize: 13.5,
                        border: '1px solid ' + (bank === b ? C.accent : C.line),
                        background: bank === b ? C.accent + '18' : 'transparent',
                        color: bank === b ? C.accent : C.sub,
                      }}
                    >{b}</button>
                  ))}
                </div>
              </div>
            )}

            {filter && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14,
                padding: '10px 14px', borderRadius: 8,
                border: '1px solid ' + (FILTER_TONE[filter] || C.accent) + '55',
                background: (FILTER_TONE[filter] || C.accent) + '10',
              }}>
                <span style={{ fontFamily: mono, fontSize: 10.5, letterSpacing: '0.1em', color: FILTER_TONE[filter] || C.accent }}>
                  FILTERED · {filter}
                </span>
                <span style={{ fontSize: 13, color: C.sub }}>
                  Showing {visible.length} of {rows.length} order{rows.length === 1 ? '' : 's'}.
                  {' '}Exports and totals still cover the whole basket.
                </span>
                <button
                  type="button" onClick={() => setFilter(null)}
                  style={{ ...btn, marginLeft: 'auto', padding: '6px 12px', fontSize: 12.5, fontWeight: 500, color: C.text, border: '1px solid ' + C.line }}
                >
                  Clear filter
                </button>
              </div>
            )}

            {simState === 'idle' ? (
              <div style={{ ...card, overflow: 'hidden', marginBottom: 22 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid ' + C.line, fontSize: 13.5, fontWeight: 600 }}>
                  Orders in this basket
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ minWidth: 860 }}>
                    <div style={{
                      display: 'grid', gridTemplateColumns: '34px 1.2fr 124px 60px 90px 96px 110px 1fr', gap: 10,
                      padding: '9px 16px', borderBottom: '1px solid ' + C.line,
                      fontFamily: mono, fontSize: 10, letterSpacing: '0.09em', color: C.dim,
                    }}>
                      <div>#</div><div>INSTRUMENT</div><div>ISIN</div><div>SIDE</div>
                      <div style={{ textAlign: 'right' }}>QUANTITY</div><div>TYPE</div>
                      <div style={{ textAlign: 'right' }}>NOTIONAL</div><div>CUSTODY ACCOUNT</div>
                    </div>
                    {visible.map(({ row, i }) => (
                      <div key={row.id} style={{
                        display: 'grid', gridTemplateColumns: '34px 1.2fr 124px 60px 90px 96px 110px 1fr', gap: 10,
                        padding: '10px 16px', borderBottom: '1px solid ' + C.hair, alignItems: 'center', fontSize: 13,
                      }}>
                        <div style={{ fontFamily: mono, fontSize: 11, color: '#4C5872' }}>{i + 1}</div>
                        <div>{row.instrument}</div>
                        <div style={{ fontFamily: mono, fontSize: 11.5, color: C.muted }}>{row.isin}</div>
                        <div style={{ fontFamily: mono, fontSize: 11.5, color: row.side === 'SELL' ? C.blue : C.accent }}>{row.side}</div>
                        <div style={{ fontFamily: mono, fontSize: 12, color: C.sub, textAlign: 'right' }}>{row.quantity}</div>
                        <div style={{ fontSize: 12, color: C.muted }}>{row.orderType}{row.limit ? ' ' + row.limit : ''}</div>
                        <div style={{ fontFamily: mono, fontSize: 12, color: C.sub, textAlign: 'right' }}>{fmtAmount(notionalOf(row))}</div>
                        <div style={{ fontFamily: mono, fontSize: 11.5, color: C.muted }}>{row.account}</div>
                      </div>
                    ))}
                    {!visible.length && (
                      <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 13.5, color: C.muted }}>
                        No {FILTER_LABEL[filter] || 'matching orders'} in this basket.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ ...card, overflow: 'hidden', marginBottom: 22 }}>
                <div style={{
                  padding: '12px 16px', borderBottom: '1px solid ' + C.line, display: 'flex',
                  alignItems: 'center', gap: 14, flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>Execution blotter</span>
                  <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>
                    {execStats.filled}/{rows.length} FILLED
                    {execStats.rejected ? ' · ' + execStats.rejected + ' REJECTED' : ''}
                    {execStats.pending ? ' · ' + execStats.pending + ' WORKING' : ''}
                  </span>
                  {simState === 'running' && (
                    <span style={{
                      marginLeft: 'auto', fontFamily: mono, fontSize: 10.5, letterSpacing: '0.1em',
                      color: C.accent, animation: 'ww-blip 1.4s ease-in-out infinite',
                    }}>● LIVE</span>
                  )}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ minWidth: 900 }}>
                    <div style={{
                      display: 'grid', gridTemplateColumns: '34px 1.15fr 60px 88px 88px 96px 110px 1.1fr', gap: 10,
                      padding: '9px 16px', borderBottom: '1px solid ' + C.line,
                      fontFamily: mono, fontSize: 10, letterSpacing: '0.09em', color: C.dim,
                    }}>
                      <div>#</div><div>INSTRUMENT</div><div>SIDE</div>
                      <div style={{ textAlign: 'right' }}>ORDERED</div>
                      <div style={{ textAlign: 'right' }}>FILLED</div>
                      <div style={{ textAlign: 'right' }}>PRICE</div>
                      <div>STATUS</div><div>DETAIL</div>
                    </div>
                    {visible.map(({ row, i }) => {
                      const e = execs[row.id] || {};
                      const ph = PHASE[e.phase] || PHASE.queued;
                      const pct = e.target ? Math.min(100, Math.round(((e.filledQty || 0) / e.target) * 100)) : 0;
                      const tone = ph.tone;
                      const settled = TERMINAL[e.phase];
                      return (
                        <div key={row.id} style={{
                          display: 'grid', gridTemplateColumns: '34px 1.15fr 60px 88px 88px 96px 110px 1.1fr', gap: 10,
                          padding: '10px 16px', borderBottom: '1px solid ' + C.hair, alignItems: 'center', fontSize: 13,
                          background: e.phase === 'rejected' || e.phase === 'nack' ? 'rgba(255, 140, 127, 0.05)' : 'transparent',
                          opacity: e.phase === 'queued' ? 0.55 : 1,
                          transition: 'opacity 0.3s ease, background 0.3s ease',
                        }}>
                          <div style={{ fontFamily: mono, fontSize: 11, color: '#4C5872' }}>{i + 1}</div>
                          <div>{row.instrument}</div>
                          <div style={{ fontFamily: mono, fontSize: 11.5, color: row.side === 'SELL' ? C.blue : C.accent }}>{row.side}</div>
                          <div style={{ fontFamily: mono, fontSize: 12, color: C.sub, textAlign: 'right' }}>{fmtAmount(e.target || 0)}</div>
                          <div style={{ fontFamily: mono, fontSize: 12, color: e.filledQty ? tone : C.dim, textAlign: 'right' }}>{fmtAmount(e.filledQty || 0)}</div>
                          <div style={{ fontFamily: mono, fontSize: 12, color: C.muted, textAlign: 'right' }}>
                            {e.phase === 'filled' ? e.price.toFixed(2) : '—'}
                          </div>
                          <div>
                            <span style={{
                              fontFamily: mono, fontSize: 10, letterSpacing: '0.08em', color: tone,
                              border: '1px solid ' + tone + '55', background: tone + '12',
                              borderRadius: 5, padding: '3px 7px', display: 'inline-block', minWidth: 62, textAlign: 'center',
                              animation: e.phase === 'nack' || e.phase === 'ack' ? 'ww-blip 0.9s ease-in-out 2' : 'none',
                            }}>
                              {e.phase === 'partial' ? pct + '%' : ph.label}
                            </span>
                          </div>
                          <div style={{
                            fontSize: 11.5,
                            color: settled || e.phase === 'nack' ? (e.phase === 'filled' ? C.dim : C.red) : C.dim,
                            fontFamily: e.phase === 'rejected' || e.phase === 'nack' ? 'inherit' : mono,
                          }}>
                            {e.phase === 'rejected' || e.phase === 'nack'
                              ? e.reason
                              : e.phase === 'filled'
                                ? e.execId
                                : e.phase === 'working' || e.phase === 'partial'
                                  ? (
                                    <span style={{ display: 'inline-block', width: '100%', maxWidth: 140, height: 4, background: C.hair, borderRadius: 3, overflow: 'hidden', verticalAlign: 'middle' }}>
                                      <span style={{ display: 'block', width: pct + '%', height: '100%', background: C.amber, transition: 'width 0.25s linear' }} />
                                    </span>
                                  )
                                  : ph.note}
                          </div>
                        </div>
                      );
                    })}
                    {!visible.length && (
                      <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 13.5, color: C.muted }}>
                        No {FILTER_LABEL[filter] || 'matching orders'} in this basket.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {simState === 'idle' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <button
                  type="button" onClick={() => openGate('access')} disabled={!bank}
                  style={{ ...primary, padding: '15px 26px', fontSize: 15, opacity: bank ? 1 : 0.35, cursor: bank ? 'pointer' : 'not-allowed' }}
                >
                  Route {summary.total} order{summary.total === 1 ? '' : 's'} via FIX
                </button>
                <span style={{ fontSize: 13, color: C.dim }}>
                  {bank ? 'Routing is disabled in this demo — nothing reaches ' + bank + '.' : 'Pick a custodian bank first.'}
                </span>
              </div>
            )}

            {simState === 'running' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: C.muted }}>
                  Working the basket… fills arrive over the next few seconds. Prices are simulated.
                </span>
              </div>
            )}

            {simState === 'done' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => openGate('export')} style={{ ...primary, padding: '15px 26px', fontSize: 15 }}>
                  Export Executions
                </button>
                <span style={{ fontSize: 13, color: C.dim }}>
                  {execStats.filled} filled{execStats.rejected ? ', ' + execStats.rejected + ' rejected' : ''} ·{' '}
                  {ccy.ccy ? ccy.ccy + ' ' + fmtAmount(execStats.filledNotional) + ' executed' : 'simulated'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {gate && (
        <div
          onClick={e => { if (e.target === e.currentTarget && !sending) setGate(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4, 7, 12, 0.78)',
            backdropFilter: 'blur(6px)', display: 'grid', placeItems: 'center', padding: 20,
          }}
        >
          <div style={{
            ...card, width: '100%', maxWidth: 520, padding: 28, background: '#0B1220',
            boxShadow: '0 40px 100px rgba(0,0,0,0.6)', animation: 'ww-in 0.25s ease both',
            maxHeight: '90vh', overflowY: 'auto',
          }}>
            {!sent ? (
              <form onSubmit={submitLead}>
                <div style={{ fontFamily: mono, fontSize: 10.5, letterSpacing: '0.14em', color: C.accent, marginBottom: 12 }}>
                  {gateMode === 'export' ? 'YOUR EXECUTIONS ARE READY' : 'ONE STEP LEFT'}
                </div>
                <h3 style={{ margin: '0 0 10px', fontSize: 22, letterSpacing: '-0.02em' }}>
                  {gateMode === 'export' ? 'Take the execution file with you.' : 'Your basket is ready to route.'}
                </h3>
                <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.55, color: C.sub }}>
                  {gateMode === 'export'
                    ? 'Your uploaded sheet, enriched with status, fills, prices and execution IDs. Leave your work email and the custodians you need, and you go on the early-access list.'
                    : 'Live FIX sessions open with the first customers. Leave your work email and the custodians you need, and you go on the early-access list — we prioritise banks by what people ask for.'}
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <input
                    type="email" value={email} placeholder="Work email" autoFocus
                    onChange={e => { setEmail(e.target.value); setGateError(''); }}
                    style={{
                      width: '100%', background: '#070B12', border: '1px solid ' + C.line, borderRadius: 8,
                      padding: '13px 14px', fontSize: 15, color: C.text, outline: 'none',
                    }}
                  />

                  <div style={{
                    display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', width: '100%',
                    background: '#070B12', border: '1px solid ' + C.line, borderRadius: 8, padding: '9px 10px', minHeight: 46,
                  }}>
                    {gateBanks.map(b => (
                      <span key={b} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 8px 5px 11px', borderRadius: 6,
                        background: C.accent + '1F', border: '1px solid ' + C.accent + '66', color: C.accent, fontSize: 13,
                      }}>
                        {b}
                        <button type="button" aria-label="Remove" onClick={() => setGateBanks(list => list.filter(x => x !== b))} style={{ all: 'unset', cursor: 'pointer', lineHeight: 0 }}>
                          <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2.5 2.5 L 9.5 9.5 M 9.5 2.5 L 2.5 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                        </button>
                      </span>
                    ))}
                    <input
                      value={bankInput}
                      placeholder={gateBanks.length ? 'Another bank…' : 'Which custodian banks?'}
                      onChange={e => setBankInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === 'Tab') {
                          if (bankInput.trim()) { e.preventDefault(); addBank(bankInput); }
                        } else if (e.key === 'Backspace' && !bankInput && gateBanks.length) {
                          setGateBanks(list => list.slice(0, -1));
                        }
                      }}
                      style={{ flex: 1, minWidth: 130, background: 'transparent', border: 'none', outline: 'none', fontSize: 14.5, color: C.text, padding: '4px 2px' }}
                    />
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {BANKS.filter(b => !gateBanks.includes(b)).map(b => (
                      <button key={b} type="button" onClick={() => addBank(b)} style={{
                        all: 'unset', cursor: 'pointer', fontSize: 12, color: C.muted,
                        border: '1px solid ' + C.line, borderRadius: 5, padding: '5px 9px',
                      }}>+ {b}</button>
                    ))}
                  </div>

                  {gateError && <div style={{ fontSize: 13, color: C.red }}>{gateError}</div>}

                  <button type="submit" disabled={sending} style={{ ...primary, padding: '14px 20px', fontSize: 15, opacity: sending ? 0.6 : 1 }}>
                    {sending
                      ? (gateMode === 'export' ? 'Preparing your file…' : 'Sending…')
                      : (gateMode === 'export' ? 'Download your executions and request early access' : 'Request early access')}
                  </button>

                  {gateMode === 'access' && simState === 'idle' && (
                    <button type="button" onClick={startSimulation} style={{ ...glass, padding: '13px 20px', fontSize: 14 }}>
                      Simulate Trades
                    </button>
                  )}

                  <button type="button" onClick={() => setGate(false)} style={{ ...btn, color: C.dim, fontSize: 13, fontWeight: 400, padding: '4px 0' }}>
                    Not now
                  </button>
                </div>
              </form>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <svg width="26" height="26" viewBox="0 0 22 22" aria-hidden="true">
                    <circle cx="11" cy="11" r="10" fill="none" stroke={C.accent} strokeWidth="1.5" />
                    <path d="M6.5 11.5 L 9.5 14.5 L 15.5 8" fill="none" stroke={C.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <h3 style={{ margin: 0, fontSize: 21, letterSpacing: '-0.02em' }}>You're on the list.</h3>
                </div>
                <p style={{ margin: '0 0 22px', fontSize: 14.5, lineHeight: 1.6, color: C.sub }}>
                  {gateMode === 'export' ? (
                    <>
                      {downloaded
                        ? <>Your execution file <span style={{ fontFamily: mono, fontSize: 13, color: C.accent }}>{downloaded}</span> has downloaded. </>
                        : <>Your details are saved. </>}
                      Thanks for getting on the waitlist — we'll be in touch before launch, and your basket of{' '}
                      {summary.total} order{summary.total === 1 ? '' : 's'} for {bank || 'your custodian'} told us exactly
                      which session to open first. Nothing was sent to any bank.
                    </>
                  ) : (
                    <>
                      We'll be in touch before launch — and your basket of {summary.total} order
                      {summary.total === 1 ? '' : 's'} for {bank || 'your custodian'} told us exactly which session to
                      open first. Nothing was sent to any bank.
                    </>
                  )}
                </p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {gateMode === 'access' && simState === 'idle' && (
                    <button type="button" onClick={startSimulation} style={{ ...glass, padding: '12px 18px' }}>Simulate Trades</button>
                  )}
                  {gateMode === 'export' && (
                    <button type="button" onClick={() => setGate(false)} style={{ ...ghost }}>Back to the blotter</button>
                  )}
                  <button type="button" onClick={reset} style={primary}>Try another sheet</button>
                  <a href="https://wealthwire.ch" style={{ ...ghost, display: 'inline-block' }}>Back to wealthwire.ch</a>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <footer style={{ borderTop: '1px solid ' + C.hair, marginTop: 'auto' }}>
        <div style={{
          maxWidth: 1320, margin: '0 auto', padding: '20px 22px', display: 'flex', flexWrap: 'wrap',
          gap: '10px 26px', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5, color: C.dim,
        }}>
          <div>© {new Date().getFullYear()} WealthWire · a demo, not a trading system</div>
          <a href="https://wealthwire.ch" style={{ color: C.muted }}>wealthwire.ch</a>
        </div>
      </footer>
    </main>
  );
}
