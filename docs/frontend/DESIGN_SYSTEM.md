# DESIGN_SYSTEM

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) / Hassen (implementation) · **Updated:** 2026-10-11
> **Depends on:** [PAGE_SPECIFICATIONS](PAGE_SPECIFICATIONS.md) · **Source of truth for:** tokens, components, responsive and accessibility rules.

## 1. Brand assets

| Asset | Status |
|---|---|
| Official academy logo | **Not provided.** Do not invent one. Owner uploads via Settings → Branding (`SET-03`); frontend reads `Me.academy.logoUrl`. Until then render the academy **name** as a text wordmark. |
| Official brand colors | **Unknown** (OPEN-001). Use the neutral fallback palette below. When the logo arrives, derive `--brand-*` tokens from it (one primary + one accent) and re-check contrast. |
| Favicon / app icon | Neutral placeholder until logo exists. |

## 2. Tokens (CSS variables; neutral fallback)

| Token | Light | Dark (optional v1.1) | Use |
|---|---|---|---|
| `--bg` | #F7F8FA | #0F1115 | page background |
| `--surface` | #FFFFFF | #171A21 | cards, tables |
| `--text` | #14181F | #E8EAEE | body (contrast ≥ 7:1 on surface) |
| `--text-muted` | #566070 | #A3ABB8 | secondary (≥ 4.5:1) |
| `--border` | #DDE1E7 | #2A2F3A | dividers |
| `--brand` | #1F6F4A | #3FA874 | primary actions (placeholder green — **replace with academy brand**) |
| `--brand-contrast` | #FFFFFF | #0F1115 | text on brand |
| `--info` / `--success` / `--warning` / `--danger` | #1D5FD1 / #1E7A43 / #9A6200 / #B3261E | tuned for dark | status (always with icon + text) |
| `--focus` | #1D5FD1 | #7AA7FF | 3 px focus ring, offset 2 px |

Verify every foreground/background pair meets WCAG 2.2 AA (4.5:1 text, 3:1 UI) with a checker before release.

## 3. Typography

System UI stack with web-safe fallbacks; include **Noto Sans / Noto Sans Sinhala / Noto Sans Tamil** as fallbacks so guardian/player names in Sinhala/Tamil render. Scale (rem): 0.75 caption · 0.875 small · 1 body (16 px min on mobile inputs to prevent iOS zoom) · 1.125 lead · 1.25 h3 · 1.5 h2 · 1.875 h1. Line-height 1.5 body. Numbers in tables use tabular figures and right alignment. Never truncate names without a tooltip/accessible full text.

## 4. Spacing, shape, elevation, motion

4 px base scale (4, 8, 12, 16, 24, 32, 48). Radius 8 px cards/inputs, 999 px chips. Elevation: 1 subtle shadow for cards, 2 for dialogs/sheets; prefer borders over shadows. Motion ≤ 200 ms, `prefers-reduced-motion` disables non-essential motion. Min touch target **44 × 44 px** (attendance controls and bottom-bar items ≥ 48).

## 5. Layout and responsive behaviour

| Breakpoint | Layout |
|---|---|
| < 640 px | Single column; bottom tab bar; tables → cards; filters in bottom sheet; dialogs → full-height sheets; sticky primary action bars (attendance Save) respecting `safe-area-inset-bottom` |
| 640–1023 px | Icon rail; 2-column forms; tables with horizontal scroll fallback and column priority hiding |
| ≥ 1024 px | Sidebar, max content width 1280 px, tables full columns, side drawers for details |

Mobile-first CSS; test at 360 × 640 minimum. Keyboards: numeric inputs use `inputmode="numeric"`/`tel` appropriately; date inputs use native pickers.

## 6. Component inventory

| Component | Notes |
|---|---|
| AppShell (sidebar/rail/bottom bar, banner area) | role-aware via `Me.permissions` |
| PageHeader (title, breadcrumbs, actions) | single `<h1>` |
| DataTable / CardList | server-side sort/page; URL-synced; empty/loading/error slots |
| FilterBar + FilterSheet | chips on mobile |
| StatusChip | variants: player, invoice (incl. derived Overdue), payment, message status, message delivery, session, health; always icon + text |
| MoneyText / MoneyInput | strict parse/format helpers ([API_INTEGRATION](API_INTEGRATION.md) §6) |
| DateText / TimeText | academy timezone aware |
| Form kit: TextField, PhoneField (E.164 preview), Select, Combobox (typeahead), DatePicker, Textarea, Switch, FileDrop (camera capture) | labels, helper, error slots wired with `aria-describedby` |
| AttendanceRow + SegmentedControl (P/L/A/E) | radiogroup semantics, 48 px |
| ConfirmDialog / ReasonDialog | focus trap, ESC closes (unless pending), default focus on the safe button |
| Toast (live region, `role="status"`), InlineAlert, Banner (`role="alert"` for critical) | |
| Drawer / BottomSheet | |
| Stepper (billing wizard) | |
| Timeline (group history, message events, payment status) | |
| PdfLink/PdfViewer (open in new tab; no inline library required) | |
| EmptyState, ErrorState, PermissionDenied, Skeletons | |
| Stat card (dashboard) | definition tooltip for each metric |

