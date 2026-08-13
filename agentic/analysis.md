# Active Work

## Goal and Current State

Implement production-grade support for two distinct LinkedIn member accounts that can remain authenticated and process independently at the same time, without credential, session, queue, quota, identity, or follow-up leakage.

Bridgecode 4.1 ROBUST research is complete enough for the user decision boundary. No product implementation has been applied yet.

## Phase Zero

- Host: macOS 26.5.1 (Darwin 25.5.0), arm64.
- Repository revision: `3cde66e` on `main` tracking `origin/main`.
- Runtime: Node.js 26.0.0, npm 11.12.1, Python 3.14.6.
- Containers: Docker 29.5.2, Docker Compose 5.1.4.
- Application: Next.js 14 web UI, Supabase/Postgres state, Python Playwright scraper and sender workers, Docker Compose production deployment on Hostinger VPS.
- Existing unrelated worktree state to preserve: modified `AGENTS.md` and `CLAUDE.md`; untracked `.bridgecode/`, `README_HUMAN.txt`, `bridgecode/general-functions.md`, and `bridgecode/specific-functions/`.
- Dependencies budget: zero new dependencies. Existing Next.js, Supabase, and Playwright primitives are sufficient.
- Security boundary: encrypted passwords remain server-only; browser storage state remains gitignored and isolated on persistent storage; API routes remain protected by operator/session guards; logs and test artifacts must not contain passwords, cookies, tokens, or raw auth state.
- Reliability target: an account-specific failure, expired session, weekly limit, worker lock, or reset must not affect another account.
- Concurrency target: one worker per `(account, worker kind)` while different accounts may run concurrently.
- Compatibility target: existing data and the current session become the Primary account without losing status, batch, lead, sequence, or follow-up history.
- UI target: extend the existing Mission Control visual system and interaction grammar; no redesign or new visual language is required.

## Research and Evidence

### Current single-account contracts

- Credentials are a singleton `settings.key = 'linkedin_credentials'` record in both web actions and Python workers.
- Auth paths are module-level globals resolving to one `auth.json`, one `auth_status.json`, and one `interactive-profile`.
- The sender intentionally reuses that one scraper auth file.
- Docker Compose exposes one noVNC/CDP browser backed by the single scraper volume/profile.
- `lead_batches`, `leads`, and `outreach_sequences` have no LinkedIn account foreign key.
- Worker queue queries, daily counters, inbox scans, analytics, and stale-work recovery are global.
- The launch API and enrichment loop use one `enrichment.pid`, preventing safe parallel account runs.
- Sender identity classification accepts a global list of own names, while default sequence and follow-up prompt content still hard-code Katharina.

### Required architecture

- Add `linkedin_accounts` as the encrypted credential, sender identity, limits, active state, and non-secret session-status source of truth.
- Backfill one Primary account and attach current sequences, batches, leads, and existing outreach history.
- Assign each batch, sequence, and lead to exactly one account. Preserve the global unique LinkedIn URL safety invariant unless the user explicitly chooses duplicate outreach.
- Resolve per-account runtime directories under `/data/linkedin-accounts/<account-id>/` and pass validated `--account-id` to all worker modes.
- Scope every queue, counter, reply scan, follow-up, analytics, and recovery query to the selected account.
- Replace global locks with account-and-worker-kind locks. Reject duplicate same-account workers while allowing different accounts concurrently.
- Make login, session status/sync/reset, sender start/stop/health, import, batch, sequence, leads, follow-ups, and analytics account-aware.
- Use account-specific sender identity and sequence content; remove hard-coded reply-agent identity.
- Use isolated Playwright storage state and contexts. Interactive remote login requires either one remote browser per account or a serialized login broker; this is a user decision because it changes deployment cost and UX.

### External constraints

- Playwright supports multiple independent browser contexts initialized with separate storage-state files.
- Storage-state files contain sensitive impersonation material and must remain outside version control.
- LinkedIn prohibits unauthorized automated scraping, invitations, and messaging, and prohibits password/cookie sharing. The implementation can isolate two distinct real account owners but cannot eliminate LinkedIn restriction risk.

