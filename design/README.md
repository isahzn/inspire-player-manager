# Inspire Academy — Front-End Design (prototype)

Pure front-end design prototype. **No backend, no real data** — all mock data in `app.js`.
Open `index.html` directly in a browser (double-click) — Tailwind + icons load from CDN.

## Design system (via `ui-ux-pro-max` skill)

| Decision | Choice | Why |
|---|---|---|
| Pattern | Data-Dense + Drill-Down dashboard | Owner needs KPIs → drill to player/invoice |
| Style | Swiss minimalism + data-dense cards | Polished management tool, not a template; WCAG AA/AAA, fast |
| Type | **Poppins** headings / **Inter** body | Skill's Fira Code felt too "dev-tool"; Poppins+Inter stays professional + readable on phones |
| Color | Navy `#0A1F44` · Pitch green `#16A34A` · Amber `#F59E0B` · Slate bg | Skill suggested purple/orange "event" theme — rejected as wrong for football; pitch green + navy = sport + trust, contrast ≥ 4.5:1 |
| Stack | html-tailwind (CDN) + vanilla JS + Lucide SVG | Zero build step, you can lift the design into any framework |
| UX rules applied | 44px touch targets · 16px min body · tables→cards/scroll on mobile · 200ms color-only transitions · visible focus rings · `prefers-reduced-motion` · no emoji icons · z-scale 20/30/50 | From skill priorities 1–4 (critical/high) |

## What's inside

- **Role switcher** (top pill + sidebar): Owner = full access · Coach = U13-scoped, money/admin show a "Restricted — enforced on server" state
- **Views:** Dashboard · Players · Player profile · Age groups · Coaches · Sessions + fast attendance (big Present/Absent/Late/Excused buttons, bulk) · Coach check-in/out · Billing · Invoice detail + record-payment modal · WhatsApp/OpenWA log + retry · Reports · Users · Settings · Audit & health
- **States shown:** loading skeleton CSS, empty states, permission-denied, destructive confirms (withdraw player, void invoice), toasts
- **Mobile-first:** sidebar → bottom tab bar + "More" sheet; KPI grid 2-col; tables horizontal-scroll; bottom padding for safe-area

## Files

- `index.html` — shell: sidebar, topbar, bottom nav, modal, confirm, toasts
- `app.js` — mock data + all view renderers + interactions
- `README.md` — this file

## Next (your plan, later)

This is the design layer only. API contracts, DB, OpenWA, billing engine stay for the architecture docs — the screens already encode their key rules (snapshots, oldest-first allocation, proof ≠ payment, no silent group moves, idempotent retries) so the plan can reference them.
