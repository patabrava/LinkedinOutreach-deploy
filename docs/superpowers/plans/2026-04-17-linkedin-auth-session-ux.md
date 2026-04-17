# LinkedIn Auth Session UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LinkedIn authentication state obvious to operators by showing whether credentials are saved, whether the cached session is valid, and when re-login is required.

**Architecture:** Keep the auth truth in one shared status contract that both the scraper worker and the web UI can read. The scraper writes a non-secret auth status sidecar alongside `auth.json` on the shared filesystem, and the web app reads that same status to render a single LinkedIn session card with clear actions and timestamps.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Playwright, Python 3.10+, Supabase client, existing repo tooling (`npm run lint:web`, `npm run build:web`, `python -m py_compile`).

---

## File Map

- `workers/scraper/auth.py` - define the auth status contract and read/write helpers next to `AUTH_STATE_PATH`.
- `workers/scraper/scraper.py` - update login/verification paths to write `session_active`, `session_expired`, and `login_required` states.
- `workers/scraper/README.md` - document the new operator-visible auth lifecycle in plain language.
- `apps/web/lib/linkedinAuthSession.ts` - shared server-side helpers for reading the auth status sidecar and shaping the UI summary.
- `apps/web/app/api/linkedin-auth/status/route.ts` - add a JSON endpoint so the UI can refresh the auth summary after login or on demand.
- `apps/web/app/settings/page.tsx` - fetch and pass the auth summary into settings.
- `apps/web/components/LoginLauncher.tsx` - render the new session card state, timestamps, and CTA logic.
- `apps/web/components/StartLoginButton.tsx` - change button copy and status messaging so it reflects the current session state.
- `apps/web/components/LinkedinCredentialsForm.tsx` - update helper text and success/error copy so credentials are clearly distinct from session validity.

**Budget:** 10 files total, target under 200 LOC per edited file, 0 new dependencies.

---

### Task 1: Define the shared LinkedIn auth status contract in the scraper

**Files:**
- Modify: `workers/scraper/auth.py`

- [ ] **Step 1: Add a non-secret auth status sidecar path and shape**

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

AUTH_STATE_PATH = Path(__file__).parent / "auth.json"
AUTH_STATUS_PATH = Path(__file__).parent / "auth_status.json"

AuthSessionState = Literal[
    "no_credentials",
    "credentials_saved",
    "session_active",
    "session_expired",
    "login_required",
]


@dataclass
class LinkedinAuthStatus:
    credentials_saved: bool
    session_state: AuthSessionState
    auth_file_present: bool
    last_verified_at: Optional[str]
    last_login_attempt_at: Optional[str]
    last_login_result: Optional[str]
    last_error: Optional[str]
```

- [ ] **Step 2: Add read/write helpers that preserve the latest status summary**

```python
def read_auth_status() -> LinkedinAuthStatus:
    if not AUTH_STATUS_PATH.exists():
        return LinkedinAuthStatus(
            credentials_saved=False,
            session_state="no_credentials",
            auth_file_present=AUTH_STATE_PATH.exists(),
            last_verified_at=None,
            last_login_attempt_at=None,
            last_login_result=None,
            last_error=None,
        )
    payload = json.loads(AUTH_STATUS_PATH.read_text())
    return LinkedinAuthStatus(
        credentials_saved=bool(payload.get("credentials_saved")),
        session_state=payload.get("session_state", "login_required"),
        auth_file_present=bool(payload.get("auth_file_present")),
        last_verified_at=payload.get("last_verified_at"),
        last_login_attempt_at=payload.get("last_login_attempt_at"),
        last_login_result=payload.get("last_login_result"),
        last_error=payload.get("last_error"),
    )


def write_auth_status(status: LinkedinAuthStatus) -> None:
    AUTH_STATUS_PATH.write_text(json.dumps(status.__dict__, indent=2, sort_keys=True))
```

- [ ] **Step 3: Add a small helper that updates only the changed fields**

```python
def update_auth_status(**updates) -> LinkedinAuthStatus:
    current = read_auth_status()
    payload = {**current.__dict__, **updates}
    status = LinkedinAuthStatus(**payload)
    write_auth_status(status)
    return status
```

- [ ] **Step 4: Keep the existing `auth.json` guard, but make the error point to the new UX instead of the raw file**

```python
def require_auth_state() -> None:
    if not AUTH_STATE_PATH.exists():
        raise FileNotFoundError(
            "LinkedIn session is missing. Open Settings and use 'Log in to LinkedIn' to create a fresh session."
        )
