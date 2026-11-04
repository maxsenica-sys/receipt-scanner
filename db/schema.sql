-- Receipt Scanner: everything the app stores. The app's server connects as the database owner;
-- row level security is on with no policies, so nothing is reachable through Supabase's public API.

create table if not exists receipts (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  receipt_date   date not null,
  merchant       text not null default '',
  currency       text not null default 'TRY',
  payment        text,
  receipt_no     text,                          -- FİŞ NO as printed (digits, leading zeros dropped)
  receipt_time   text,                          -- HH:MM printed on the receipt
  total          numeric(14,2) not null default 0,   -- sum of the line totals, receipt currency
  total_aud      numeric(14,2),
  fx_rate        numeric(18,8),                 -- AUD per unit of `currency` used for total_aud
  photo_path     text unique,                   -- in the private "receipts" storage bucket
  photo_sha      text unique,                   -- same photo twice = same hash
  photo_mime     text,
  drive_file     text,                          -- photo's name in Google Drive (imported / backed up)
  source         text not null default 'scan',  -- scan | manual | import
  legacy_id      text unique,                   -- Receipt ID from the Google Sheet
  flags          text not null default '',
  notes          text,
  confidence     text,
  backup_status  text not null default 'pending',   -- pending | done | failed | off
  backup_error   text
);
create index if not exists receipts_date_idx on receipts (receipt_date);

create table if not exists items (
  id            bigint generated always as identity primary key,
  receipt_id    uuid not null references receipts(id) on delete cascade,
  line_no       int not null,
  description   text not null default '',
  original_text text not null default '',
  category      text not null default 'Other',
  qty           numeric(12,3) not null default 1,
  unit_price    numeric(14,2) not null default 0,
  line_total    numeric(14,2) not null,
  aud           numeric(14,2)
);
create index if not exists items_receipt_idx on items (receipt_id);

-- A scan that looks like one already logged (same shop, day and total, nothing printed to tell
-- them apart). Kept, unwritten, until the owner says "add" or "don't add".
create table if not exists pending (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  photo_path  text,
  photo_sha   text,
  photo_mime  text,
  data        jsonb not null,
  match       jsonb
);

create table if not exists settings (
  key    text primary key,
  value  jsonb not null
);

create table if not exists fx_rates (
  day       date not null,
  currency  text not null,
  aud       numeric(18,8) not null,             -- AUD per 1 unit of currency on that day
  primary key (day, currency)
);

alter table receipts enable row level security;
alter table items    enable row level security;
alter table pending  enable row level security;
alter table settings enable row level security;
alter table fx_rates enable row level security;

insert into settings (key, value) values
  ('season', '{"start": "2026-09-01", "end": "2027-05-31"}'),
  ('categories', '["Groceries","Eating Out","Coffee & Snacks","Supplements & Nutrition","Transport","Accommodation & Utilities","Household","Personal Care & Pharmacy","Health & Medical","Training & Gear","Clothing","Phone & Internet","Entertainment","Travel","Fees & Charges","Other"]'),
  ('timezone', '"Europe/Istanbul"')
on conflict (key) do nothing;
