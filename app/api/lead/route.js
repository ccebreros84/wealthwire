import { neon } from '@neondatabase/serverless';

export const runtime = 'edge';

const clean = v => String(v == null ? '' : v).trim();

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ ok: false, error: 'Bad request' }, { status: 400 });
  }

  const email = clean(body.email).slice(0, 320);
  const banks = Array.isArray(body.banks)
    ? body.banks.map(clean).filter(Boolean).slice(0, 20).map(b => b.slice(0, 80))
    : [];
  const orderCount = Number.isFinite(body.orderCount) ? Math.max(0, Math.min(100000, body.orderCount | 0)) : null;
  const source = clean(body.source).slice(0, 60) || 'app';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return Response.json({ ok: false, error: 'Enter a valid work email address.' }, { status: 422 });
  }

  let stored = false;
  if (process.env.DATABASE_URL) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      await sql`
        insert into leads (email, banks, order_count, source, user_agent)
        values (${email}, ${JSON.stringify(banks)}::jsonb, ${orderCount}, ${source},
                ${clean(request.headers.get('user-agent')).slice(0, 400)})
      `;
      stored = true;
    } catch (err) {
      console.error('[wealthwire] neon insert failed', err);
      return Response.json({ ok: false, error: 'Could not save that. Please try again.' }, { status: 500 });
    }
  } else {
    console.warn('[wealthwire] DATABASE_URL not set — lead not persisted:', { email, banks, orderCount });
  }

  // Optional notification. Never blocks the response path on failure.
  if (process.env.RESEND_API_KEY && process.env.LEAD_NOTIFY_TO) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.LEAD_NOTIFY_FROM || 'WealthWire <onboarding@resend.dev>',
          to: process.env.LEAD_NOTIFY_TO.split(',').map(s => s.trim()).filter(Boolean),
          subject: 'New early-access request — ' + email,
          text: [
            'Email:  ' + email,
            'Banks:  ' + (banks.length ? banks.join(', ') : '—'),
            'Orders: ' + (orderCount == null ? '—' : orderCount),
            'Source: ' + source,
            'Saved:  ' + (stored ? 'yes' : 'NO — DATABASE_URL missing'),
          ].join('\n'),
        }),
      });
    } catch (err) {
      console.error('[wealthwire] notification failed', err);
    }
  }

  return Response.json({ ok: true, stored });
}
