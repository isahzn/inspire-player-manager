-- ---------------------------------------------------------------------------
-- Seed — runs in EVERY environment (DATABASE §10).
--
-- Re-runnable: every statement is ON CONFLICT DO NOTHING, so a redeploy cannot
-- duplicate a payment method or overwrite an owner's edited template.
--
-- Defaults follow the documented safe defaults: monthly + calendar billing
-- (OPEN-018), invoices issued in advance (OPEN-006), due 7 days after issue,
-- age reference Jan 1 (OPEN-003), automation opt-in and OFF (CR-003 pending
-- approval / ADR-019). Dev-only fake people are seeded by `scripts/seed-dev.ts`,
-- never here.
-- ---------------------------------------------------------------------------

insert into academy_settings (id, name, timezone, billing_frequency, billing_period_mode,
                              due_rule_type, due_rule_value, invoice_issue_timing, age_reference_rule)
values (1, 'Inspire Academy', 'Asia/Colombo', 'monthly', 'calendar',
        'days_after_issue', 7, 'period_start', 'jan_1_of_year')
on conflict (id) do nothing;

insert into payment_methods (code, label, requires_reference, is_active, sort_order) values
  ('cash',          'Cash',          false, true, 1),
  ('bank_transfer', 'Bank transfer', true,  true, 2),
  ('other',         'Other',         false, true, 3)
on conflict (code) do nothing;

-- Default reminder offsets (DATABASE §3.6).
insert into reminder_rules (id, kind, offset_days, is_active) values
  (gen_random_uuid(), 'pre_due', 3,  true),
  (gen_random_uuid(), 'pre_due', 1,  true),
  (gen_random_uuid(), 'overdue', 1,  true),
  (gen_random_uuid(), 'overdue', 7,  true),
  (gen_random_uuid(), 'overdue', 14, true)
on conflict (kind, offset_days) do nothing;

-- Default templates (OPENWA_INTEGRATION §5). Variables are validated on save:
-- {{guardianName}} {{playerName}} {{invoiceNumber}} {{amountDue}} {{dueDate}}
-- {{invoiceLink}} {{academyName}}.
insert into message_templates (key, body) values
  ('invoice_delivery', $tpl$Hello {{guardianName}}, this is {{academyName}}. Invoice {{invoiceNumber}} for {{playerName}} is ready.
Amount due: {{amountDue}} · Due: {{dueDate}}
View/download: {{invoiceLink}}
Reply STOP to stop these messages.$tpl$),
  ('reminder_pre_due', $tpl$Hello {{guardianName}}, a friendly reminder from {{academyName}}: invoice {{invoiceNumber}} for {{playerName}} ({{amountDue}}) is due on {{dueDate}}. {{invoiceLink}}
Reply STOP to stop reminders.$tpl$),
  ('reminder_overdue', $tpl$Hello {{guardianName}}, invoice {{invoiceNumber}} for {{playerName}} ({{amountDue}}) was due on {{dueDate}}. If you have already paid, please ignore this message. {{invoiceLink}}
Reply STOP to stop reminders.$tpl$)
on conflict (key) do nothing;

-- Document counters for the current academy year (next numbers start at 1).
insert into document_counters (name, year, next_value)
select n, extract(year from now())::int, 1
  from (values ('invoice'), ('receipt'), ('player_reg')) as names(n)
on conflict (name, year) do nothing;
