# CSV_IMPORT (player migration)

> **Status:** Draft v1 · **Owner:** Claude (spec) / Freebuff + Hassen · **Updated:** 2026-10-11 · Endpoints: `IMP-01`, `IMP-02` in [API_CONTRACTS](../architecture/API_CONTRACTS.md).

Purpose: load the academy's existing players (Excel/WhatsApp lists) once, safely. **No opening balances in v1** — existing debts are entered afterwards as manual invoices (`INV-03`) so every number has an invoice behind it. Imports are owner-only and audited.

## 1. File rules
UTF-8 CSV (BOM allowed; Excel "CSV UTF-8" export), header row required, ≤ 1,000 rows, ≤ 2 MB, comma or semicolon delimiter auto-detected. Cell text starting with `= + - @` is accepted as data (import only reads) but trimmed of control characters.

## 2. Columns
| Column | Required | Rule |
|---|---|---|
| `full_name` | yes | 2–120 chars |
| `date_of_birth` | no | `YYYY-MM-DD`; not future |
| `registration_date` | no | `YYYY-MM-DD`; default = import date |
| `age_group` | no | exact name of an existing non-archived group (case-insensitive); empty ⇒ assignment pending |
| `status` | no | `active` (default) / `inactive` / `withdrawn` |
| `guardian1_name`, `guardian1_phone` | yes | phone normalized to E.164 (LK default); invalid ⇒ row error |
| `guardian1_relationship` | no | free text ≤ 40 |
| `guardian2_name`, `guardian2_phone` | no | both or neither |
| `whatsapp_consent` | no | `granted` / `unknown` (default). `granted` requires `consent_source` |
| `consent_source` | cond. | `registration_form`, `verbal`, `owner_entry` |
| `notes` | no | ≤ 1000, owner-only |

## 3. Flow
1. **Validate** (`IMP-01`): parse, normalize, check; nothing is written except an `import_batches` row (`status='validated'`) and the stored file. Response lists per-row **errors** (block), **warnings** (do not block: possible duplicate of existing player, DOB outside 3–25 years, unknown consent), and a preview.
2. Owner fixes the file and re-validates, or confirms.
3. **Commit** (`IMP-02`, `Idempotency-Key`): all-or-nothing transaction; creates players, guardians (re-using an existing guardian when the normalized phone **and** name match exactly), links, group history (effective = registration date), consent records, audit per player; assigns registration numbers sequentially. Rows with warnings commit only if the owner ticked "import rows with warnings". Re-committing the same batch ⇒ replay result.
4. Guardians default to consent `unknown` ⇒ **no WhatsApp automation until consent is recorded** ([OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) §11).

## 4. Tests
Valid file imports N players; invalid phone/age-group/date rows reported with row numbers; duplicate within the file flagged; commit atomicity (one DB failure ⇒ zero rows); idempotent replay; imported guardian shared by siblings is one row; Sinhala/Tamil names preserved.
