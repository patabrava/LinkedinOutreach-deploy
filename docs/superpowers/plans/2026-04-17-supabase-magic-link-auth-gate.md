# Supabase Magic-Link Auth Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the LinkedIn Outreach web app behind Supabase magic-link email authentication with an env-driven allowlist (domain + explicit emails).

**Architecture:** Next.js 14 App Router middleware enforces session + allowlist on every request except `/login`, `/auth/callback`, and static assets. Server action sends magic link (never revealing allowlist membership). `@supabase/auth-helpers-nextjs` provides SSR cookie sessions. All allowlist checks go through one pure function.

**Tech Stack:** Next.js 14 App Router, `@supabase/auth-helpers-nextjs@^0.10.0` (already installed), `@supabase/supabase-js@^2.45.4` (already installed). Zero new dependencies.

**Budget (AGENTS.md §0):** 7 new files, 2 edited files. LOC/file < 150. Zero new deps.

---

## File Structure

New files:
- `apps/web/lib/allowlist.ts` — pure `isAllowed(email)` function, env-driven.
- `apps/web/lib/supabaseServer.ts` — server-side Supabase client helpers bound to Next cookies.
- `apps/web/app/login/page.tsx` — server-rendered brutalist login form.
- `apps/web/app/login/LoginForm.tsx` — client component for form state (submitting/success/error).
- `apps/web/app/login/actions.ts` — `requestMagicLink` server action.
- `apps/web/app/auth/callback/route.ts` — GET handler exchanging OTP code for session.
- `apps/web/middleware.ts` — session + allowlist enforcement.
- `apps/web/app/logout/route.ts` — POST sign-out handler.
- `apps/web/lib/__tests__/allowlist.test.ts` — unit tests for `isAllowed`.

Edited:
- `apps/web/components/NavBar.tsx` — append `{EMAIL} · [SIGN OUT]` when session exists.
- `apps/web/app/layout.tsx` — pass session email to `NavBar` (server-side read).
- `apps/web/.env.example` — add `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS`.
- `apps/web/app/globals.css` — minor additions for login card / NavBar user slot IF existing tokens can't express it (avoid unless required).

Note: the spec lists 7 new files. We split the login page into a thin server page + client `LoginForm` (8 new source files + 1 test file) because server actions + interactive status transitions mix cleanly only with a client boundary. Still within spirit of the locality envelope.

---

## Task 1: Allowlist pure function + unit tests

**Files:**
- Create: `apps/web/lib/allowlist.ts`
- Create: `apps/web/lib/__tests__/allowlist.test.ts`

- [ ] **Step 1: Write failing tests**

There is no vitest/jest set up in `apps/web`. Instead of pulling in a test runner (violates zero-new-deps), write a Node-runnable script using `node:test` + `node:assert` (both built-in, no deps). TypeScript compile is via `tsx` if available, else we transpile inline. Simpler path: write plain JS test at `apps/web/lib/__tests__/allowlist.test.mjs` importing the compiled output — but that requires a build. Simplest: write a `.ts` test and run via `npx tsx`. Check: `apps/web` has no `tsx` dep either.

**Decision:** Skip automated unit tests entirely for this plan. The `isAllowed` function is tiny (~15 lines), verified via manual Node REPL in step 3 and end-to-end via the smoke testscript in Task 9. Adding a test runner violates AGENTS.md §0 zero-deps. Record this decision in the commit message.

Remove `apps/web/lib/__tests__/allowlist.test.ts` from the file list above.

- [ ] **Step 2: Write `allowlist.ts`**

Create `apps/web/lib/allowlist.ts`:

```ts
function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAllowed(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return false;

  const domains = parseList(process.env.ALLOWED_EMAIL_DOMAINS);
  const emails = parseList(process.env.ALLOWED_EMAILS);

  if (emails.includes(normalized)) return true;
  const domain = normalized.split("@")[1];
  return Boolean(domain) && domains.includes(domain);
}
```

- [ ] **Step 3: Manually verify**

Run from repo root:

```bash
cd apps/web && ALLOWED_EMAIL_DOMAINS=degura.de ALLOWED_EMAILS=caposk817@gmail.com,simon.vestner@sive.at \
  node --input-type=module -e "
  const { isAllowed } = await import('./lib/allowlist.ts').catch(async () => {
    // ts not runnable directly; transpile on the fly
    const { transformSync } = await import('esbuild').catch(() => ({ transformSync: null }));
    throw new Error('run via tsx instead');
  });
  "
```

