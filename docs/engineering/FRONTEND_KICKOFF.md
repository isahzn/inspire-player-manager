# FRONTEND_KICKOFF — exact first instructions for Hassen

1. **Read** (≈ 45 min): `CLAUDE.md` → `docs/engineering/PROJECT_STATUS.md` → `docs/engineering/FRONTEND_BUILD_GUIDE.md` → `docs/frontend/ROUTES_AND_NAVIGATION.md` → `docs/frontend/PAGE_SPECIFICATIONS.md` (skim §0–§3, §5 in detail) → `docs/frontend/DESIGN_SYSTEM.md` → `docs/frontend/API_INTEGRATION.md`.
2. **Answer or accept defaults** in `docs/engineering/OPEN_DECISIONS.md`: OPEN-021 (your framework — Next.js assumed), OPEN-003, OPEN-006, OPEN-018, OPEN-001 (send the **logo + brand colors** if the academy has them; otherwise the neutral palette is used).
3. **Give Freebuff** the block in `docs/engineering/FREEBUFF_KICKOFF.md`.
4. **Scaffold the app (M1):** TypeScript project; design tokens from DESIGN_SYSTEM §2; AppShell with the route map (empty pages are fine); `src/lib/money.ts` + `dates.ts` + unit tests (T-UI-01); `src/api/client.ts` (credentials, CSRF header, error mapping per API_INTEGRATION §3).
5. **Set up MSW** with the fixtures in `docs/engineering/MOCK_DATA.md`: login, `me` (owner + coach), players list, one invoice, one attendance roster.
6. **Build the coach attendance sheet first** (PAGE_SPEC §5) against mocks and test it on a real phone at 360 px width — it is the riskiest UX.
7. **Review `api/openapi.yaml`** when Freebuff delivers it (M1 exit): generate TypeScript types, make the mocks validate against it, and report gaps via `HANDOFF_TEMPLATE.md` (section 4 "Contract drift / requests").
8. **Never call an endpoint that is not in the contract.** Missing something? File a contract request; don't improvise.
