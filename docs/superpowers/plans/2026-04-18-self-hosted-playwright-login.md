# Self-Hosted Playwright LinkedIn Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the non-interactive VPS login attempt with a self-hosted remote browser that the operator can use from `deguraleads.de/settings`, then export that authenticated session into the existing scraper `auth.json`.

**Architecture:** Add a dedicated `linkedin-browser` Docker service that runs Chromium inside Xvfb with noVNC and a CDP endpoint. The settings page will embed the remote browser, the operator will complete LinkedIn login there, and the scraper worker will connect over CDP to export `storage_state` into the shared `/data/scraper/auth.json` volume that the rest of the system already uses.

**Tech Stack:** Existing Next.js 14 app, existing Python scraper worker, Docker Compose, Traefik labels on Hostinger, official Playwright container base image, Xvfb, fluxbox, x11vnc, noVNC/websockify, existing Playwright Python dependency.

**Budget:** `{files: 13, LOC/file: <=250 target, deps: 0 new app libraries; 1 new Docker service; browser-side packages x11vnc/novnc/fluxbox/supervisor inside the browser image}`

---

## File Map

- `docker/playwright-remote/Dockerfile` - build the remote-browser image with Chromium desktop tooling and noVNC.
- `docker/playwright-remote/supervisord.conf` - keep Xvfb, fluxbox, x11vnc, noVNC, and Chromium alive in one container.
- `docker/playwright-remote/start-chromium.sh` - launch Chromium with a persistent profile and CDP enabled against LinkedIn login.
- `docker-compose.yml` - add the `linkedin-browser` service, shared volumes, localhost debug ports, and Traefik path routing.
- `workers/scraper/auth.py` - add CDP export helpers and remote-session reset helpers alongside existing auth state logic.
- `workers/scraper/scraper.py` - expose CLI modes for `--sync-remote-session` and `--reset-remote-session`.
- `apps/web/lib/linkedinBrowserControl.ts` - centralize the public noVNC URL, internal CDP URL assumptions, and server-side spawn helpers.
- `apps/web/app/api/login/route.ts` - change login start from “spawn hidden worker browser” to “return remote browser UI URL”.
- `apps/web/app/api/linkedin-auth/remote-session/route.ts` - add `sync` and `reset` actions for the remote browser flow.
- `apps/web/components/RemoteLinkedinBrowser.tsx` - render the embedded noVNC iframe and operator guidance.
- `apps/web/components/LoginLauncher.tsx` - replace the dead-end launch copy with open/sync/reset controls and browser panel state.
- `README.md` - document the new login bootstrap flow and local/live validation commands.
- `agents/testscripts/linkedin-remote-browser-smoke.sh` - local smoke script for the infra and auth export path.

---

### Task 1: Add the remote browser service

**Files:**
- Create: `docker/playwright-remote/Dockerfile`
- Create: `docker/playwright-remote/supervisord.conf`
- Create: `docker/playwright-remote/start-chromium.sh`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Create the browser image Dockerfile**

```dockerfile
FROM mcr.microsoft.com/playwright:v1.57.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    CHROME_USER_DATA_DIR=/data/scraper/interactive-profile \
    LINKEDIN_LOGIN_URL=https://www.linkedin.com/login

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      chromium \
      fluxbox \
      novnc \
      supervisor \
      websockify \
      x11vnc \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY docker/playwright-remote/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY docker/playwright-remote/start-chromium.sh /usr/local/bin/start-chromium.sh
RUN chmod +x /usr/local/bin/start-chromium.sh

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
```

- [ ] **Step 2: Add the supervisor process graph**

```ini
[supervisord]
nodaemon=true

[program:xvfb]
command=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -ac +extension RANDR
autorestart=true
priority=10

[program:fluxbox]
command=/usr/bin/fluxbox
environment=DISPLAY=":99"
autorestart=true
priority=20

[program:x11vnc]
command=/usr/bin/x11vnc -display :99 -forever -shared -nopw -xkb
autorestart=true
priority=30

[program:novnc]
command=/usr/share/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080
autorestart=true
priority=40

[program:chromium]
command=/usr/local/bin/start-chromium.sh
environment=DISPLAY=":99"
autorestart=true
priority=50
```

- [ ] **Step 3: Launch Chromium with a persistent profile and CDP**

```bash
#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${CHROME_USER_DATA_DIR}"

exec chromium-browser \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-features=Translate,AutomationControlled \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --user-data-dir="${CHROME_USER_DATA_DIR}" \
  "${LINKEDIN_LOGIN_URL}"
```

