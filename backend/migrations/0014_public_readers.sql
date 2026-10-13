-- ---------------------------------------------------------------------------
-- 0014_public_readers — the two unauthenticated reads M6 adds, each behind one
-- narrow SECURITY DEFINER function.
--
-- Why functions rather than policies: both routes run with **no session at all**
-- (PUB-01/`PUB-02` are `auth: public`), so there is no `app.user_id`/`app.role`
-- for a policy to match. Every table involved (`invoice_access_tokens`,
-- `invoices`, `files`, `academy_settings`) is owner-only under FORCE ROW LEVEL
-- SECURITY, and widening any of those policies to anonymous would expose the
-- whole money surface to a caller who has nothing. So, exactly as
-- `app.find_invite` (0005) did, the anonymous path gets a function that can
-- answer **one** question and no more.
--
-- `app.consume_invoice_token(uuid)`, added in 0013, is replaced here: the public
-- route needs the invoice's number and its PDF object as well as the fact that
-- the token is valid, and reading those separately would either need a second
-- privileged function or a policy. Replacing it keeps one call, one transaction
-- and one place where the expiry/revocation rule lives.
--
-- Rollback: drop both functions and recreate the 0013 version of
-- `app.consume_invoice_token`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- app.public_invoice_document(token_hash)
--
-- Resolves a capability token to the document behind it, or returns **no rows**
-- for every failure kind: unknown token, expired, revoked, voided invoice, and
-- an invoice whose PDF has not been generated. FILES_AND_PDF §7 requires the
-- identical 404 for all of them, so they must be indistinguishable *here* —
-- which is the only place that can see enough to tell them apart.
--
-- `use_count`/`last_used_at` move in the same statement that validates, so two
-- concurrent uses cannot both read a valid row and then both count, and a use
-- that is refused is never counted.
-- ---------------------------------------------------------------------------
drop function if exists app.consume_invoice_token(text);

create or replace function app.public_invoice_document(p_token_hash text)
  returns table (invoice_id uuid, invoice_number text, storage_key text, mime_type text)
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

    if v_invoice is null then
      return;                       -- one indistinguishable answer for every refusal
    end if;

    return query
      select i.id, i.invoice_number, f.storage_key, f.mime_type
        from invoices i
        -- A deleted or superseded object is a missing document, not a 500.
        left join files f on f.id = i.pdf_file_id and f.deleted_at is null
       where i.id = v_invoice;
  end
  $$;

revoke all on function app.public_invoice_document(text) from public;
grant execute on function app.public_invoice_document(text) to ia_app;
grant execute on function app.public_invoice_document(text) to ia_migrator;

-- ---------------------------------------------------------------------------
-- app.public_logo()
--
-- The academy's own logo, for the one anonymous read that serves it (SET-03's
-- `logoUrl` is documented as a public URL, and with no bucket there is no other
-- way to honour that). It answers with the **current** logo only and takes no
-- argument, so it cannot be pointed at another file: there is no id to guess and
-- no way to enumerate the private objects beside it.
-- ---------------------------------------------------------------------------
create or replace function app.public_logo()
  returns table (storage_key text, mime_type text)
  language sql stable security definer
  set search_path = public, app
  as $$
    select f.storage_key, f.mime_type
      from academy_settings a
      join files f on f.id = a.logo_file_id and f.deleted_at is null
     where a.id = 1
  $$;

revoke all on function app.public_logo() from public;
grant execute on function app.public_logo() to ia_app;
grant execute on function app.public_logo() to ia_migrator;