```

- [ ] **Step 5: Verify the module compiles**

Run: `python -m py_compile workers/scraper/auth.py`
Expected: no syntax errors.

### Task 2: Write session state transitions during login and verification

**Files:**
- Modify: `workers/scraper/scraper.py`
- Modify: `workers/scraper/auth.py`

- [ ] **Step 1: Record a clear state before login starts**

```python
update_auth_status(
    credentials_saved=bool(creds.email and creds.password),
    session_state="credentials_saved",
    auth_file_present=AUTH_STATE_PATH.exists(),
    last_login_attempt_at=now_iso_utc(),
    last_login_result="verification_required",
    last_error=None,
)
```

- [ ] **Step 2: Mark the session active after a successful login and storage save**

```python
await save_storage_state(context, path=AUTH_STATE_PATH)
update_auth_status(
    credentials_saved=True,
    session_state="session_active",
    auth_file_present=True,
    last_verified_at=now_iso_utc(),
    last_login_attempt_at=now_iso_utc(),
    last_login_result="success",
    last_error=None,
)
```

- [ ] **Step 3: Mark the session expired when a cached context no longer passes the LinkedIn check**

```python
if not await is_logged_in(context):
    update_auth_status(
        credentials_saved=bool(creds),
        session_state="session_expired",
        auth_file_present=AUTH_STATE_PATH.exists(),
        last_login_attempt_at=now_iso_utc(),
        last_login_result="failed",
        last_error="LinkedIn rejected the cached session.",
    )
    raise RuntimeError("LinkedIn session expired. Reconnect from Settings before scraping.")
```

- [ ] **Step 4: Mark the session as login_required when no credentials or no valid cache are available**

```python
if not creds:
    update_auth_status(
        credentials_saved=False,
        session_state="no_credentials",
        auth_file_present=AUTH_STATE_PATH.exists(),
        last_error="No LinkedIn credentials saved in Settings.",
    )
    raise RuntimeError("No LinkedIn credentials saved in Settings.")
```

- [ ] **Step 5: Keep the existing login window flow intact, but return the new state on failure paths**

```python
except TimeoutError as exc:
    update_auth_status(
        credentials_saved=True,
        session_state="login_required",
        auth_file_present=AUTH_STATE_PATH.exists(),
        last_login_attempt_at=now_iso_utc(),
        last_login_result="failed",
        last_error=str(exc),
    )
    raise
```

- [ ] **Step 6: Verify the worker still parses before moving on**

Run: `python -m py_compile workers/scraper/scraper.py workers/scraper/auth.py`
Expected: no syntax errors.

### Task 3: Expose the auth summary to the web app and render a single session card

**Files:**
- Create: `apps/web/lib/linkedinAuthSession.ts`
- Create: `apps/web/app/api/linkedin-auth/status/route.ts`
- Modify: `apps/web/app/settings/page.tsx`
- Modify: `apps/web/components/LoginLauncher.tsx`
- Modify: `apps/web/components/StartLoginButton.tsx`
- Modify: `apps/web/components/LinkedinCredentialsForm.tsx`

- [ ] **Step 1: Add a shared server-side reader for the status sidecar**

```ts
import fs from "fs";
import path from "path";

export type LinkedinAuthStatus = {
  credentials_saved: boolean;
  session_state: "no_credentials" | "credentials_saved" | "session_active" | "session_expired" | "login_required";
  auth_file_present: boolean;
  last_verified_at: string | null;
  last_login_attempt_at: string | null;
  last_login_result: "success" | "failed" | "verification_required" | null;
  last_error: string | null;
};

export function readLinkedinAuthStatus(): LinkedinAuthStatus {
  const scraperDir = path.resolve(process.cwd(), "..", "..", "workers", "scraper");
  const statusPath = path.join(scraperDir, "auth_status.json");
  if (!fs.existsSync(statusPath)) {
    return {
      credentials_saved: false,
      session_state: "no_credentials",
      auth_file_present: fs.existsSync(path.join(scraperDir, "auth.json")),
      last_verified_at: null,
      last_login_attempt_at: null,
      last_login_result: null,
      last_error: null,
    };
  }
  return JSON.parse(fs.readFileSync(statusPath, "utf8"));
}
```

- [ ] **Step 2: Add an API route that exposes the same summary to the client**

```ts
import { NextResponse } from "next/server";
import { readLinkedinAuthStatus } from "../../../../lib/linkedinAuthSession";

export async function GET() {
  return NextResponse.json({ ok: true, status: readLinkedinAuthStatus() });
}
```

- [ ] **Step 3: Fetch the auth summary on the settings page and pass it into the launcher**

```tsx
const [creds, authStatus] = await Promise.all([fetchLinkedinCredentials(), readLinkedinAuthStatus()]);

