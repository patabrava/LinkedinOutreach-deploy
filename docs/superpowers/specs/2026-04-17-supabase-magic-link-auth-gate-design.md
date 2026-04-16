# Supabase Magic-Link Auth Gate — Design

Date: 2026-04-17
Status: Approved (pending spec review)

## Goal

Gate the entire LinkedIn Outreach web app behind Supabase magic-link email authentication so it can be deployed online, and restrict access to a known allowlist (the `degura.de` domain plus two explicit addresses).

## Non-Goals

- Password auth, OAuth providers, SSO.
- Rate limiting beyond Supabase defaults.
- Admin UI for managing the allowlist (env var edit suffices for 2–5 operators).
- Role-based authorization inside the app (all allowed users are equal operators).

## Allowlist Rule

Single source of truth, env-driven:

- `ALLOWED_EMAIL_DOMAINS=degura.de`
- `ALLOWED_EMAILS=caposk817@gmail.com,simon.vestner@sive.at`

Rule: `isAllowed(email) == (domain(email) in ALLOWED_EMAIL_DOMAINS) OR (email in ALLOWED_EMAILS)`. Both inputs are lowercased and trimmed before comparison. Checked at two points: `/login` submit (before sending a magic link) and middleware (on every request).

## Architecture

- Next.js 14 App Router, Supabase Auth (magic link / OTP email).
- `@supabase/auth-helpers-nextjs` (already a dependency) for cookie-based SSR sessions.
- Middleware at app root enforces session validity + allowlist on every route except `/login`, `/auth/callback`, and static assets.
- Zero new dependencies.

## Components

### 1. `apps/web/lib/allowlist.ts` (new)

Pure function:

```ts
export function isAllowed(email: string): boolean
```

Reads `ALLOWED_EMAIL_DOMAINS` and `ALLOWED_EMAILS` from env at call time. Lowercases/trims. Single implementation used by the login action, callback route, and middleware.

### 2. `apps/web/lib/supabaseServer.ts` (new)

Thin wrapper returning a Supabase server client bound to Next cookies via `@supabase/auth-helpers-nextjs` (`createServerClient` / route handler / server action variants as needed). Keeps all auth-helpers imports in one place.

### 3. `apps/web/app/login/page.tsx` (new)

Server component rendering a centered brutalist card:

- One `<input type="email">` with label `EMAIL`.
- One submit button `SEND LINK`.
- One status line below the button.
- Status transitions:
  - idle → `SEND LINK` (black solid border).
  - submitting → button disabled, label `SENDING...`.
  - success → button becomes `LINK SENT →` in red (`--accent`), status line reads `IF ALLOWED, A LINK WAS SENT.`.
  - error → dashed black border on the input, status line reads the error code (e.g. `AUTH SYSTEM UNREACHABLE`).

Uses existing tokens only: `--bg`, `--fg`, `--accent`, `--border-*`, `.page-title`, `.action-stack`. No new CSS palette values.

### 4. `apps/web/app/login/actions.ts` (new)

Server action `requestMagicLink(formData)`:

1. Parse email.
2. `if (!isAllowed(email)) return genericSuccess()` — never reveal allowlist membership.
3. `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: ${origin}/auth/callback } })`.
4. On Supabase error: return `{ status: 'error', code: 'AUTH_UNREACHABLE' }`.
5. On success: return `{ status: 'ok' }`.

### 5. `apps/web/app/auth/callback/route.ts` (new)

GET handler:

1. Extract `code` from query.
2. `supabase.auth.exchangeCodeForSession(code)`.
3. Read session user email; if `!isAllowed(email)`, sign out and redirect to `/login?e=denied`.
4. Otherwise redirect to `/`.

### 6. `apps/web/middleware.ts` (new)

Runs on all paths except matcher exclusions: `/login`, `/auth/callback`, `/_next/*`, `/favicon.ico`, other static assets.

Steps: refresh session cookie → read user → if no user or `!isAllowed(user.email)` → redirect `/login`.

### 7. `apps/web/components/NavBar.tsx` (edit)

When a session exists, append to the right: `{EMAIL.UPPERCASE()} · [SIGN OUT]`. Sign-out is a server action that calls `supabase.auth.signOut()` and redirects `/login`. When no session, render nothing on the right (user only sees NavBar after login anyway).

### 8. `apps/web/app/logout/route.ts` (new)

POST handler invoked by the sign-out form — calls `signOut()` + redirect. (Alternatively a server action; decide during implementation based on which plays nicer with NavBar as a client/server component.)

## Data Flow

```
  /login form submit
      │
      ▼
  server action: isAllowed? ──no──▶ generic "IF ALLOWED, A LINK WAS SENT."
      │ yes
      ▼
  supabase.auth.signInWithOtp(email)
      │
      ▼  (email delivered)
  user clicks link ─▶ /auth/callback?code=...
      │
      ▼
  exchangeCodeForSession → set cookie → isAllowed re-check ──fail──▶ /login?e=denied
      │ pass
      ▼
  redirect /
      │
      ▼
  middleware on every request: session cookie + isAllowed → allow or redirect /login
```

