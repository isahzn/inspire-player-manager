-- ---------------------------------------------------------------------------
-- 0016_audit_chain_reader — the audit chain must be readable by whoever writes it.
--
-- THE DEFECT THIS REPAIRS
--
-- `app.audit_logs_chain()` (0001) extends the hash chain by reading the previous row's
-- hash. It is a plain SECURITY INVOKER plpgsql function, so that `select` ran with the
-- **writer's** privileges — and only an owner may read `audit_logs` (the `audit_read`
-- policy: `app.app_role() = 'owner'`, and any authenticated caller may append). The
-- consequence was not subtle:
--
--   * a coach's audited write (a clock-in, an attendance mark) could not see the owner's
--     rows at all, so it wrote `prev_hash = null` — the start of a **second chain**;
--   * so could a write with no identity, which is what a failed login records;
--   * and the nightly invariant job, recomputing the chain, reported a broken hash. That
--     is the alarm the release procedure treats as a rollback trigger (DEPLOYMENT §5), so
--     ordinary coach activity would have paged the operator — and an alarm that fires on
--     the normal case is one nobody looks at when it matters.
--
-- The chain was therefore a *forest* in production and a single chain only in tests that
-- happened to write as an owner. `tests/db/audit-chain.test.ts` now writes as an owner, a
-- coach and an anonymous caller and asserts exactly one root; it failed before this
-- migration and passes after it.
--
-- THE FIX
--
-- The trigger runs as `ia_migrator` — the role that owns these tables and the only role
-- with the blanket `audit_logs_migrator_all` policy — so its read sees every row whatever
-- the writer can see. `search_path` is pinned, as every SECURITY DEFINER function in this
-- schema does (0004/0005/0006/0011/0013/0014): a definer-rights function that resolves an
-- unqualified name through a caller-controlled path is how privilege escalation happens.
--
-- `ia_migrator` is deliberately not a superuser and does not have BYPASSRLS (asserted by
-- the RLS tests); the migrator policy is what grants the visibility, so this does not
-- widen the runtime role's access by one row.
--
-- `audit_logs` stays append-only: the trigger is `before insert` only, so nothing here
-- gives any role a new way to change an existing row.
--
-- THE REPAIR
--
-- Existing rows carry the fragments the defect produced (`prev_hash = null` in the middle
-- of the table), and a fragment is a permanently broken link: the invariant job would
-- report it for the life of the database. The fragments are repaired by recomputing
-- `prev_hash`/`row_hash` in id order, which is a rewrite of **derived** values only — no
-- row's content, actor or timestamp is touched.
--
-- This is safe exactly once, here, because nothing is deployed and no anchor has ever
-- attested to the old chain. After the first real verification, rewriting these hashes
-- would be destroying evidence rather than repairing it, and must not be repeated.
-- Existing `audit_anchors` rows are left in place (they are a record of what was verified
-- at that time) but they name hashes that this repair supersedes; the next nightly run
-- writes a fresh anchor over the repaired chain.
--
-- Rollback: a compensating migration restores `security invoker` and clears the pinned
-- search_path. The hashes cannot be un-repaired, which is why this file says so above.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The reader sees the whole chain, not just the rows the writer may read.
-- ---------------------------------------------------------------------------
alter function app.audit_logs_chain() security definer;
-- Asserted rather than assumed: the definer must be the role whose policy can read every
-- row. Any other owner would silently reintroduce exactly the defect above.
alter function app.audit_logs_chain() owner to ia_migrator;
alter function app.audit_logs_chain() set search_path = public, app;

comment on function app.audit_logs_chain() is
  'Extends the audit hash chain. SECURITY DEFINER as ia_migrator: the previous row must be '
  'readable regardless of the writer''s RLS visibility, or coach and anonymous writes start a '
  'second chain (0016).';

-- ---------------------------------------------------------------------------
-- 2. Repair the fragments the old reader produced.
--
-- The immutability trigger (audit_logs_no_update_trg) is disabled for the duration — the
-- table is append-only *by design*, and this is a migration performing the one rewrite that
-- design permits, in the same transaction, with the trigger put back immediately.
--
-- A recursive expression rather than one `lag()` window: each row's `prev_hash` must be the
-- **new** hash of its predecessor, not the old one, so the recomputation depends on the row
-- before it and cannot be done in a single pass.
-- ---------------------------------------------------------------------------
alter table audit_logs disable trigger audit_logs_no_update_trg;

do $$
declare
  row_in_chain record;
  previous_hash text := null;
begin
  for row_in_chain in
    select id, occurred_at, actor_user_id, actor_role, action, entity_type, entity_id,
           before, after, reason, request_id
      from audit_logs
     order by id
  loop
    update audit_logs
       set prev_hash = previous_hash,
           row_hash = app.audit_row_hash(
             previous_hash, row_in_chain.id, row_in_chain.occurred_at,
             row_in_chain.actor_user_id, row_in_chain.actor_role, row_in_chain.action,
             row_in_chain.entity_type, row_in_chain.entity_id, row_in_chain.before,
             row_in_chain.after, row_in_chain.reason, row_in_chain.request_id)
     where id = row_in_chain.id
     returning row_hash into previous_hash;
  end loop;
end
$$;

alter table audit_logs enable trigger audit_logs_no_update_trg;

-- The repair recomputed every hash, so the table's own integrity should be asserted by the
-- migration that claims to have fixed it: if this raises, the migration fails and rolls
-- back rather than leaving a chain that is still broken.
do $$
declare
  broken integer;
begin
  select count(*) into broken
    from (
      select prev_hash, row_hash, lag(row_hash) over (order by id) as expected_prev
        from audit_logs
    ) chained
   where coalesce(prev_hash, '') is distinct from coalesce(expected_prev, '');
  if broken > 0 then
    raise exception '0016 repair left % broken audit hash link(s)', broken;
  end if;
end
$$;
