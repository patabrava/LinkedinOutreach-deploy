# Degura Performance Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a German client-facing Degura performance report at `report.deguraleads.de`.

**Architecture:** Add one frozen report-data helper, one public Next.js report route, report-specific CSS on top of the existing app style tokens, a middleware host rewrite for the report subdomain, and a Traefik host rule for Hostinger. The first deployment uses a frozen verified snapshot so the public page does not query Supabase or expose raw lead data.

**Tech Stack:** Next.js 14 App Router, React Server Components, existing global CSS, Docker Compose with Traefik labels, Hostinger VPS project tools, no new dependencies.

---

## File Map

- Create `apps/web/lib/deguraPerformanceReport.ts`: typed frozen report contract, KPIs, funnel, response clusters, positive-signal examples, copy learnings, volume model, and next actions.
- Create `apps/web/app/reports/degura-performance/page.tsx`: public report page rendering the snapshot with existing app visual language.
- Modify `apps/web/app/globals.css`: add scoped `.report-*` classes that reuse existing tokens.
- Modify `apps/web/middleware.ts`: rewrite `report.deguraleads.de/` to `/reports/degura-performance` before auth checks.
- Modify `apps/web/components/NavBar.tsx`: suppress internal navigation/sign-in chrome on public report routes.
- Modify `docker-compose.yml`: add `report.deguraleads.de` to the app router host rule.
- Create `apps/web/lib/deguraPerformanceReport.test.ts`: contract/privacy test for the frozen report helper.

## Task 1: Report Contract

**Files:**
- Create: `apps/web/lib/deguraPerformanceReport.ts`
- Test: `apps/web/lib/deguraPerformanceReport.test.ts`

- [ ] **Step 1: Create the frozen report helper**

Implement a typed export with no raw lead IDs, full names, LinkedIn URLs, or full reply dumps.

- [ ] **Step 2: Create the privacy/contract test**

Test that all required report sections exist and that serialized report content does not include raw identifier patterns.

- [ ] **Step 3: Run the focused test**

Run: `cd apps/web && npx --yes tsx --test lib/deguraPerformanceReport.test.ts`

Expected: PASS.

## Task 2: Public Report Route

**Files:**
- Create: `apps/web/app/reports/degura-performance/page.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/components/NavBar.tsx`

- [ ] **Step 1: Render the page**

Use `getDeguraPerformanceReport()` and render hero, KPI strip, funnel, response clusters, examples, copy learnings, volume model, next plan, and methodology.

- [ ] **Step 2: Add scoped report CSS**

Add `.report-page`, `.report-hero`, `.report-kpi-grid`, `.report-section`, `.report-cluster-grid`, `.report-volume-grid`, and related classes using existing CSS tokens.

- [ ] **Step 3: Hide internal chrome on report routes**

In `NavBar`, return `null` when `pathname.startsWith("/reports/")`.

## Task 3: Report Host Routing

**Files:**
- Modify: `apps/web/middleware.ts`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add middleware rewrite**

If host is `report.deguraleads.de` and path is `/`, rewrite to `/reports/degura-performance` before protected-route checks.

- [ ] **Step 2: Add Traefik host rule**

Include `Host(\`report.deguraleads.de\`)` on the app router rule in `docker-compose.yml`.

## Task 4: Verification

**Files:**
- Existing app files only.

- [ ] **Step 1: Run tests**

Run: `cd apps/web && npx --yes tsx --test lib/deguraPerformanceReport.test.ts`

Expected: PASS.

- [ ] **Step 2: Run build**

Run: `npm run build:web`

Expected: exit 0. Baseline warnings are acceptable if unrelated to report files.

- [ ] **Step 3: Run local app**

Run: `./run_all.sh --web`

Expected: web server responds on port 3000.

- [ ] **Step 4: Browser verify**

Open `http://127.0.0.1:3000/reports/degura-performance` and confirm hero, KPIs, clusters, volume CTA, and mobile layout are usable.

## Task 5: Deploy

**Files:**
- Repo-backed deployment from current branch/commit.

- [ ] **Step 1: Commit report implementation**

Stage only report-related files and commit.

- [ ] **Step 2: Push branch**

Push the current branch so the Hostinger build context can fetch the implementation.

- [ ] **Step 3: Inspect Hostinger project**

Use Hostinger MCP project tools to find the active VPS/project.

- [ ] **Step 4: Deploy**

Update or recreate the Hostinger Docker Compose project from the repo-backed context, preserving env and volumes.

- [ ] **Step 5: Live verify**

Verify:

```bash
curl -fsSI https://report.deguraleads.de
curl -fsS https://report.deguraleads.de | rg "DEGURA OUTREACH PERFORMANCE|Volumen kontrolliert"
```

Expected: HTTP 200 and report content visible.