## Error Handling

| Scenario | Response |
|---|---|
| Disallowed email on submit | Generic success message; no magic link sent. No enumeration signal. |
| Supabase unreachable on submit | Status line `AUTH SYSTEM UNREACHABLE`, dashed border. |
| Callback with invalid/expired code | Redirect `/login?e=expired`. |
| Allowlist changed after issuance (user no longer allowed) | Callback signs out, redirects `/login?e=denied`. |
| Middleware detects cookie but user deleted | Redirect `/login`. |

## Environment Variables

New:

- `ALLOWED_EMAIL_DOMAINS` (comma-separated; currently `degura.de`).
- `ALLOWED_EMAILS` (comma-separated; currently `caposk817@gmail.com,simon.vestner@sive.at`).

Existing (already present, reused):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server only; not used by auth flow but stays as-is).

`apps/web/.env.example` updated with the two new vars.

## Supabase Project Configuration (via CLI)

All Supabase-side configuration happens via `supabase` CLI against the linked project, no dashboard clicks.

Prerequisites:

- `supabase` CLI installed locally.
- `supabase login` completed with an access token that can reach the project.
- Project already linked (`supabase link --project-ref <ref>`); if not, the implementation plan will link it as step 0.

Steps that the plan will execute and verify:

1. `supabase status` — confirm project is linked and reachable.
2. Update `supabase/config.toml` under `[auth]` and `[auth.email]`:
   - `enable_signup = true` (magic link requires this; allowlist is enforced at the app layer).
   - `enable_confirmations = false` (magic-link OTP does not need a separate confirmation email).
   - `[auth.email.template.magic_link]` subject set to `LINKEDIN OUTREACH // SIGN-IN LINK`.
   - `site_url` and `additional_redirect_urls` include the production URL and `http://localhost:3000`, both with `/auth/callback`.
3. `supabase config push` — apply config to the linked project.
4. `supabase db remote commit` is NOT needed — no schema changes.
5. Verification:
   - `supabase auth list-users` (or SQL: `select email from auth.users`) to inspect the auth table.
   - Trigger a magic-link request against a local dev server, confirm the email arrives, and confirm callback succeeds end-to-end.

If the CLI-managed `config.toml` approach is not available for this project (e.g. project uses dashboard-only config), the plan will fall back to documenting the equivalent dashboard settings and note the deviation.

## Testing (per AGENTS.md LLM_FRIENDLY_PLAN_TEST_DEBUG)

Testscripts executed against a running `apps/web` on `http://localhost:3000` with a real Supabase project:

1. **Smoke** — hit `/` while logged out → expect 302 to `/login`.
2. **Smoke** — hit `/login` directly → expect 200, form rendered.
3. **Happy path** — submit `caposk817@gmail.com` → server action returns ok → Supabase CLI/dashboard confirms email dispatched → clicking link lands on `/` with session cookie set → subsequent `/leads` navigation stays on `/leads`.
4. **Happy path (domain rule)** — submit `anything@degura.de` → same flow succeeds.
5. **Edge (disallowed)** — submit `random@gmail.com` → action returns generic success → verify via `supabase auth list-users` that NO new user was created and no email was sent.
6. **Edge (case/whitespace)** — submit `  CAPOSK817@GMAIL.COM  ` → normalized, allowed.
7. **Failure path (Supabase down)** — temporarily point env to an invalid Supabase URL → submit → expect `AUTH SYSTEM UNREACHABLE` status line with dashed border.
8. **Recovery** — delete session cookie in browser → next request bounces to `/login`.
9. **Sign out** — click `[SIGN OUT]` → cookie cleared → `/` bounces to `/login`.
10. **Allowlist tightening** — sign in as allowed user, then remove the email from `ALLOWED_EMAILS`, restart web → next request redirects `/login?e=denied`.

Each failure captures: URL, network tab HAR, server log excerpt, Supabase log excerpt.

## Budget (AGENTS.md §0)

- **Files (new):** `lib/allowlist.ts`, `lib/supabaseServer.ts`, `app/login/page.tsx`, `app/login/actions.ts`, `app/auth/callback/route.ts`, `middleware.ts`, `app/logout/route.ts` — **7 files**.
- **Files (edited):** `components/NavBar.tsx`, `.env.example` — **2 files**.
- **LOC/file:** target < 150 each; no file expected to exceed 200.
- **Deps:** **0 new** (`@supabase/auth-helpers-nextjs` + `@supabase/supabase-js` already installed).

## Design System Compliance

Login view uses only existing brutalist tokens (`--bg`, `--fg`, `--accent`, `--border-*`, `--space-*`, `.page-title`, `.action-stack`). No new CSS variables, no new components introduced into the design system. Status transitions follow the loud-state-transition principle (red on success, dashed black border on error).

## Open Questions

None blocking. One soft question deferred to implementation: whether sign-out is a route handler or a server action — pick whichever integrates cleaner with the existing `NavBar` component shape.
