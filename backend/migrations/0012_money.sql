-- ---------------------------------------------------------------------------
-- 0012_money — invoices, payments, allocations, proofs and receipts
-- (DATABASE §3.3, BILLING_ENGINE §11, M5 second half).
--
-- Rollback: new tables; drop in reverse order — receipts → payment_proofs →
-- payment_allocations → payments → invoice_items → invoices → billing_runs — plus the
-- three invariant functions and their triggers.
--
-- This migration creates the **whole** money schema, including `billing_runs` and the two
-- invoice tables, although only the payment surface (PAY-01..08, PRF-03/04, RCT-01) is
-- served by this half. The reason is not convenience: a payment is *defined* by what it can
-- be allocated against, and the allocation invariants below are what make PAY-02/04/06
-- safe. The BIL-*/INV-* handlers that write invoices arrive with the other half of M5, so
-- until then invoice rows come from fixtures — stated plainly rather than implied.
--
-- Three rules are enforced here and not only in the API:
--   * **Money is never edited, only reversed.** `payment_allocations` rows are inserted
--     once and afterwards only ever stamped `reversed_*`; nothing deletes them, and
--     `payments.amount_minor`/`method_code` are not writable after the fact (PAY-03
--     refuses them in the API; the cache column and the invariants below keep the
--     arithmetic honest even if a handler were wrong).
--   * **A payment can never allocate more than it is worth**, nor an invoice more than its
--     total: `payments.allocated_minor` is a cache that a **deferred constraint trigger**
--     reconciles against the allocations at commit, and every touched invoice's
--     `paid_minor` is reconciled against its active allocations the same way.
--   * **An invoice's arithmetic is derived from its lines.** `subtotal_minor`,
--     `adjustments_minor` and `total_minor` are checked against Σ`invoice_items` at commit,
--     so a wrong total cannot be committed even by a future billing run.
--
-- `balance_minor` is GENERATED ALWAYS … STORED and is never written by anyone.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- billing_runs — the run that issues invoices (written by BIL-*, read by nothing here)
-- ---------------------------------------------------------------------------
create table billing_runs (
  id               uuid primary key,
  run_key          text not null unique,          -- 'scheduler:2026-11-01' | 'manual:{key}'
  frequency        text not null check (frequency in ('weekly','monthly')),
  period_mode      text not null check (period_mode in ('calendar','anchored')),
  target_date      date not null,
  status           text not null check (status in ('issued','partial','failed')),
  preview_hash     text,
  invoices_created integer not null default 0,
  invoices_skipped integer not null default 0,
  summary          jsonb,
  triggered_by     text not null check (triggered_by in ('owner','scheduler')),
  started_by       uuid,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index billing_runs_target_idx on billing_runs (target_date desc);

-- ---------------------------------------------------------------------------
-- invoices — the money owed (read and updated by the payment surface)
-- ---------------------------------------------------------------------------
create table invoices (
  id                uuid primary key,
  invoice_number    text not null unique,          -- 'INV-2026-000123'
  kind              text not null check (kind in ('periodic','manual')),
  player_id         uuid not null references players (id),
  guardian_id       uuid references guardians (id),-- billed-to guardian at issue
  billing_run_id    uuid references billing_runs (id),
  period_start      date,                          -- null for a manual invoice
  period_end        date,
  issue_date        date not null,
  due_date          date not null,
  status            text not null check (status in ('issued','partially_paid','paid','void')),
  currency          char(3) not null default 'LKR',
  subtotal_minor    bigint not null check (subtotal_minor >= 0),
  adjustments_minor bigint not null default 0 check (adjustments_minor <= 0),
  total_minor       bigint not null check (total_minor >= 0),
  paid_minor        bigint not null default 0 check (paid_minor >= 0),
  -- Derived, never stored as truth (ADR-010 is about *overdue*, this is the same idea).
  balance_minor     bigint generated always as (total_minor - paid_minor) stored,
  snapshot          jsonb,
  version           integer not null default 1 check (version > 0),
  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text,
  suppress_reissue  boolean not null default false,
  pdf_file_id       uuid references files (id),
  pdf_input_hash    text,
  pdf_generated_at  timestamptz,
  pdf_stale         boolean not null default true,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint invoices_paid_within_total check (paid_minor <= total_minor),
  constraint invoices_total_is_lines check (total_minor = subtotal_minor + adjustments_minor),
  -- The lifecycle (BILLING_ENGINE §10) as a constraint: `paid ⇔ paid = total`,
  -- `partially_paid ⇔ 0 < paid < total`, `issued ⇔ paid = 0 AND total > 0`,
  -- `void ⇒ voided_at NOT NULL AND paid = 0`.
  constraint invoices_status_shape check (
    (status = 'issued' and paid_minor = 0 and total_minor > 0)
    or (status = 'partially_paid' and paid_minor > 0 and paid_minor < total_minor)
    or (status = 'paid' and paid_minor = total_minor)
    or (status = 'void' and paid_minor = 0 and voided_at is not null)
  )
);
-- No reissue unless the owner asked for one: a void invoice still occupies its period.
create unique index invoices_period_uq on invoices (player_id, period_start, period_end)
  where kind = 'periodic' and (status <> 'void' or suppress_reissue);
create index invoices_pdf_stale_idx on invoices (id) where pdf_stale;
create index invoices_player_due_idx on invoices (player_id, due_date);
create index invoices_open_due_idx on invoices (due_date) where status in ('issued','partially_paid');
create index invoices_run_idx on invoices (billing_run_id);
create index invoices_issue_idx on invoices (issue_date);

create table invoice_items (
  id               uuid primary key,
  invoice_id       uuid not null references invoices (id),
  line_no          smallint not null check (line_no > 0),
  item_type        text not null check (item_type in ('fee','adjustment')),
  description      text not null,
  quantity         integer not null default 1 check (quantity > 0),
  -- Negative only for an adjustment, and an adjustment must carry a reason.
  unit_amount_minor bigint not null,
  amount_minor     bigint not null,
  reason           text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  constraint invoice_items_line_uq unique (invoice_id, line_no),
  constraint invoice_items_amount_matches check (amount_minor = quantity * unit_amount_minor),
  constraint invoice_items_sign check (
    (item_type = 'fee' and unit_amount_minor > 0)
    or (item_type = 'adjustment' and unit_amount_minor < 0 and reason is not null)
  )
);
create index invoice_items_invoice_idx on invoice_items (invoice_id, line_no);

-- ---------------------------------------------------------------------------
-- payments and allocations — the money received and where it went
-- ---------------------------------------------------------------------------
create table payments (
  id                uuid primary key,
  amount_minor      bigint not null check (amount_minor > 0),
  currency          char(3) not null default 'LKR',
  method_code       text not null references payment_methods (code),
  reference         text,
  received_at       timestamptz not null,
  payer_guardian_id uuid references guardians (id),
  payer_name        text,
  status            text not null check (status in ('pending','confirmed','rejected','reversed')),
  confirmed_at      timestamptz,
  confirmed_by      uuid,
  rejected_at       timestamptz,
  rejected_by       uuid,
  rejected_reason   text,
  reversed_at       timestamptz,
  reversed_by       uuid,
  reversed_reason   text,
  notes             text,
  version           integer not null default 1 check (version > 0),
  -- Cache of Σ active allocations. The deferred trigger below is what stops it drifting.
  allocated_minor   bigint not null default 0 check (allocated_minor >= 0),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint payments_allocations_within_amount check (allocated_minor <= amount_minor),
  -- A pending payment holds nothing; only a confirmed one can carry allocations.
  constraint payments_status_shape check (
    (status = 'pending' and allocated_minor = 0)
    or (status = 'confirmed' and confirmed_at is not null)
    or (status = 'rejected' and rejected_at is not null and rejected_reason is not null
        and allocated_minor = 0)
    or (status = 'reversed' and reversed_at is not null and reversed_reason is not null)
  )
);
-- The duplicate-reference guard: one live payment per (method, reference). Two bank
-- transfers quoting the same slip number are how a receipt gets used twice (T-FIN-*).
create unique index payments_reference_uq on payments (method_code, lower(reference))
  where reference is not null and status in ('pending','confirmed');
create index payments_status_idx on payments (status);
create index payments_payer_idx on payments (payer_guardian_id);
create index payments_received_idx on payments (received_at desc);

create table payment_allocations (
  id            uuid primary key,
  payment_id    uuid not null references payments (id),
  invoice_id    uuid not null references invoices (id),
  amount_minor  bigint not null check (amount_minor > 0),
  allocated_at  timestamptz not null default now(),
  allocated_by  uuid not null,
  reversed_at   timestamptz,
  reversed_by   uuid,
  reverse_reason text
);
-- One live allocation per (payment, invoice); reversing frees the pair again.
create unique index payment_allocations_live_uq on payment_allocations (payment_id, invoice_id)
  where reversed_at is null;
create index payment_allocations_invoice_idx on payment_allocations (invoice_id) where reversed_at is null;
create index payment_allocations_payment_idx on payment_allocations (payment_id);

-- ---------------------------------------------------------------------------
-- payment_proofs — evidence, never payment (ADR-013/ADR-020/ADR-021)
-- ---------------------------------------------------------------------------
create table payment_proofs (
  id          uuid primary key,
  payment_id  uuid not null references payments (id),
  file_id     uuid not null references files (id),
  uploaded_by uuid not null,
  note        text,
  -- Derived from the sniffed type on upload; only the PDF can be parsed (CR-004).
  doc_kind    text not null check (doc_kind in ('bank_receipt_pdf','bank_receipt_image','other')),
  verification jsonb,        -- {status, extracted, findings[], parserVersion}
  checked_at  timestamptz,
  created_at  timestamptz not null default now(),
  -- PRF-03 keeps the row so the record of what was submitted survives (DATABASE §6).
  deleted_at  timestamptz,
  constraint payment_proofs_note_len check (note is null or length(note) <= 500)
);
create index payment_proofs_payment_idx on payment_proofs (payment_id) where deleted_at is null;
-- One file may back only one proof row: a reused object is a reused receipt.
create unique index payment_proofs_file_uq on payment_proofs (file_id);

-- ---------------------------------------------------------------------------
-- receipts — created in the transaction that confirms a payment (T2)
-- ---------------------------------------------------------------------------
create table receipts (
  id              uuid primary key,
  receipt_number  text not null unique,           -- 'RCT-2026-000045'
  payment_id      uuid not null unique references payments (id),
  issued_at       timestamptz not null default now(),
  file_id         uuid references files (id),
  pdf_input_hash  text,
  pdf_stale       boolean not null default true,
  -- Set on payment reversal (T4); the regenerated PDF then carries a VOID watermark.
  voided_at       timestamptz
);
create index receipts_stale_idx on receipts (id) where pdf_stale;

-- ---------------------------------------------------------------------------
-- Triggers: version bookkeeping, then the three invariants.
-- ---------------------------------------------------------------------------
create trigger payments_version_trg before update on payments
  for each row execute function app.bump_version();
create trigger invoices_version_trg before update on invoices
  for each row execute function app.bump_version();
create trigger invoices_touch_trg before update on invoices
  for each row execute function app.set_updated_at();
-- `receipts` deliberately has **no** `updated_at` and no `version` (DATABASE §3.3): a receipt is
-- issued once and afterwards only ever stamped `voided_at` or flagged `pdf_stale`, so a touch
-- trigger here would write a column that does not exist (it did, and every reversal failed with
-- `record "new" has no field "updated_at"`). `app.set_updated_at()` is therefore not attached.

-- 1. An invoice's totals are the sum of its lines (DATABASE §3.3, "txn + deferred trigger").
--    Deferred: a caller may insert the invoice and its items in any order inside one
--    transaction, and only the committed state has to be consistent.
create or replace function app.check_invoice_totals() returns trigger
  language plpgsql
  as $$
  declare
    v_invoice uuid;
    v_fee     bigint;
    v_adj     bigint;
  begin
    v_invoice := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;

    select coalesce(sum(amount_minor) filter (where item_type = 'fee'), 0),
           coalesce(sum(amount_minor) filter (where item_type = 'adjustment'), 0)
      into v_fee, v_adj
      from invoice_items
     where invoice_id = v_invoice;

    if exists (
      select 1 from invoices i
       where i.id = v_invoice
         and (i.subtotal_minor <> v_fee
              or i.adjustments_minor <> v_adj
              or i.total_minor <> v_fee + v_adj)
    ) then
      raise exception
        'invoice % totals do not match its lines (fees %, adjustments %, expected % + %)',
        v_invoice, v_fee, v_adj, v_fee, v_adj
        using errcode = 'check_violation';
    end if;
    return null;
  end
  $$;

create constraint trigger invoice_items_totals_trg
  after insert or update or delete on invoice_items
  deferrable initially deferred
  for each row execute function app.check_invoice_totals();

-- Changing an invoice's own totals without touching its lines is the other half of the
-- same rule.
create or replace function app.check_invoice_totals_self() returns trigger
  language plpgsql
  as $$
  declare
    v_fee        bigint;
    v_adj        bigint;
    v_subtotal   bigint;
    v_adjustments bigint;
    v_total      bigint;
  begin
    -- The **committed** row is compared, never `new`. A deferred event carries the row as it
    -- looked when its statement queued it, so a transaction that inserts an invoice and then
    -- writes its totals would otherwise be judged on the intermediate version — the same trap
    -- `check_payment_cache` below documents at length.
    select i.subtotal_minor, i.adjustments_minor, i.total_minor
      into v_subtotal, v_adjustments, v_total
      from invoices i
     where i.id = new.id;
    if not found then
      return null;  -- deleted later in the same transaction; nothing left to check
    end if;

    -- Only the arithmetic is checked here; `paid_minor` is the allocation trigger's job.
    select coalesce(sum(amount_minor) filter (where item_type = 'fee'), 0),
           coalesce(sum(amount_minor) filter (where item_type = 'adjustment'), 0)
      into v_fee, v_adj
      from invoice_items
     where invoice_id = new.id;

    if v_subtotal <> v_fee
       or v_adjustments <> v_adj
       or v_total <> v_fee + v_adj then
      raise exception
        'invoice % totals do not match its lines (fees %, adjustments %, total %)',
        new.id, v_fee, v_adj, v_fee + v_adj
        using errcode = 'check_violation';
    end if;
    return null;
  end
  $$;

create constraint trigger invoices_totals_trg
  after insert or update on invoices
  deferrable initially deferred
  for each row execute function app.check_invoice_totals_self();

-- 2. A payment's `allocated_minor` *is* its active allocations, and an invoice's
--    `paid_minor` *is* its active allocations — checked at commit, for both sides.
create or replace function app.check_allocation_invariants() returns trigger
  language plpgsql
  as $$
  declare
    v_payment uuid;
    v_invoice uuid;
    v_active  bigint;
    v_paid    bigint;
    v_amount  bigint;
    v_total   bigint;
  begin
    v_payment := case when tg_op = 'DELETE' then old.payment_id else new.payment_id end;
    v_invoice := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;

    select coalesce(sum(a.amount_minor), 0) into v_active
      from payment_allocations a
     where a.payment_id = v_payment and a.reversed_at is null;

    select p.amount_minor, p.allocated_minor into v_amount, v_paid
      from payments p where p.id = v_payment;

    if v_paid is not null and (v_paid <> v_active or v_active > v_amount) then
      raise exception
        'payment % allocation cache % does not match its active allocations % (amount %)',
        v_payment, v_paid, v_active, v_amount
        using errcode = 'check_violation';
    end if;

    select coalesce(sum(a.amount_minor), 0) into v_active
      from payment_allocations a
     where a.invoice_id = v_invoice and a.reversed_at is null;

    select i.paid_minor, i.total_minor into v_paid, v_total
      from invoices i where i.id = v_invoice;

    if v_paid is not null and (v_paid <> v_active or v_active > v_total) then
      raise exception
        'invoice % paid_minor % does not match its active allocations % (total %)',
        v_invoice, v_paid, v_active, v_total
        using errcode = 'check_violation';
    end if;
    return null;
  end
  $$;

create constraint trigger payment_allocations_invariants_trg
  after insert or update or delete on payment_allocations
  deferrable initially deferred
  for each row execute function app.check_allocation_invariants();

-- A handler that bumps the cache without writing the allocation (or the reverse) is caught
-- here: the cache may only change together with the rows it caches.
create or replace function app.check_payment_cache() returns trigger
  language plpgsql
  as $$
  declare
    v_active bigint;
    v_cached bigint;
  begin
    -- Read the **committed** row rather than `new.allocated_minor`. A constraint trigger fires
    -- at commit, but the row it is handed is frozen at the moment its statement queued it: a
    -- transaction that inserts a payment (`allocated_minor` 0) and then allocates 4,000 to it
    -- queues *two* events, and judging the first one on `new` would compare a stale 0 against
    -- the final 4,000 and reject a perfectly correct transaction. Reading the row back is the
    -- only version of this check that means what it claims: *the cache matches the committed
    -- allocations*.
    select p.allocated_minor into v_cached from payments p where p.id = new.id;
    if not found then
      return null;  -- the payment is gone; its allocations cannot outlive it (FK)
    end if;

    select coalesce(sum(a.amount_minor), 0) into v_active
      from payment_allocations a
     where a.payment_id = new.id and a.reversed_at is null;

    if v_cached <> v_active then
      raise exception
        'payment % allocated_minor % does not match its active allocations %',
        new.id, v_cached, v_active
        using errcode = 'check_violation';
    end if;
    return null;
  end
  $$;

create constraint trigger payments_cache_trg
  after insert or update on payments
  deferrable initially deferred
  for each row execute function app.check_payment_cache();

-- ---------------------------------------------------------------------------
-- The billing period rules (BILLING_ENGINE §3) live in SQL so the API, the preview and any
-- later report compute a period the same way. Calendar dates only — nothing here reads a
-- clock, so a period never depends on the server's timezone.
--
-- Both are expressed **from the anchor** and never from each other: in anchored mode the
-- next period's start is `anchor + (n + 1) months`, so a clamped month cannot drag the rest
-- of the year with it (anchor 31 Jan → 28 Feb → 31 Mar, not … 28 Mar).
-- ---------------------------------------------------------------------------
create or replace function app.billing_month_index(p_anchor date, p_date date) returns int
  language sql
  immutable
  as $$
  -- The largest `n` with `anchor + n months <= date` (the day clamped to the target month's
  -- length). Deliberately **not** `age()`: at the clamp boundary — anchor 31 Jan, date 28 Feb —
  -- `age()` answers "0 mon 28 days" and would file 28 Feb under January's period, which
  -- contradicts the rule that the next period *starts* on that day. One correction is enough:
  -- the estimate is always within the target month, so `n` or `n - 1` is the answer.
  select case
    when (p_anchor + make_interval(months => base.n))::date > p_date then base.n - 1
    else base.n
  end
  from (
    select (extract(year from p_date)::int - extract(year from p_anchor)::int) * 12
           + (extract(month from p_date)::int - extract(month from p_anchor)::int) as n
  ) base
  $$;

create or replace function app.billing_period_start(
  p_anchor date, p_date date, p_frequency text, p_mode text, p_week_start_day smallint
) returns date
  language sql
  immutable
  as $$
  select case
    when p_frequency = 'monthly' and p_mode = 'anchored' then
      (p_anchor + make_interval(months => app.billing_month_index(p_anchor, p_date)))::date
    when p_frequency = 'monthly' then
      date_trunc('month', p_date)::date
    when p_mode = 'anchored' then
      (p_anchor + make_interval(days => 7 * floor((p_date - p_anchor)::numeric / 7)::int))::date
    else
      p_date - ((extract(isodow from p_date)::int - p_week_start_day + 7) % 7)
  end
  $$;

create or replace function app.billing_period_end(
  p_anchor date, p_date date, p_frequency text, p_mode text, p_week_start_day smallint
) returns date
  language sql
  immutable
  as $$
  select case
    when p_frequency = 'monthly' and p_mode = 'anchored' then
      (p_anchor + make_interval(
        months => app.billing_month_index(p_anchor, p_date) + 1))::date - 1
    when p_frequency = 'monthly' then
      (date_trunc('month', p_date) + interval '1 month')::date - 1
    when p_mode = 'anchored' then
      (p_anchor + make_interval(
        days => 7 * (floor((p_date - p_anchor)::numeric / 7)::int + 1)))::date - 1
    else
      p_date - ((extract(isodow from p_date)::int - p_week_start_day + 7) % 7) + 6
  end
  $$;

-- ---------------------------------------------------------------------------
-- Row level security (DATABASE §7): the money tables are owner-only. There is deliberately
-- **no** coach policy, so a coach transaction matches nothing — the API denies the
-- permission first, and this is the backstop that makes it true even if the API were wrong.
-- ---------------------------------------------------------------------------
alter table billing_runs        enable row level security;
alter table billing_runs        force row level security;
alter table invoices            enable row level security;
alter table invoices            force row level security;
alter table invoice_items       enable row level security;
alter table invoice_items       force row level security;
alter table payments            enable row level security;
alter table payments            force row level security;
alter table payment_allocations enable row level security;
alter table payment_allocations force row level security;
alter table payment_proofs      enable row level security;
alter table payment_proofs      force row level security;
alter table receipts            enable row level security;
alter table receipts            force row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'billing_runs','invoices','invoice_items','payments','payment_allocations',
    'payment_proofs','receipts'
  ] loop
    execute format(
      'create policy %I on %I to ia_migrator using (true) with check (true)',
      t || '_migrator_all', t);
    execute format(
      'create policy %I on %I to ia_app using (app.app_role() = ''owner'') '
      || 'with check (app.app_role() = ''owner'')',
      t || '_owner_all', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants (DATABASE §7)
-- ---------------------------------------------------------------------------
grant select, insert, update on billing_runs, invoices, invoice_items, payments,
  payment_allocations, payment_proofs, receipts to ia_app;
grant execute on function app.check_invoice_totals(), app.check_invoice_totals_self(),
  app.check_allocation_invariants(), app.check_payment_cache() to ia_app;
grant execute on function app.billing_month_index(date, date),
  app.billing_period_start(date, date, text, text, smallint),
  app.billing_period_end(date, date, text, text, smallint) to ia_app;