- [ ] **Step 4: Add the service to Compose with shared volumes and Traefik routing**

```yaml
  linkedin-browser:
    restart: unless-stopped
    build:
      context: .
      dockerfile: docker/playwright-remote/Dockerfile
    environment:
      HOME: /data/home
      DISPLAY: ":99"
      CHROME_USER_DATA_DIR: /data/scraper/interactive-profile
      LINKEDIN_LOGIN_URL: https://www.linkedin.com/login
    shm_size: "1gb"
    volumes:
      - scraper_auth:/data/scraper
      - app_home:/data/home
    ports:
      - "127.0.0.1:6080:6080"
      - "127.0.0.1:9222:9222"
    labels:
      traefik.enable: "true"
      traefik.http.routers.linkedin-browser.rule: (Host(`deguraleads.de`) || Host(`www.deguraleads.de`)) && PathPrefix(`/linkedin-browser`)
      traefik.http.routers.linkedin-browser.entrypoints: websecure
      traefik.http.routers.linkedin-browser.tls: "true"
      traefik.http.routers.linkedin-browser.tls.certresolver: letsencrypt
      traefik.http.routers.linkedin-browser.middlewares: linkedin-browser-strip
      traefik.http.middlewares.linkedin-browser-strip.stripprefix.prefixes: /linkedin-browser
      traefik.http.services.linkedin-browser.loadbalancer.server.port: "6080"
```

- [ ] **Step 5: Verify the Compose graph before touching app code**

Run: `docker compose config`
Expected: both `app` and `linkedin-browser` render with no schema errors.

### Task 2: Let the scraper export auth from the live remote browser

**Files:**
- Modify: `workers/scraper/auth.py`
- Modify: `workers/scraper/scraper.py`

- [ ] **Step 1: Add the remote browser connection constants and helpers**

```python
REMOTE_BROWSER_CDP_URL = os.getenv("LINKEDIN_BROWSER_CDP_URL", "http://linkedin-browser:9222")
REMOTE_BROWSER_PROFILE_DIR = AUTH_DIR / "interactive-profile"


async def connect_remote_browser() -> tuple[Playwright, Browser, BrowserContext]:
    playwright = await async_playwright().start()
    browser = await playwright.chromium.connect_over_cdp(REMOTE_BROWSER_CDP_URL)
    context = browser.contexts[0] if browser.contexts else await browser.new_context()
    return playwright, browser, context


async def disconnect_remote_browser(playwright: Playwright) -> None:
    await playwright.stop()
```

- [ ] **Step 2: Add a dedicated export helper that writes `auth.json` from the remote browser**

```python
async def sync_remote_session_to_auth() -> None:
    playwright, browser, context = await connect_remote_browser()
    try:
        if not await is_logged_in(context):
            update_auth_status(
                credentials_saved=True,
                session_state="login_required",
                auth_file_present=AUTH_STATE_PATH.exists(),
                last_login_result="failed",
                last_error="Remote browser is open, but LinkedIn is not logged in yet.",
            )
            raise RuntimeError("Remote LinkedIn browser is not authenticated yet.")

        await save_storage_state(context, path=AUTH_STATE_PATH)
        update_auth_status(
            credentials_saved=True,
            session_state="session_active",
            auth_file_present=True,
            last_verified_at=now_iso_utc(),
            last_login_result="success",
            last_error=None,
        )
    finally:
        await disconnect_remote_browser(playwright)
```

- [ ] **Step 3: Add a reset helper for the interactive profile and exported auth**

```python
def reset_remote_login_state() -> None:
    shutil.rmtree(REMOTE_BROWSER_PROFILE_DIR, ignore_errors=True)
    for target in (AUTH_STATE_PATH, AUTH_STATUS_PATH, AUTH_STATUS_BACKUP_PATH):
        try:
            target.unlink(missing_ok=True)
        except Exception:
            pass
```

- [ ] **Step 4: Add CLI entrypoints to `scraper.py` for sync and reset**

```python
parser.add_argument("--sync-remote-session", action="store_true")
parser.add_argument("--reset-remote-session", action="store_true")

if getattr(args, "sync_remote_session", False):
    asyncio.run(sync_remote_session_mode())
    sys.exit(0)

if getattr(args, "reset_remote_session", False):
    reset_remote_session_mode()
    sys.exit(0)
```

- [ ] **Step 5: Keep login-only mode from pretending it launches a visible browser on Hostinger**