## User Decisions

- Both LinkedIn accounts must operate concurrently to maintain independent invite capacity.
- Every batch/import explicitly selects its sender account.
- LinkedIn URL uniqueness is per account, so the same target profile may exist once for each sender account.
- Production provides two isolated remote browser desktops and profiles.
- Implementation includes deployment-ready code and migration; live Supabase/Hostinger mutation remains outside this run unless separately authorized.

## Proposed Contract

- Two different real LinkedIn members, each completing their own login.
- One required account per batch; all imported leads inherit it.
- Existing data and session migrate to a Primary account.
- LinkedIn URL uniqueness is enforced by `(linkedin_account_id, linkedin_url)`.
- Sequences are account-owned so signatures and reply tone cannot cross accounts.
- Two account sessions and workers may be active concurrently.
- No new dependencies.

## Production Checklist

One coherent implementation block:

1. Add an idempotent Supabase migration creating `linkedin_accounts`, backfilling the existing singleton credentials into Primary, attaching account ownership to sequences/batches/leads, replacing global lead and sequence uniqueness with account-scoped constraints, and adding indexes/RLS.
2. Add a small account contract/runtime module in web code. Credential CRUD stays encrypted with the existing key mechanism; session state resolves under `/data/linkedin-accounts/<account-id>/` with legacy Primary-session fallback for migration safety.
3. Extend Settings using the existing design system: account list/cards, create/edit credentials and identity, individual status/login/sync/reset actions, and clear active/expired/error states.
4. Require account selection when importing a batch and when authoring/assigning sequences. Enforce account/sequence/batch consistency server-side and preserve account ownership through leads and follow-ups.
5. Add `--account-id` to scraper and sender entrypoints; resolve credentials, auth files, own-sender identity, queues, quotas, stale recovery, inbox scanning, and logs inside that account boundary.
6. Make launch/status/stop APIs account-aware. Use one lock per `(account, worker kind)` and derive the worker account from persisted batch/lead ownership where possible.
7. Add two isolated remote browser services and account-specific persistent profiles/routes while keeping the worker storage-state contract generic for future accounts.
8. Remove hard-coded sender identity from reply generation and pass the lead account identity through its context.
9. Add contract/regression tests for migration shape, path isolation, account-scoped queue/quota behavior, API validation, import uniqueness, and UI build/runtime behavior.
10. Run one real regression block: Python tests, web tests/type/build, Docker Compose validation, migration/static contract checks, and the running Settings/import UI through a browser without exposing secrets.

Locality budget: `{files: approximately 22 modified + 4 new production/test artifacts, LOC/file: new files <= 450 and existing deltas mostly <= 180 (sender.py delta <= 350), deps: 0}`. Existing oversized worker files will receive localized changes rather than a risky unrelated split.

## Execution Status

Implementation complete. Two account records can own independent credentials, browser slots, sequences, batches, leads, follow-ups, quotas, sessions, locks, and concurrent workers. All sender-selection boundaries validate or derive persisted ownership. Docker Compose exposes two isolated noVNC/CDP browser services and profiles.

## Review and Regression Result

- Production Next.js build passed with type checking (`next build --no-lint`). The repository-wide default build still has longstanding unrelated ESLint debt; every changed small web module passes targeted ESLint and `tsc --noEmit` passes.
- Python scraper, sender, auth, and follow-up agent compile successfully.
- Both Compose files are byte-identical and pass `docker compose config` after omitting the unavailable root `.env` reference during local validation.
- Migration/static invariants, whitespace checks, and account-scoped worker registration were reviewed. The local app health endpoint returns HTTP 200 on port 3000.
- Live Supabase migration and production deployment were intentionally not performed because they mutate external state and were outside the granted scope.

## Remaining Work

Operational rollout only: apply migration `020_add_linkedin_accounts.sql`, deploy the updated Compose stack, add/login the second account in Settings, sync each remote session, and launch account-owned batches. No implementation work remains.