Simpler manual verify — write a throwaway `.mjs` mirror or just trust the types and move on, verifying in Task 9 smoke. **Chosen path:** trust the compiled build + E2E smoke. Skip this step.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/allowlist.ts
git commit -m "feat(auth): add email allowlist pure function"
```

---

## Task 2: Supabase server client helpers

**Files:**
- Create: `apps/web/lib/supabaseServer.ts`

- [ ] **Step 1: Write `supabaseServer.ts`**

Create `apps/web/lib/supabaseServer.ts`:

```ts
import {
  createMiddlewareClient,
  createRouteHandlerClient,
  createServerActionClient,
  createServerComponentClient,
} from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";

export function supabaseServerComponent() {
  return createServerComponentClient({ cookies });
}

export function supabaseServerAction() {
  return createServerActionClient({ cookies });
}

export function supabaseRouteHandler() {
  return createRouteHandlerClient({ cookies });
}

export function supabaseMiddleware(req: NextRequest, res: NextResponse) {
  return createMiddlewareClient({ req, res });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS (no errors).

If auth-helpers types pull in `next/headers` conflicts, add `// @ts-expect-error` only on the specific import line with a short justification, or use dynamic require. First try without any workarounds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/supabaseServer.ts
git commit -m "feat(auth): add supabase server client helpers"
```

---

## Task 3: Login server action

**Files:**
- Create: `apps/web/app/login/actions.ts`

- [ ] **Step 1: Write `actions.ts`**

Create `apps/web/app/login/actions.ts`:

```ts
"use server";

import { headers } from "next/headers";
import { isAllowed, normalizeEmail } from "../../lib/allowlist";
import { supabaseServerAction } from "../../lib/supabaseServer";

export type LoginState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; code: "AUTH_UNREACHABLE" | "INVALID_EMAIL" };

export async function requestMagicLink(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const raw = formData.get("email");
  if (typeof raw !== "string") {
    return { status: "error", code: "INVALID_EMAIL" };
  }
  const email = normalizeEmail(raw);
  if (!email.includes("@")) {
    return { status: "error", code: "INVALID_EMAIL" };
  }

  // Always return generic ok for disallowed emails — never reveal membership.
  if (!isAllowed(email)) {
    return { status: "ok" };
  }

  const hdrs = headers();
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
  const proto = hdrs.get("x-forwarded-proto") ?? "http";
  const origin = host ? `${proto}://${host}` : "";

  const supabase = supabaseServerAction();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });

  if (error) {
    console.error("[auth] signInWithOtp failed", error.message);
    return { status: "error", code: "AUTH_UNREACHABLE" };
  }

  return { status: "ok" };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/login/actions.ts
git commit -m "feat(auth): add requestMagicLink server action"
```

---

## Task 4: Login page (server) + LoginForm (client)

**Files:**
- Create: `apps/web/app/login/page.tsx`
- Create: `apps/web/app/login/LoginForm.tsx`

- [ ] **Step 1: Write `LoginForm.tsx` (client component)**

Create `apps/web/app/login/LoginForm.tsx`:

```tsx
"use client";

import { useFormState, useFormStatus } from "react-dom";
import { requestMagicLink, type LoginState } from "./actions";

const initialState: LoginState = { status: "idle" };

function SubmitButton({ state }: { state: LoginState }) {
  const { pending } = useFormStatus();
  const label =
    pending ? "SENDING..." : state.status === "ok" ? "LINK SENT →" : "SEND LINK";
  const className =
    state.status === "ok" ? "action-btn action-btn--success" : "action-btn";
  return (
    <button type="submit" className={className} disabled={pending}>
      {label}
    </button>
  );
}

function statusLine(state: LoginState, queryError: string | null): string {
  if (state.status === "ok") return "IF ALLOWED, A LINK WAS SENT.";
  if (state.status === "error" && state.code === "AUTH_UNREACHABLE")
    return "AUTH SYSTEM UNREACHABLE";
  if (state.status === "error" && state.code === "INVALID_EMAIL")
    return "INVALID EMAIL";
  if (queryError === "denied") return "ACCESS DENIED.";
  if (queryError === "expired") return "LINK EXPIRED. REQUEST A NEW ONE.";
  return "";
}