```python
async def login_only_mode() -> None:
    update_auth_status(
        credentials_saved=bool(fetch_linkedin_credentials(get_supabase_client())),
        session_state="login_required",
        auth_file_present=AUTH_STATE_PATH.exists(),
        last_login_attempt_at=now_iso_utc(),
        last_login_result="verification_required",
        last_error="Open the remote LinkedIn browser from Settings, complete login there, then click Capture Session.",
    )
```

- [ ] **Step 6: Verify the worker parses**

Run: `python3 -m py_compile workers/scraper/auth.py workers/scraper/scraper.py`
Expected: no syntax errors.

### Task 3: Add app-side control routes for open, sync, and reset

**Files:**
- Create: `apps/web/lib/linkedinBrowserControl.ts`
- Modify: `apps/web/app/api/login/route.ts`
- Create: `apps/web/app/api/linkedin-auth/remote-session/route.ts`

- [ ] **Step 1: Add a single helper module for the browser URLs and worker commands**

```ts
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export const getRemoteBrowserUrl = () =>
  process.env.NEXT_PUBLIC_LINKEDIN_REMOTE_BROWSER_URL?.trim() ||
  "/linkedin-browser/vnc.html?autoconnect=1&resize=remote";

export const spawnScraperCommand = (args: string[], correlationId: string) => {
  const scraperCodeDir = path.resolve(process.cwd(), "..", "..", "workers", "scraper");
  const pythonCmd = fs.existsSync(path.join(scraperCodeDir, "venv", "bin", "python"))
    ? path.join(scraperCodeDir, "venv", "bin", "python")
    : "python3";
  return spawn(pythonCmd, [path.join(scraperCodeDir, "scraper.py"), ...args], {
    cwd: scraperCodeDir,
    env: { ...process.env, CORRELATION_ID: correlationId },
  });
};
```

- [ ] **Step 2: Change `/api/login` to return the browser URL instead of spawning a hidden browser**

```ts
return NextResponse.json({
  ok: true,
  browserUrl: getRemoteBrowserUrl(),
  message: "Open the remote LinkedIn browser, complete login there, then click Capture Session.",
});
```

- [ ] **Step 3: Add a route for `sync` and `reset`**

```ts
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = body?.action === "reset" ? "reset" : "sync";
  const child = spawnScraperCommand(
    action === "reset" ? ["--reset-remote-session"] : ["--sync-remote-session"],
    correlationId,
  );

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    return NextResponse.json({ ok: false, error: `Remote session ${action} failed.` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, action });
}
```

- [ ] **Step 4: Verify the web app still builds**

Run: `npm run build:web`
Expected: `Compiled successfully` and the new route files type-check.

### Task 4: Replace the dead-end login UI with an embedded remote browser

**Files:**
- Create: `apps/web/components/RemoteLinkedinBrowser.tsx`
- Modify: `apps/web/components/LoginLauncher.tsx`
- Modify: `apps/web/components/StartLoginButton.tsx`

- [ ] **Step 1: Add a focused remote browser iframe component**

```tsx
type Props = {
  browserUrl: string;
  visible: boolean;
};

export function RemoteLinkedinBrowser({ browserUrl, visible }: Props) {
  if (!visible) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="pill">LinkedIn Browser</div>
      <div className="muted" style={{ marginBottom: 12 }}>
        Log in inside this remote browser. When LinkedIn reaches the feed, return here and click Capture Session.
      </div>
      <iframe
        src={browserUrl}
        title="Remote LinkedIn Browser"
        style={{ width: "100%", minHeight: 720, border: "2px solid var(--line)", background: "#111" }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Change the start button to fetch the browser URL and reveal the iframe**

```tsx
type Props = {
  label?: string;
  onReady: (browserUrl: string) => void;
};

const data = await res.json();
onReady(data.browserUrl);
setMsg(data.message || "Remote LinkedIn browser ready.");
```

- [ ] **Step 3: Add explicit `Capture Session` and `Reset Browser` controls in `LoginLauncher.tsx`**

```tsx
const syncRemoteSession = async (action: "sync" | "reset") => {
  const res = await fetch("/api/linkedin-auth/remote-session", {
    method: "POST",
    headers: { "content-type": "application/json", ...getOperatorApiHeaders() },
    body: JSON.stringify({ action }),
  });
  const data = await res.json();
  if (!res.ok || data?.ok === false) throw new Error(data?.error || "Remote session action failed.");
  window.location.reload();
};
```

- [ ] **Step 4: Replace the current helper text with the actual operator sequence**

```tsx
<div className="muted">
  1. Save credentials.
  2. Open the remote LinkedIn browser.
  3. Complete LinkedIn login in the embedded window.
  4. Click Capture Session.
