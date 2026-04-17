# Hostinger Single-VPS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the entire LinkedinOutreach stack on one Hostinger VPS with Docker Compose, expose the Mission Control web app publicly first, and add Supabase-authenticated route gating afterward.

**Architecture:** Keep the current app shape intact: one Next.js web app, one MCP draft agent, and two Playwright workers. Do not split the workers into separate containers yet, because the web server actions currently spawn local Python processes by path and rely on a shared filesystem, local auth state, and Chromium availability. Use one production app container that contains Node, Python, Playwright, the repo, and the worker venvs; put a small reverse-proxy container in front of it for HTTP/HTTPS. Later, add Supabase session gating for the UI and preserve the existing token-based operator API guard for internal triggers.

**Tech Stack:** Docker Compose, a single app container with Node + Python + Playwright/Chromium, one reverse proxy container, Next.js 14, existing Python workers, Supabase Auth, no new app runtime dependencies.

**Scope snapshot**
- Files: 8-10 create/modify files for phase 1, 4-6 more for the auth gateway phase
- LOC/file: ~40-260 per file
- Deps: 0 new npm/pip runtime deps; Docker base images only

---

### Task 1: Lock the production runtime shape into a single app container

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `scripts/container-entrypoint.sh`
- Modify: `package.json`
- Modify: `run_all.sh`

- [ ] **Step 1: Define the app image around the existing spawn semantics**

Build one image that contains:
- Node.js for Next.js production start
- Python 3.10+ for `mcp-server`, `workers/scraper`, and `workers/sender`
- Playwright Chromium plus system libraries
- The repo at a stable path such as `/app`

The point of the image is not to make the workers containerized in isolation; it is to keep the current local-child-process behavior working unchanged inside one host namespace.

- [ ] **Step 2: Add a production entrypoint that starts the same process bundle the repo already expects**

The entrypoint should:
- load env vars from the container environment
- ensure the worker auth files exist on mounted volumes
- start the long-lived worker loops
- start the web app in production mode, not `next dev`

The shell wrapper should keep one log stream per process so Hostinger debugging does not depend on `docker exec`.

- [ ] **Step 3: Add root scripts for production launch**

Add a root script for production web startup so the launcher can switch between dev and prod cleanly:
```json
{
  "scripts": {
    "start:web": "npm --prefix apps/web run start",
    "build:web": "npm --prefix apps/web run build"
  }
}
```

Then change `run_all.sh` so production mode can use `npm run start:web` while local development still uses `npm run dev:web`.

- [ ] **Step 4: Exclude runtime noise from the image**

The ignore file must exclude:
- `.git`
- `.next`
- `node_modules`
- Python virtualenvs
- `.logs`
- browser auth artifacts that are created at runtime

That keeps the image small and avoids copying stale local state into the VPS deployment.

- [ ] **Step 5: Verify the image actually builds**

Run:
```bash
docker build -t linkedin-outreach:hostinger .
```