<LoginLauncher existingCreds={creds} authStatus={authStatus} />
```

- [ ] **Step 4: Render the single status card with clear CTA copy and timestamps**

```tsx
const copyByState = {
  no_credentials: { label: "No credentials", helper: "Add your LinkedIn email and password first.", action: "Save credentials" },
  credentials_saved: { label: "Credentials saved", helper: "Login is still required before scraping.", action: "Log in to LinkedIn" },
  session_active: { label: "Session active", helper: "You are ready to scrape.", action: "Recheck session" },
  session_expired: { label: "Session expired", helper: "LinkedIn rejected the cached session. Reconnect LinkedIn.", action: "Reconnect session" },
  login_required: { label: "Login required", helper: "LinkedIn did not accept the cached session.", action: "Reconnect session" },
};
```

- [ ] **Step 5: Change the login launcher messages so they tell the user what to do next**

```tsx
setMsg("Complete login in the browser window, then return here and click Recheck session.");
```

- [ ] **Step 6: Update the credentials form helper text so it no longer implies credentials alone are enough**

```tsx
<div className="muted" style={{ marginBottom: 16 }}>
  Stored securely in Supabase settings. Credentials are required, but scraping still depends on a valid LinkedIn session.
</div>
```

- [ ] **Step 7: Verify the web app builds and the settings route renders**

Run: `npm run build:web`
Expected: Next.js builds successfully and the Settings page compiles with the new session card.

### Task 4: Update the operator-facing copy and runtime feedback

**Files:**
- Modify: `workers/scraper/README.md`
- Modify: `apps/web/app/api/login/route.ts`
- Modify: `apps/web/components/StartLoginButton.tsx`
- Modify: `apps/web/components/LoginLauncher.tsx`

- [ ] **Step 1: Make the login route response explicit about what the button does and does not guarantee**

```ts
return NextResponse.json({
  ok: true,
  message: "Login window launched. Complete LinkedIn login, then return to Settings to recheck the session state.",
});
```

- [ ] **Step 2: Change the launcher button label to reflect the new verification flow**

```tsx
{running ? "LAUNCHING…" : "LOG IN TO LINKEDIN"}
```

- [ ] **Step 3: Add copy that distinguishes saved credentials from cached session validity**

```md
- Credentials are stored in Supabase settings.
- `auth.json` is the local session cache.
- The Settings page shows whether the cached session is currently usable.
```

- [ ] **Step 4: Verify the wording is consistent across UI and docs**

Run: `rg -n "auth.json|session active|credentials saved|login required|recheck session" apps/web workers/scraper`
Expected: only the intended user-facing phrases remain, and the UI copy no longer suggests that saving credentials alone means the scraper is ready.

### Task 5: Prove the end-to-end auth experience in a real runtime

**Files:**
- No code changes; verification only.

- [ ] **Step 1: Verify the scraper sidecar writes and reads cleanly**

Run:
```bash
cd workers/scraper
python - <<'PY'
from auth import LinkedinAuthStatus, write_auth_status, read_auth_status

status = LinkedinAuthStatus(
    credentials_saved=True,
    session_state="session_active",
    auth_file_present=True,
    last_verified_at="2026-04-17T10:00:00Z",
    last_login_attempt_at="2026-04-17T09:59:00Z",
    last_login_result="success",
    last_error=None,
)
write_auth_status(status)
loaded = read_auth_status()
assert loaded.session_state == "session_active"
print("OK")
PY
```
Expected: `OK`

- [ ] **Step 2: Verify the worker still compiles after the auth changes**

Run: `python -m py_compile workers/scraper/auth.py workers/scraper/scraper.py`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the web app compiles with the new status reader**

Run: `npm run build:web`
Expected: Next.js build succeeds.

- [ ] **Step 4: Run the app and inspect the Settings page in a browser**

Run:
```bash
npm run dev:web
```
Then open `http://localhost:3000/settings` and confirm the page shows:
- the LinkedIn session state label,
- the last verified timestamp when present,
- a primary CTA that matches the current state,
- and the existing credentials form below it.

Expected: the user can tell whether they still need to log in without opening `auth.json`.

- [ ] **Step 5: Exercise the login launcher flow**

Run:
```bash
curl -s -X POST http://localhost:3000/api/login
curl -s http://localhost:3000/api/linkedin-auth/status
```
Expected: the launch endpoint returns the new explanatory message, and the status endpoint returns the current session summary JSON.

- [ ] **Step 6: Commit the implementation plan and verification notes together if the runtime checks pass**

```bash
git add apps/web workers/scraper docs/superpowers/plans/2026-04-17-linkedin-auth-session-ux.md
git commit -m "docs: plan linkedin auth session ux"
```

---

## Spec Coverage Check

- Goal and ambiguity around `auth.json` visibility: covered by Tasks 1-4.
- Need to know whether credentials are saved: covered by the shared status contract and settings card in Task 3.
- Need to know whether the cached session is still usable: covered by Task 2 state transitions and Task 5 browser verification.
- Need to know when to log in again: covered by `session_expired` / `login_required` states in Tasks 2 and 3.
- Need to keep copy user-friendly and non-technical: covered by Task 4.

## Notes

- This plan intentionally keeps the implementation small and localized.
- It does not introduce a new dependency or a second auth system.
- The shared filesystem read is the simplest authority available in this repo because the web app and scraper already live in the same monorepo on the same host.
