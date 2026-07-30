import { neon } from '@neondatabase/serverless';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// Read the captured leads without needing the Neon console.
//
//   /api/leads?key=YOUR_KEY              -> JSON
//   /api/leads?key=YOUR_KEY&format=csv   -> CSV download, opens in Excel
//   /api/leads?key=YOUR_KEY&limit=500    -> cap the rows (default 200, max 5000)
//
// Set LEADS_ACCESS_KEY in Vercel first. Without it this route refuses to run,
// so the address list can never be fetched by someone who guesses the URL.

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export async function GET(request) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const expected = process.env.LEADS_ACCESS_KEY || '';

  const nope = () =>
    new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  // No key configured, or a key that does not match: behave as if the route
  // does not exist rather than confirming it is here.
  if (expected.length < 16 || key !== expected) return nope();

  if (!process.env.DATABASE_URL) {
    return Response.json(
      { ok: false, error: 'DATABASE_URL is not set in this environment.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 200));

  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      select id, created_zurich, email, banks, order_count, source
      from leads_export
      limit ${limit}
    `;

    if ((url.searchParams.get('format') || '').toLowerCase() === 'csv') {
      const header = ['id', 'created_zurich', 'email', 'banks', 'order_count', 'source'];
      const body = rows.map(r => header.map(h => csvCell(r[h])).join(',')).join('\n');
      const csv = '\uFEFF' + header.join(',') + '\n' + body + '\n';
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      const name = 'wealthwire-leads-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.csv';

      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + name + '"',
          'Cache-Control': 'no-store',
        },
      });
    }

    const bySource = rows.reduce((acc, r) => {
      const k = r.source || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    return Response.json(
      { ok: true, count: rows.length, bySource, leads: rows },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return Response.json(
      { ok: false, error: String(err && err.message ? err.message : err) },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