Expected:
- build completes without missing-Python, missing-Node, or missing-Chromium errors
- the image contains the repo and the production entrypoint

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore scripts/container-entrypoint.sh package.json run_all.sh
git commit -m "feat: hostinger runtime image"
```

### Task 2: Add the compose stack and public reverse proxy

**Files:**
- Create: `docker-compose.yml`
- Create: `docker/Caddyfile`
- Create: `apps/web/app/api/health/route.ts`

- [ ] **Step 1: Define the compose boundary**

Use two services only:
- `app` for the monorepo runtime, worker loops, and Next.js
- `proxy` for public traffic on `80` and `443`

Do not create separate scraper/sender/agent containers yet. That would break the current spawn model and force a queue or RPC layer before the deployment itself is stable.

- [ ] **Step 2: Mount the state that must survive restarts**

Compose volumes should preserve:
- LinkedIn auth state for scraper and sender
- any browser profile/cache data the workers need
- logs for postmortem analysis

The app container should be able to restart without losing authenticated browser sessions.

- [ ] **Step 3: Add a health endpoint for orchestration**

Create a lightweight readiness route that returns 200 when the web app is alive:
```ts
export async function GET() {
  return Response.json({ ok: true, service: "web", ts: new Date().toISOString() });
}
```

That gives the proxy and host operator a stable probe instead of guessing from page HTML.

- [ ] **Step 4: Wire the proxy to the app container**

The proxy should forward external traffic to the internal Next.js port only.
- public: `80` / `443`
- internal app: `3000`
- internal worker ports: none

That keeps the workers unreachable from the internet while still letting the UI be public.

- [ ] **Step 5: Verify the compose graph before Hostinger ever sees it**

Run:
```bash
docker compose config
```

Expected:
- no unresolved variables
- one app service
- one proxy service
- health route available on the app service

Then run:
```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/api/health
```

Expected:
- the app responds with a JSON health payload
- the proxy container can reach the app container through the compose network

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml docker/proxy.conf apps/web/app/api/health/route.ts
git commit -m "feat: compose proxy for hostinger"
```

### Task 3: Switch the launcher to production mode without breaking local development

**Files:**
- Modify: `run_all.sh`
- Modify: `package.json`

- [ ] **Step 1: Add a production web command path**

Teach `run_all.sh` to choose the production web command when an explicit env flag is present:
```bash
if [ "${WEB_RUNTIME:-dev}" = "prod" ]; then
  WEB_CMD="npm run start:web"
else
  WEB_CMD="npm run dev:web"
fi
```

That is the minimum change needed so the same launcher can support both local development and the Hostinger VPS.

- [ ] **Step 2: Keep the worker loops in the same process namespace as the web app**

Do not move the worker logic behind HTTP calls yet. The current server actions and API routes spawn local scripts by file path, so they must continue to see:
- `mcp-server/run_agent.py`
- `workers/scraper/scraper.py`
- `workers/sender/sender.py`

If those scripts stop being local, the deployment stops matching the codebase.

- [ ] **Step 3: Verify production startup logs**

Run:
```bash
WEB_RUNTIME=prod ./run_all.sh --web --agent --sender --message-only --followup
```

Expected:
- the web process starts with `next start`
- the sender and agent loops start
- no process tries to use `next dev` in the deployment path

- [ ] **Step 4: Verify the worker spawn paths still resolve**

Trigger one web action that spawns a worker and confirm the log line references the repo-local Python path rather than a missing container-only path.

Expected:
- the web app spawns the same local worker script it spawns today
- no cross-container RPC was introduced accidentally

- [ ] **Step 5: Commit**

```bash
git add run_all.sh package.json
git commit -m "feat: prod launcher for hostinger"
```

### Task 4: Prepare the public launch runbook and operational guardrails

**Files:**
- Modify: `README.md`
- Modify: `SUPABASE_SETUP.md`
- Modify: `SECURITY.md`

- [ ] **Step 1: Document the Hostinger VPS assumptions**

The runbook should state the minimum practical environment for the single-VPS deployment:
- enough RAM for Next.js + Python + Chromium at the same time
- persistent disk for auth state and logs
- open ports only for the reverse proxy

This matters because Playwright on a tiny VPS is the first place the deployment will fail.

- [ ] **Step 2: Document the production launch commands**

Add the exact commands for:
- build
- start
- logs
- restart
- rollback

Keep the commands copy-pasteable and bound to the same compose project name that the Hostinger box will use.

- [ ] **Step 3: Document the public-first rollout and the later auth gate**

The README should explain:
- phase 1: public Mission Control, protected internal operator endpoints
- phase 2: Supabase login for UI routes and gateway checks
- phase 3: optional tightening of worker-trigger endpoints if needed

Do not describe the future login as already deployed. Keep the distinction explicit.

- [ ] **Step 4: Verify the docs reference the same service names and ports as the compose file**

