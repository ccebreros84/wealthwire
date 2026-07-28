-- Run once in the Neon SQL editor.

create table if not exists leads (
  id           bigserial primary key,
  email        text        not null,
  banks        jsonb       not null default '[]'::jsonb,
  order_count  integer,
  source       text,
  user_agent   text,
  created_at   timestamptz not null default now()
);

create index if not exists leads_created_at_idx on leads (created_at desc);
create index if not exists leads_email_idx      on leads (lower(email));

-- Handy view for exports.
create or replace view leads_export as
select
  id,
  created_at at time zone 'Europe/Zurich' as created_zurich,
  email,
  (select string_agg(value, ', ') from jsonb_array_elements_text(banks)) as banks,
  order_count,
  source
from leads
order by created_at desc;
