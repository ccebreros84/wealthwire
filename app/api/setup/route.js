import { neon } from '@neondatabase/serverless';

export const runtime = 'edge';

// One-time schema setup. Visit /api/setup once after the database is connected.
// Safe to run repeatedly: every statement is idempotent.
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return Response.json(
      { ok: false, error: 'DATABASE_URL is not set in this environment.' },
      { status: 500 }
    );
  }

  const sql = neon(process.env.DATABASE_URL);
  const done = [];

  try {
    await sql`
      create table if not exists leads (
        id           bigserial primary key,
        email        text        not null,
        banks        jsonb       not null default '[]'::jsonb,
        order_count  integer,
        source       text,
        user_agent   text,
        created_at   timestamptz not null default now()
      )
    `;
    done.push('table leads');

    await sql`create index if not exists leads_created_at_idx on leads (created_at desc)`;
    done.push('index leads_created_at_idx');

    await sql`create index if not exists leads_email_idx on leads (lower(email))`;
    done.push('index leads_email_idx');

    await sql`
      create or replace view leads_export as
      select
        id,
        created_at at time zone 'Europe/Zurich' as created_zurich,
        email,
        (select string_agg(value, ', ') from jsonb_array_elements_text(banks)) as banks,
        order_count,
        source
      from leads
      order by created_at desc
    `;
    done.push('view leads_export');

    const [{ count }] = await sql`select count(*)::int as count from leads`;

    return Response.json({ ok: true, created: done, existingRows: count });
  } catch (err) {
    return Response.json(
      { ok: false, error: String(err && err.message ? err.message : err), completed: done },
      { status: 500 }
    );
  }
}
