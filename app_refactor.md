# App Refactor — LinkedIn Outreach

Working document. Captures the user-journey misalignment found during the 2026-04-24 UI audit and the prioritized fix list. Companion to `AGENTS.md` and `CLAUDE.md` — those remain authoritative for engineering rules.

---

## 1. Intended Operator Journey

The operator should follow this sequence end-to-end:

0. **Auth** — connect LinkedIn credentials + capture a live session.
1. **Upload** — import a CSV of leads (and pick the batch's intent).
2. **Sequence** — build the message sequence that this batch will use.
3. **Send** — start the invite run (with or without a first message), then approve and send the post-acceptance messages.
4. **Follow-ups / Inbox** — review replies, send approved follow-ups.
5. **Analytics** — measure performance.

Step 0 is currently invisible in the journey (Settings is the last nav item). Steps 2 and 3 share UI surfaces in confusing ways.

## 2. Current State vs Intended Journey

| Step | Intended | Current | Gap |
|---|---|---|---|
| 0. Auth | First-class onboarding step | Buried at end of nav (`/settings`) | Operator can run the full journey before discovering the worker can't log in |
| 1. Upload | Land here first | `/upload` is 3rd nav item | Order contradicts the journey |
| 2. Sequence | Dedicated destination | `SequenceEditor` lives *inside* `/` (Mission Control) under a "POST-ACCEPTANCE" heading | No `/sequences` route; new operator can't find where to build one |
| 3. Send invite + initial message | One concept driven by the sequence | Initial invite note is a **separate** template path tied to `connect_message` batch intent — *not* the sequence's `first_message` | "Sequence" means two different things; biggest source of confusion |
| 4. Follow-ups | Manually approved per message | 3 manually-approved messages (`first_message`, `second_message`, `third_message`) gated by the `/followups` review queue | Architecturally fine; just labeled and routed inconsistently |
| 5. Analytics | Read-only | `/analytics` | Aligned |

### Sequence semantics (clarified)

A sequence today is `{ name, first_message, second_message, third_message, followup_interval_days }`. None of these messages are auto-sent — every one passes through the `/followups` review queue and requires operator approval. **Because the workflow is already manual end-to-end, there's no architectural reason the invite note shouldn't also live inside the sequence.**

## 3. Recommended Direction — Path 2 (Unify)

Promote "sequence" to mean the whole operator-facing message plan:

```
sequence = {
  name,
  invite_note,           // sent WITH the connection request (or null for connect-only batches)
  followup_messages: [   // sent AFTER acceptance, each manually approved in /followups
    { body, interval_days_after_previous },
    ...
  ]
}
```

Implications:
- The "Connect + Message" vs "Connect Only" batch intent collapses into a sequence property: `invite_note` present = connect-with-note, absent = connect-only.
- "POST-ACCEPTANCE" stops being a separate concept on `/`; it's just "the followups portion of the sequence."
- The `/followups` review queue stays exactly as it is — it's already the right surface for manual approval.

Rejected alternative — **Path 1 (Keep architecture, fix labels)**: cheaper, no DB/worker changes, but leaves the "two kinds of sequence" trap in place. Documented for completeness; not recommended.

## 4. Proposed Information Architecture

**New nav order** (matches journey):

```
Onboarding   →   Upload   →   Sequences   →   Leads   →   Follow-ups   →   Analytics
```

- **Onboarding** (renamed from Settings): LinkedIn auth, operator token, credentials. Becomes a first-run gate when auth is missing.
- **Upload**: CSV import. Batch intent picker becomes a *sequence* picker ("Run this batch with sequence X").
- **Sequences** (new top-level route): Dedicated destination for `SequenceEditor`. Move it out of `/`.
- **Leads**: The state-machine dashboard + the "RUN WHAT'S NEXT" action stack (current `/leads` page, mostly unchanged).
- **Follow-ups**: Inbox scan + approval queue (current `/followups`).
- **Analytics**: Unchanged.
- **Mission Control (`/`)**: Repurpose as a **lifecycle overview** — counts at each stage of NEW → ENRICHED → INVITED → ACCEPTED → DRAFTED → APPROVED → SENT → REPLIED, with the primary action at each stage. Replaces the current "POST-ACCEPTANCE" framing.

## 5. Prioritized Fix List (from 2026-04-24 audit)

Score: **15/20** (Good — address weak dimensions). Anti-pattern verdict: PASS (no AI slop tells; brutalist commitment is intact).

### P0 — Blocking
- **Fix undefined CSS token `--line` in `WorkerControlPanel.tsx:164`** → invisible borders. Replace with `var(--border-color)`.

### P1 — Major
- **Restructure `/` from "POST-ACCEPTANCE" to lifecycle overview.** Move `SequenceEditor` to a new `/sequences` route. (Also see §4.)
- **Disambiguate "CONNECT + MESSAGE"** — currently means three different things across CSVUploader, StartEnrichmentButton, and Leads action stack. Pick one verb per surface.
- **Move sequence + batch→sequence assignment out of `localStorage`** (`LeadList.tsx:63-66`) into Supabase. Critical for 2-5 operator team — current state silently diverges between browsers.
- **Consolidate three Worker Control Panels** (`/`, `/leads`, `/followups`) into one global status surface. Today there's no single "stop everything."
- **Fix red-error-text contrast** (`#ff0000` on white = 4.0:1, fails WCAG AA). Use the dashed-black-border pattern already used by `.status-rejected`. Affects `StartEnrichmentButton.tsx:322`, `LinkedinCredentialsForm.tsx:68`, `WorkerControlPanel.tsx:182`, `LoginLauncher.tsx:228`, `globals.css:730`.
- **Remove redundant CTA pairs on `/`** (`app/page.tsx:27-46`) — same destination linked twice as button + muted text link.
- **Collapse 16-status taxonomy to 6 lifecycle stages** in the UI layer. Keep DB statuses unchanged; only map at the chip level. Show DB status in tooltip for power users.

### P2 — Minor
- Drop pill-above-H1 chrome from every page (`/`, `/leads`, `/upload`, `/settings`, `/analytics`). Restates page concept the nav already shows.
- Replace hard-coded `#000` (`StartEnrichmentButton.tsx:336`) and `rgba(255,0,0,0.04)` (`StartEnrichmentButton.tsx:368`) with tokens.
- When Supabase realtime channel is connected, drop polling from 5s to 60s heartbeat (`LeadList.tsx`, `StartEnrichmentButton.tsx`).
- Extract repeated inline styles (`{display:'flex',gap:12,flexWrap:'wrap'}`, `{display:'grid',gap:8}`, etc.) into utility classes (`.row`, `.row--wrap`, `.stack`).
- Bump table sort buttons to 44px touch targets (`LeadList.tsx:301-312`).
- Simplify `LoginLauncher.tsx:133-242` — collapse the diagnostic wall into an expandable disclosure; surface one primary verb at top.

### P3 — Polish
- Disable CSV drop zone (visual + `aria-disabled`) until batch intent is selected.
- Bump `--muted` from `#666` to `#555` (5.74:1 → 6.66:1) and lift `.brand-tagline` to 11px.
- Add an H1 to `/followups` (or remove H1 from every page — see P2 chrome cleanup).
- Final `/polish` pass.

## 6. Suggested Phasing

Each phase is independently shippable. Locality budgets per AGENTS.md §0 should be set per Plan when the phase is picked up.

**Phase 1 — Bug fix + token hygiene (1 day)**
P0 + the two hard-coded-color P2s. No journey change. Pure cleanup.

**Phase 2 — IA reorder, no schema change (2-3 days)**
Reorder nav, promote `SequenceEditor` to `/sequences`, rename Settings → Onboarding, drop pill chrome, remove redundant CTAs on `/`, fix red-error contrast. Still uses today's split sequence/intent model — Path 1 of the original recommendation, deployed as a stepping stone.

**Phase 3 — Sequence unification (Path 2, schema change)**
Migrate sequences to include `invite_note` + `followup_messages[]`. Collapse batch intent into a sequence property. Migrate workers (`scraper_outreach`, `sender_outreach`, `sender_followup`) to read from the unified sequence. Move localStorage assignments to Supabase. This is the biggest piece of work and the one that makes the operator's mental model match the system.

**Phase 4 — Lifecycle dashboard on `/`**
Replace POST-ACCEPTANCE framing with NEW → ENRICHED → INVITED → ACCEPTED → DRAFTED → APPROVED → SENT → REPLIED, counts + primary action per stage. Status taxonomy collapse (P1) ships here.

**Phase 5 — Global Worker Control surface**
Single status bar / `/system` page. Remove the three per-page panels.

**Phase 6 — Polish**
Touch targets, muted contrast, drop-zone disabled state, `/polish` final pass. Re-run `/audit` — target 18+/20.