## 7. State patterns

Loading: skeleton (not spinner) for lists/cards, inline spinner on buttons (button keeps width). Empty: icon + one sentence + primary action. Error: message, requestId (copyable), Retry. Optimistic updates **only** for non-financial toggles; money, allocation and billing actions wait for server confirmation. Success toasts auto-dismiss after 5 s; errors persist until dismissed.

## 8. Accessibility requirements (WCAG 2.2 AA target)

- Full keyboard operation; visible focus (`--focus`); logical tab order; skip-to-content link; no keyboard traps; dialogs trap and restore focus.
- Semantics: landmarks (`header/nav/main`), one `h1`, tables with `<th scope>` and captions, lists for cards, `aria-sort` on sortable headers, `aria-live="polite"` for toasts and save results, `aria-busy` while loading.
- Status never by colour alone (icon + text). Form errors: summary at top with links + inline messages; `aria-invalid`.
- Touch targets ≥ 44 px; spacing ≥ 8 px between adjacent targets; zoom to 200 % without loss; support 320 px reflow.
- Respect `prefers-reduced-motion` and `prefers-color-scheme` (dark optional).
- Language attribute set; names in Sinhala/Tamil not forced into Latin fonts; `dir` default ltr.
- Automated checks (axe) in CI + manual keyboard and screen-reader pass for: login, attendance sheet, record payment, billing wizard.

## 9. Content style

Plain, calm, specific. Buttons are verbs ("Record payment", "Void invoice"). Errors say what happened and what to do. English first; copy kept in a message catalogue so Sinhala/Tamil UI can be added later [not in v1].

## 10. Frontend implementation note (2026-10-11, UI/UX Pro Max applied)

Provenance: UI/UX Pro Max skill IS installed (skills and plugins/ui-ux-pro-max, SKILL.md read). Ran --design-system for "football academy management dashboard admin panel": pattern Data-Dense + Drill-Down kept; style Data-Dense Dashboard kept; suggested purple/orange + Fira rejected (wrong mood for football; Fira felt dev-tool) in favour of existing prototype tokens below (sport + trust, phone readability, contrast 4.5:1+). Priorities 1-4 applied.

### Next.js token mapping (frontend/app/globals.css)

--bg #F7F8FA / --surface #FFFFFF / --text #14181F / --text-muted #566070 / --border #DDE1E7 / --brand #16A34A (pitch-600, hover #15803D) / --brand-contrast #FFFFFF / --navy #0A1F44 (sidebar) / --info #1D5FD1 / --success #1E7A43 / --warning #9A6200 / --danger #B3261E / --focus #1D5FD1 (3px ring, offset 2px). Tailwind extend: navy.900/800/700, pitch.600/700/50, amberx.500/50, shadow card/pop, font heading Poppins / body Inter, z-scale nav 20 / top 30 / modal 50.

### Type scale (rem)

0.75 caption / 0.875 small / 1 body (16px min on mobile inputs, prevents iOS zoom) / 1.125 lead / 1.25 h3 / 1.5 h2 / 1.875 h1. Line-height 1.5-1.6 body. Tables: tabular-nums, right-aligned numbers. Noto Sans Sinhala/Tamil fallbacks for names.

### Components (lifted from design/ prototype)

AppShell (sidebar 248px desktop / rail tablet / bottom tab bar + More sheet mobile), PageHeader (single h1), DataTable/CardList (server sort/page, URL-synced), StatusChip (icon+text, never colour alone), MoneyText/MoneyInput (strict minor-unit helpers), AttendanceRow + SegmentedControl P/L/A/E (radiogroup, 48px targets), ConfirmDialog/ReasonDialog (focus trap, safe-button default focus), Toast (role=status, 5s) / Banner (role=alert critical) / InlineAlert, Drawer/BottomSheet, Stepper (billing wizard), Timeline, PdfLink (new tab, noopener), EmptyState/ErrorState (requestId + Retry)/PermissionDenied/Skeletons.

### Mobile behaviour (coach attendance sheet, one-handed)

Single column <640px; sticky top counts chips (Present/Late/Absent/Excused/Unmarked) + Mark-all-present; rows 56px+ with 48x48 segmented targets, 8px gaps; sticky bottom full-width Save bar with safe-area-inset-bottom; filters in bottom sheet; dialogs become full-height sheets; tables horizontal-scroll or cards; touch-action manipulation; 200ms color-only transitions; prefers-reduced-motion disables motion.