Run:
```bash
rg -n "docker compose|Hostinger|3000|80|443|WEB_RUNTIME|api/health" README.md SUPABASE_SETUP.md SECURITY.md docker-compose.yml run_all.sh
```

Expected:
- the docs and the compose file use the same terms
- no stale local-only instructions remain in the deployment path

- [ ] **Step 5: Commit**

```bash
git add README.md SUPABASE_SETUP.md SECURITY.md
git commit -m "docs: hostinger deployment runbook"
```

### Task 5: Add the Supabase login gateway after the public launch is stable

**Files:**
- Create: `apps/web/lib/auth.ts`
- Create: `apps/web/middleware.ts`
- Create: `apps/web/app/login/page.tsx`
- Modify: `apps/web/lib/apiGuard.ts`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/layout.tsx`

- [ ] **Step 1: Define the protected route boundary**

Protect the Mission Control pages that a browser user should not see unauthenticated:
- `/`
- `/leads`
- `/upload`
- any followup or sequence management route that exposes operator actions

Leave the internal operator API guard in place for the worker-trigger routes so the server-side protection story does not regress.

- [ ] **Step 2: Add a Supabase-backed session helper**

Create a small auth helper that reads the current user session from cookies and exposes a boolean like `isAuthenticated`. The helper should stay narrow: no business logic, no page routing, just session inspection.

- [ ] **Step 3: Add middleware redirects for unauthenticated users**

Unauthenticated requests to protected routes should redirect to `/login`.
Authenticated users should reach the current app unchanged.

That gives the deployment a real gateway without rewriting the worker stack.

- [ ] **Step 4: Add a login page and logout affordance**

The login page should use the existing Supabase client setup and should not introduce a second auth provider.
The page should clearly explain that the user is entering the operator dashboard, not creating a LinkedIn account.

- [ ] **Step 5: Preserve the existing operator API token fallback**

Update `requireOperatorAccess` so it keeps working for internal requests and token-based automation while the UI moves to Supabase sessions.

That avoids coupling the browser login rollout to the worker-trigger surface.

- [ ] **Step 6: Verify the auth gate in the browser**

Run the app locally or in the VPS container and confirm:
- unauthenticated `/` redirects to `/login`
- authenticated access reaches Mission Control
- operator API requests still reject missing/invalid tokens

Expected:
- public launch behavior changes only when the auth gateway is intentionally enabled

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/auth.ts apps/web/middleware.ts apps/web/app/login/page.tsx apps/web/lib/apiGuard.ts apps/web/app/page.tsx apps/web/app/layout.tsx
git commit -m "feat: supabase auth gateway"
```

### Task 6: Final deployment validation on the Hostinger VPS

**Files:**
- No new code expected
- Test: `docker-compose.yml`, runtime logs, browser access, and Supabase connectivity

- [ ] **Step 1: Provision the VPS and deploy the compose stack**

On the Hostinger box:
```bash
cd /opt/LinkedinOutreach
git pull --ff-only
docker compose up -d --build
```

Expected:
- the app container starts
- the proxy container starts
- the health route returns 200

- [ ] **Step 2: Confirm the public website responds**

Run:
```bash
curl -I http://127.0.0.1/
```

Expected:
- 200 or a redirect to HTTPS depending on the proxy config
- no worker ports are exposed publicly

- [ ] **Step 3: Confirm the worker loops are alive**

Run:
```bash
docker compose logs --tail=200 app
```

Expected:
- web, agent, sender, message-only, and followup logs appear
- no Chromium or Python dependency errors appear at startup

- [ ] **Step 4: Confirm the browser flow still triggers local worker scripts**

From the public UI, trigger one action that launches a worker.

Expected:
- the worker starts inside the same container namespace
- no queue service or cross-service RPC is required

- [ ] **Step 5: Record the rollback point**

Take a Hostinger snapshot or equivalent VPS backup before the first public traffic cutover, then document the snapshot name in the deploy notes.
