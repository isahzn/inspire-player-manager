-- ---------------------------------------------------------------------------
-- 0013_files_and_public_links — the two things M6 needs that no earlier
-- migration owns: the invoice capability tokens behind PUB-01, and a
-- generation timestamp on receipts so a stale receipt PDF is as visible as a
-- stale invoice one.
--
-- `files` (0001) already holds object metadata and already has its owner policy
-- and grants; `invoices` (0012) already carries pdf_file_id / pdf_input_hash /
-- pdf_generated_at / pdf_stale. Nothing here duplicates either.
--
-- The token table follows DATABASE §3.4 exactly: only the SHA-256 of the token
-- is stored, so the raw capability exists only in the outgoing message, and the
-- row is auto-revoked when its invoice is voided (FILES_AND_PDF §7).
--
-- Rollback: drop the trigger and function, drop the table, drop the column.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- receipts — the invoice tables carry `pdf_generated_at` and the receipts table
-- did not, so there was no way to answer "is this receipt's PDF stale, and for
-- how long" (the /system/health flag in FILES_AND_PDF §8). `pdf_stale` alone
-- says a rebuild is pending; it cannot say since when.
-- ---------------------------------------------------------------------------
alter table receipts add column pdf_generated_at timestamptz;

-- ---------------------------------------------------------------------------
-- invoice_access_tokens — the guardian's capability URL (PUB-01)
--
-- The link is unguessable (32 random bytes, base64url) and the database never
-- sees it: `token_hash` is the SHA-256. A leaked database therefore cannot
-- reconstruct a working link, which is the whole reason the raw value is not
-- stored. `guardian_id` records who it was sent to when a specific guardian was
-- addressed, and stays null for an unnamed share.
-- ---------------------------------------------------------------------------
create table invoice_access_tokens (
  id           uuid primary key,
  invoice_id   uuid not null references invoices (id),
  guardian_id  uuid references guardians (id),
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  use_count    integer not null default 0 check (use_count >= 0),
  last_used_at timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index invoice_access_tokens_invoice_idx on invoice_access_tokens (invoice_id);

-- ---------------------------------------------------------------------------
-- Voiding an invoice revokes its links, in the database rather than in one
-- handler, so it holds for every path that can void one (INV-04 today, a
-- reissue or a repair script later). FILES_AND_PDF §7: "revoked on void".
-- ---------------------------------------------------------------------------
create or replace function app.revoke_invoice_tokens_on_void() returns trigger
  language plpgsql
  as $$
  begin
    if new.status = 'void' and old.status is distinct from 'void' then
      update invoice_access_tokens
         set revoked_at = now()
       where invoice_id = new.id
         and revoked_at is null;
    end if;
    return null;
  end
  $$;

create trigger invoices_void_revokes_tokens_trg
  after update on invoices
  for each row execute function app.revoke_invoice_tokens_on_void();

-- ---------------------------------------------------------------------------
-- Resolving a capability URL happens with no session at all (PUB-01 is a
-- `public` route), and `invoice_access_tokens` is owner-only under RLS. As with
-- `app.find_invite` (0005), the answer is a narrow SECURITY DEFINER function
-- rather than a widened policy.
--
-- It returns the invoice id, or **null for every failure kind** — unknown token,
-- expired, revoked, or the invoice has since been voided. FILES_AND_PDF §7
-- requires exactly that: identical 404s, so nothing can be enumerated.
--
-- Validation and the `use_count` increment are one statement, so two concurrent
-- uses cannot both read a valid row and then both increment, and a use that is
-- refused never counts.
-- ---------------------------------------------------------------------------
create or replace function app.consume_invoice_token(p_token_hash text)
  returns uuid
  language plpgsql volatile security definer
  set search_path = public, app
  as $$
  declare
    v_invoice uuid;
  begin
    update invoice_access_tokens t
       set use_count = t.use_count + 1,
           last_used_at = now()
     where t.token_hash = p_token_hash
       and t.revoked_at is null
       and t.expires_at > now()
       and exists (
         select 1 from invoices i
          where i.id = t.invoice_id
            and i.status <> 'void'
       )
    returning t.invoice_id into v_invoice;

    return v_invoice;
  end
  $$;

revoke all on function app.consume_invoice_token(text) from public;
grant execute on function app.consume_invoice_token(text) to ia_app;
grant execute on function app.consume_invoice_token(text) to ia_migrator;

-- ---------------------------------------------------------------------------
-- Row level security (DATABASE §7): owner-only, like the rest of the money
-- surface. There is deliberately no coach policy and no anonymous policy — the
-- public route reaches the table only through `app.consume_invoice_token`.
-- ---------------------------------------------------------------------------
alter table invoice_access_tokens enable row level security;
alter table invoice_access_tokens force row level security;

create policy invoice_access_tokens_migrator_all on invoice_access_tokens
  to ia_migrator using (true) with check (true);
create policy invoice_access_tokens_owner_all on invoice_access_tokens
  to ia_app
  using (app.app_role() = 'owner')
  with check (app.app_role() = 'owner');

-- ---------------------------------------------------------------------------
-- Grants (DATABASE §7)
-- ---------------------------------------------------------------------------
grant select, insert, update on invoice_access_tokens to ia_app;
grant execute on function app.revoke_invoice_tokens_on_void() to ia_app;