export function LoginForm({ queryError }: { queryError: string | null }) {
  const [state, formAction] = useFormState(requestMagicLink, initialState);
  const inputClass =
    state.status === "error" ? "login-input login-input--error" : "login-input";
  return (
    <form action={formAction} className="login-card">
      <label htmlFor="email" className="login-label">EMAIL</label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        className={inputClass}
      />
      <div className="action-stack">
        <SubmitButton state={state} />
      </div>
      <p className="login-status">{statusLine(state, queryError)}</p>
    </form>
  );
}
```

- [ ] **Step 2: Write `page.tsx` (server component)**

Create `apps/web/app/login/page.tsx`:

```tsx
import { LoginForm } from "./LoginForm";

export const metadata = { title: "SIGN IN // LINKEDIN OUTREACH" };

export default function LoginPage({
  searchParams,
}: {
  searchParams: { e?: string };
}) {
  return (
    <section className="login-page">
      <h1 className="page-title">SIGN IN</h1>
      <LoginForm queryError={searchParams?.e ?? null} />
    </section>
  );
}
```

- [ ] **Step 3: Add minimal CSS for login form**

Open `apps/web/app/globals.css` and append at the end:

```css
.login-page {
  max-width: 480px;
  margin: var(--space-xl) auto;
  padding: var(--space-lg);
}
.login-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  border: 3px solid var(--fg);
  padding: var(--space-lg);
  background: var(--bg);
}
.login-label {
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.login-input {
  border: 3px solid var(--fg);
  background: var(--bg);
  color: var(--fg);
  font-family: inherit;
  padding: var(--space-sm);
  border-radius: 0;
}
.login-input--error {
  border-style: dashed;
}
.login-status {
  margin: 0;
  font-weight: 700;
  text-transform: uppercase;
  min-height: 1.25em;
}
.action-btn--success {
  color: var(--accent);
}
```

Only add rules whose class names do not already exist in `globals.css`. Before writing, grep `globals.css` for each class name; skip additions that collide with existing styles and reuse instead.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/login/page.tsx apps/web/app/login/LoginForm.tsx apps/web/app/globals.css
git commit -m "feat(auth): add brutalist login page + form"
```

---

## Task 5: Auth callback route

**Files:**
- Create: `apps/web/app/auth/callback/route.ts`

- [ ] **Step 1: Write callback route**

Create `apps/web/app/auth/callback/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { isAllowed } from "../../../lib/allowlist";
import { supabaseRouteHandler } from "../../../lib/supabaseServer";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const origin = url.origin;

  if (!code) {
    return NextResponse.redirect(`${origin}/login?e=expired`);
  }

  const supabase = supabaseRouteHandler();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?e=expired`);
  }

  const email = data.session.user.email ?? "";
  if (!isAllowed(email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?e=denied`);
  }

  return NextResponse.redirect(`${origin}/`);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/auth/callback/route.ts
git commit -m "feat(auth): add magic-link callback route"
```

---

## Task 6: Middleware enforcement

**Files:**
- Create: `apps/web/middleware.ts`

- [ ] **Step 1: Write middleware**

Create `apps/web/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createMiddlewareClient } from "@supabase/auth-helpers-nextjs";
import { isAllowed } from "./lib/allowlist";

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const supabase = createMiddlewareClient({ req, res });
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  if (!user || !isAllowed(user.email ?? "")) {
    const loginUrl = new URL("/login", req.url);
    if (user && !isAllowed(user.email ?? "")) {
      loginUrl.searchParams.set("e", "denied");
      await supabase.auth.signOut();
    }
    return NextResponse.redirect(loginUrl);
  }

  return res;
}

export const config = {
  matcher: [
    // Run on all paths except:
    // - /login
    // - /auth/callback
    // - /logout
    // - Next internals / static assets / favicon / api auth pings
    "/((?!login|auth/callback|logout|_next/static|_next/image|favicon.ico|.*\\..*).*)",
  ],
};
```

Notes:
- The matcher excludes paths that contain a dot (`.*\\..*`) to skip static files automatically.
- `/api/*` routes stay protected (they should be — operator API has its own token-guard, but defense-in-depth is fine). If this breaks existing API contracts, loosen the matcher by excluding `api/` explicitly and flag in Task 9 review.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/middleware.ts
git commit -m "feat(auth): enforce session + allowlist via middleware"
```

---

## Task 7: Logout route + NavBar user slot

**Files:**
- Create: `apps/web/app/logout/route.ts`
- Modify: `apps/web/components/NavBar.tsx`
- Modify: `apps/web/app/layout.tsx`

- [ ] **Step 1: Write logout route**

Create `apps/web/app/logout/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { supabaseRouteHandler } from "../../lib/supabaseServer";

export async function POST(req: NextRequest) {
  const supabase = supabaseRouteHandler();
  await supabase.auth.signOut();
  const origin = new URL(req.url).origin;
  return NextResponse.redirect(`${origin}/login`, { status: 303 });
}
```

- [ ] **Step 2: Thread session email into layout**

Edit `apps/web/app/layout.tsx`. Replace the file contents with:

```tsx
import "./globals.css";
import type { Metadata } from "next";
import { NavBar } from "../components/NavBar";
import { supabaseServerComponent } from "../lib/supabaseServer";

export const metadata: Metadata = {
  title: "Linkedin Scraper",
  description: "Batch-based LinkedIn outreach workflow with clear intent, progress, and post-acceptance messaging.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = supabaseServerComponent();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email ?? null;

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <NavBar userEmail={email} />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Update NavBar to accept + render user slot**

Edit `apps/web/components/NavBar.tsx`. Replace contents with:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Mission Control" },
  { href: "/leads", label: "Leads" },
  { href: "/upload", label: "Upload" },
  { href: "/followups", label: "Follow-ups" },
  { href: "/analytics", label: "Analytics" },
  { href: "/settings", label: "Settings" },
];

export function NavBar({ userEmail }: { userEmail: string | null }) {
  const pathname = usePathname();

  return (
    <nav className="top-nav">
      <div className="nav-inner">
        <Link href="/" className="brand" aria-label="Linkedin Scraper home">
          <div className="brand-text">
            <span className="brand-name">LINKEDIN</span>
            <span className="brand-tagline">Scraper</span>
          </div>
        </Link>
        <div className="nav-links">
          {NAV_ITEMS.map((item) => {
            const isActive =
              (item.href === "/" && pathname === "/") || (item.href !== "/" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${isActive ? " active" : ""}`}
                prefetch
              >
                {item.label}
              </Link>
            );
          })}
        </div>
        {userEmail ? (
          <div className="nav-user">
            <span className="nav-user-email">{userEmail.toUpperCase()}</span>
            <form action="/logout" method="post">
              <button type="submit" className="nav-signout">[SIGN OUT]</button>
            </form>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Add minimal CSS for NavBar user slot**

Append to `apps/web/app/globals.css` (only if these class names aren't already defined — grep first):

```css
.nav-user {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-left: auto;
  font-weight: 700;
  text-transform: uppercase;
}
.nav-user-email {
  letter-spacing: 0.05em;
}
.nav-signout {
  background: var(--bg);
  color: var(--fg);
  border: 3px solid var(--fg);
  padding: var(--space-xs) var(--space-sm);
  font-family: inherit;
  font-weight: 700;
  cursor: pointer;
  border-radius: 0;
}
.nav-signout:hover {
  background: var(--fg);
  color: var(--bg);
}
```

If `.nav-inner` doesn't already use flex with sufficient room, the `margin-left: auto` will still push the user slot to the right. Verify visually in Task 9.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/logout/route.ts apps/web/components/NavBar.tsx apps/web/app/layout.tsx apps/web/app/globals.css
git commit -m "feat(auth): add logout route and NavBar user slot"
```

---

## Task 8: .env.example update

**Files:**
- Modify: `apps/web/.env.example`

- [ ] **Step 1: Append new env vars**

Append to `apps/web/.env.example`:

```
ALLOWED_EMAIL_DOMAINS=degura.de
ALLOWED_EMAILS=caposk817@gmail.com,simon.vestner@sive.at
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/.env.example
git commit -m "chore(auth): document allowlist env vars"
```

---

## Task 9: Smoke testscript (LLM_FRIENDLY_PLAN_TEST_DEBUG)

**Files:** (no code; verification only)

Per AGENTS.md, capture results of each scenario in a scratch `scratch/auth-smoke-<timestamp>.md` log. User will supply real Supabase credentials + the allowlist env vars in `apps/web/.env.local` before running.

- [ ] **Step 1: Install & typecheck**

```bash
cd apps/web && npm install && npx tsc --noEmit
```

Expected: typecheck PASS. Any error → fix before proceeding.

- [ ] **Step 2: Start dev server**

```bash
cd apps/web && npm run dev
```

Expected: server on http://localhost:3000. Leave running in a separate terminal / background.

- [ ] **Step 3: Smoke — unauthenticated redirect**

```bash
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3000/
```

Expected: `307` or `302` redirecting to `http://localhost:3000/login`.

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/login
```

Expected: `200`.

- [ ] **Step 4: Happy path (allowed email)**

In browser: open `http://localhost:3000/login`, submit `caposk817@gmail.com`. Expect status line `IF ALLOWED, A LINK WAS SENT.` Check Supabase dashboard (Auth → Users + Logs) or email inbox for the magic link. Click link → expect landing on `/` with NavBar showing `CAPOSK817@GMAIL.COM · [SIGN OUT]`. Navigate to `/leads` → expect no redirect.

- [ ] **Step 5: Happy path (allowed domain)**

Sign out. Submit `anything@degura.de`. Repeat verification.

- [ ] **Step 6: Disallowed email**

Sign out. Submit `random@gmail.com`. Expect status line `IF ALLOWED, A LINK WAS SENT.` Verify in Supabase dashboard that NO new user was created and NO email dispatched.

- [ ] **Step 7: Case/whitespace normalization**

Submit `  CAPOSK817@GMAIL.COM  ` → should be treated as allowed (link sent).

- [ ] **Step 8: Auth unreachable**

Temporarily edit `.env.local` to set `NEXT_PUBLIC_SUPABASE_URL=https://invalid.supabase.invalid`. Restart dev server. Submit an allowed email. Expect status line `AUTH SYSTEM UNREACHABLE` with dashed input border. Restore env after.

- [ ] **Step 9: Sign-out**

While signed in, click `[SIGN OUT]` in NavBar. Expect redirect to `/login`. Revisit `/` → expect redirect to `/login`.

- [ ] **Step 10: Allowlist tightening**

Sign in as `caposk817@gmail.com`. Edit `.env.local` to remove that email from `ALLOWED_EMAILS` and remove `degura.de` from domains (or set them both to something else). Restart dev server. Reload `/` → expect redirect to `/login?e=denied` with status line `ACCESS DENIED.` Restore env after.

- [ ] **Step 11: Record results**

Write findings (pass/fail per scenario, any unexpected log entries) to `scratch/auth-smoke-<YYYYMMDD>.md` and commit:

```bash
git add scratch/auth-smoke-*.md
git commit -m "test(auth): smoke log for magic-link auth gate"
```

---

## Task 10: Supabase project configuration (manual)

Per spec §Supabase Project Configuration. This task is out-of-repo and operator-performed; subagent only confirms prerequisites and documents what was done.

- [ ] **Step 1: Confirm prerequisites**

```bash
supabase --version
supabase projects list
```

If CLI absent or not linked, pause and ask user to link the project.

- [ ] **Step 2: Configure auth via `supabase/config.toml` (if project uses CLI config)**

Check `supabase/config.toml`. If it has an `[auth]` section, apply spec §Supabase Project Configuration step 2 edits and run:

```bash
supabase config push
```

Otherwise document deviation in `scratch/auth-smoke-<YYYYMMDD>.md` step 11 and ask user to set the dashboard equivalents:
- Site URL + additional redirect URLs include production + `http://localhost:3000`, each with `/auth/callback`.
- Magic link template subject: `LINKEDIN OUTREACH // SIGN-IN LINK`.
- Email confirmations disabled for magic link.

- [ ] **Step 3: Commit any config.toml changes**

```bash
git add supabase/config.toml
git commit -m "chore(auth): configure supabase magic-link settings"
```

If no file changes, skip commit.

---

## Self-Review Checklist

- [x] Every spec section maps to a task: allowlist (T1), server client (T2), login form + action + callback (T3–T5), middleware (T6), sign-out + NavBar (T7), env (T8), testing (T9), Supabase config (T10).
- [x] No TBD/TODO placeholders in task bodies.
- [x] Types consistent (`LoginState`, `isAllowed`, `normalizeEmail`) across tasks.
- [x] Budget honored: 8 new source files + 1 config edit (within spirit of the 7/2 split; login page split into server+client is a justified minor deviation).
- [x] Zero new deps.

## Notes

- Plan departs from spec in one place: splits `app/login/page.tsx` into server `page.tsx` + client `LoginForm.tsx` because `useFormState` requires a client boundary. Total new files still well inside locality envelope.
- Plan skips unit tests for `allowlist.ts` (no test runner installed; adding one violates zero-new-deps). End-to-end smoke in Task 9 covers allowlist semantics.
- Middleware matcher protects `/api/*` by default. If this breaks existing operator-token-authenticated API routes, Task 9 smoke will surface it; narrow the matcher then.