</div>
```

- [ ] **Step 5: Verify the settings UI compiles and lint passes on touched files**

Run: `npm run lint:web`
Expected: no new lint errors from `LoginLauncher`, `StartLoginButton`, or `RemoteLinkedinBrowser`.

### Task 5: Add local smoke coverage and operator docs

**Files:**
- Create: `agents/testscripts/linkedin-remote-browser-smoke.sh`
- Modify: `README.md`

- [ ] **Step 1: Add a local smoke script that validates the new infra before any manual login**

```bash
#!/usr/bin/env bash
set -euo pipefail

docker compose build app linkedin-browser
docker compose up -d app linkedin-browser
curl -fsS http://127.0.0.1:3000/api/health >/dev/null
curl -fsSI http://127.0.0.1:6080/vnc.html >/dev/null
curl -fsS http://127.0.0.1:9222/json/version >/dev/null
echo "Remote browser infra is reachable. Complete manual LinkedIn login through http://127.0.0.1:6080/vnc.html"
```

- [ ] **Step 2: Document the new bootstrap flow in the README**

```md
### Remote LinkedIn Login

1. Open `/settings`.
2. Click `Open LinkedIn Browser`.
3. Log into LinkedIn in the embedded remote browser.
4. Click `Capture Session`.
5. Wait for `SESSION ACTIVE` before starting enrichment or connect-only runs.
```

- [ ] **Step 3: Verify the smoke script is executable and the README still reads cleanly**

Run: `chmod +x agents/testscripts/linkedin-remote-browser-smoke.sh && sed -n '1,120p' README.md`
Expected: script is executable and README includes the remote login section.

### Task 6: Deploy and perform live validation on Hostinger

**Files:**
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Test: `agents/testscripts/linkedin-remote-browser-smoke.sh`

- [ ] **Step 1: Validate the stack locally before shipping**

Run: `docker compose up -d --build app linkedin-browser`
Expected: both services become healthy or steady-running, `http://127.0.0.1:6080/vnc.html` loads, and `curl http://127.0.0.1:9222/json/version` returns Chromium metadata.

- [ ] **Step 2: Deploy with a full repo-backed rebuild on Hostinger**

Run:

```bash
git add docker-compose.yml docker/playwright-remote apps/web workers/scraper README.md agents/testscripts
git commit -m "feat: add self-hosted LinkedIn remote browser login"
git push origin main
git push deploy main:master
```

Expected: both remotes contain the browser-service commit. If Hostinger still serves a stale image after `updateProject`, replace the project with a fresh repo-backed build instead of trusting a restart-only deploy.

- [ ] **Step 3: Verify the live remote browser path**

Run: `curl -I https://deguraleads.de/linkedin-browser/vnc.html`
Expected: HTTP `200` or a redirect to the VNC viewer, not `404`.

- [ ] **Step 4: Perform the live operator flow**

Run:

```text
1. Sign into https://deguraleads.de/settings
2. Save the operator API token
3. Click Open LinkedIn Browser
4. Complete LinkedIn login inside the embedded noVNC browser
5. Click Capture Session
6. Reload Settings
```

Expected: the page shows `SESSION ACTIVE`, `Cached session file: Present`, and `Last login result: success`.

- [ ] **Step 5: Prove the scraper can now use the exported session**

Run:

```text
1. Start a connect-only run for exactly 1 lead
2. Watch Hostinger container logs for the scraper child
3. Reload /api/enrich/status
```

Expected: no auth error, no “login window closed without saving a session”, and at least one lead advances out of `NEW`/`PROCESSING`.

- [ ] **Step 6: Capture rollback and recovery notes**

```md
Rollback:
- disable the `linkedin-browser` service in `docker-compose.yml`
- revert the settings UI to the old card
- remove `/api/linkedin-auth/remote-session`

Recovery:
- if noVNC loads but LinkedIn is stale, click Reset Browser
- if auth export fails, inspect `/api/linkedin-auth/remote-session` response and `auth_status.json`
- if Hostinger restarts the old image, force a repo-backed rebuild instead of restart-only deploy
```

## Self-Review

- Spec coverage: this plan covers the browser service, shared auth export path, settings UI, local smoke verification, Hostinger deploy, and live end-to-end validation.
- Placeholder scan: no `TODO`/`TBD` markers remain; each task includes concrete files, commands, and code.
- Type consistency: the plan uses one vocabulary throughout: `linkedin-browser`, remote browser, `sync-remote-session`, `reset-remote-session`, `auth.json`, and `SESSION ACTIVE`.

Plan complete and saved to `docs/superpowers/plans/2026-04-18-self-hosted-playwright-login.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
