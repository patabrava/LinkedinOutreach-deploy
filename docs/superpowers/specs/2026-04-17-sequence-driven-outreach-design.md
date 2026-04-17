# Sequence-Driven Outreach — Design

**Date:** 2026-04-17
**Status:** Draft, pending user review
**Scope:** Replace the AI-drafted `connect+message` flow with a sequence-templated, operator-triggered, fully automated pipeline. Decouple enrichment from send so connect requests fire without waiting on scrape.

---

## 1. Problem

Today's `connect+message` flow generates a bespoke AI draft per lead (`run_agent.py` → `drafts` table) and tries to fit opener + body + CTA into LinkedIn's 300-char connect-note limit. This is structurally wrong:

- 300 chars cannot hold a real pitch. Fighting the limit produces either truncated drafts or messages that drop the CTA.
- AI generation runs *before* send, so connect requests wait on scraper enrichment → slow time-to-first-touch.
- The UI carries an approval queue (`DraftFeed` + `mission_control` variant) reviewing messages the operator effectively already approved when they authored the sequence.
- `connect-only` uses `outreach_sequences` as the text source; `connect+message` does not. Two text pipelines, one product.

## 2. Goal

One text pipeline (sequences), two physical messages per lead (connect note + post-acceptance DM), fully automated after a single operator trigger on the leads page. Enrichment runs on its own clock and feeds later steps without gating the first send.

## 3. Non-goals

- Rewriting enrichment internals. Scraper keeps its current scraping behavior; only its invocation and coupling change.
- Replacing the followup system (reply / nudge classification stays as-is).
- Migrating historical `drafts` rows. New flow stops writing to `drafts` for sequence-driven leads; old rows remain for audit.

## 4. Model

### 4.1 Sequence structure

A sequence becomes the complete outreach spec:

```
SEQUENCE
├─ Step 0: Connect note            [≤ 300 chars, optional]
├─ Step 1: First DM                [post-acceptance, no hard cap]
├─ Step 2: Nudge                   [scheduled offset from step 1]
└─ Step 3: Nudge                   [scheduled offset from step 1]
```

Step 0 is new. When non-empty, it rides with the invite (`connect+message` behavior). When empty, this is today's `connect-only` behavior. Mode collapses to "is step 0 non-empty?"

### 4.2 Slots

Templates use `{slot}` syntax. Two tiers:

- **CSV slots** (available at import time, no scraping needed): `{first_name}`, `{last_name}`, `{company}`, `{role}`, `{linkedin_url}`.
- **Enriched slots** (available after scraper runs): `{about_excerpt}`, `{recent_post_hook}`, `{headline}`.

Step 0 MUST only reference CSV slots so it can send without waiting on enrichment. This is enforced at sequence save time (see §6.2). Step 1+ may reference either tier.

Missing slot values render as pre-declared fallbacks (e.g. `{first_name}` → `"there"` if null). Fallbacks are sequence-level, not per-lead.

### 4.3 State machine (per lead)

```
NEW
 └─ operator clicks RUN ENRICHMENT on leads page
     ├─> QUEUED_CONNECT      (step 0 queued for send; render uses CSV slots)
     └─> enrichment worker picks up in parallel

QUEUED_CONNECT
 └─ sender.py sends connect (+ note if step 0 non-empty)
     └─> CONNECT_SENT

CONNECT_SENT
 └─ sender.py --message-only detects acceptance
     └─> enrichment done? yes → render step 1, send → SENT
                          no  → wait up to N retries, then send with fallbacks → SENT

SENT
 └─ schedule step 2, step 3 (nudges) as today
 └─ inbox scan / reply handling as today
```

`DRAFT_READY`, `APPROVED`, `MESSAGE_ONLY_READY`, `MESSAGE_ONLY_APPROVED` become dead statuses for the sequence-driven path. They remain in the schema for legacy rows; no new rows are written in those states.

### 4.4 Enrichment fully relocated — not part of the send path

Enrichment is removed from the friend-request pipeline entirely. The send path never calls the scraper. The existing `RUN ENRICHMENT` button on the leads page is repurposed into **`SEND INVITES`** — it only renders step 0 from CSV slots and queues connect sends via `sender.py`. No scraper invocation.

Enrichment becomes its own independent loop:

- **New worker loop:** `run_all.sh` gains `--enrichment` that runs `scraper.py --mode enrich` on a polling cadence (default 10 min idle between batches). Worker selects leads with `enrichment_ready=false` regardless of lead status — it doesn't care about the send state.
- **Worker contract:** read `leads` WHERE `enrichment_ready=false` AND `linkedin_url IS NOT NULL` → scrape → write `profile` / `activity` → set `enrichment_ready=true`. That's its entire interface with the rest of the system.
- **Separate UI surface:** the leads page gets a small `ENRICHMENT STATUS` card showing last-run time, queue depth, worker state. Not a trigger — monitor only. (If an on-demand trigger is desired later, it can be added without coupling back to send.)
- **No synchronous invocation from web actions.** `/api/enrich` endpoints either redirect to send (for the button) or return status only. The scraper is never spawned in response to a user clicking an outreach button.

This cleanly separates two concerns:

| Concern | Lives in | Trigger |
|---|---|---|
| Sending invites / post-acceptance messages | `sender.py`, web actions | Operator clicks `SEND INVITES`, or acceptance detected |
| Enriching lead data | `scraper.py`, background loop | Independent schedule, no human in the loop |

`sender.py --message-only` consults `leads.enrichment_ready` before rendering step 1. If false after M retries (§6.4), step 1 renders with slot fallbacks and sends.

**Future path (out of scope for this spec, preserved by the interface):** enrichment can later be lifted into a separate repo or service. The web app and sender only read `leads.profile` / `leads.activity` / `enrichment_ready` — swapping the scraper for an external pipeline (Apollo, Clay, a custom service) is a drop-in replacement behind that contract. Nothing in this spec couples the scraper's implementation to the web app.

Rate-limiting benefit: send and enrichment no longer run *because of the same click*, so concurrent-session risk drops to whatever the operator schedules. See §9.

## 5. UI changes

### 5.1 Leads page

- **`RUN ENRICHMENT` button is renamed to `SEND INVITES`** and its behavior changes: it only triggers `sender.py` to render step 0 from CSV slots and send connect requests. It does **not** run the scraper.
- The separate `SEND INVITES` button (connect_only mode) collapses into this single button; mode toggle determines whether step 0 is authored as non-empty.
- `SEND MESSAGE AFTER FRIEND REQUEST ACCEPTANCE` button becomes redundant (post-acceptance send is auto-armed) — remove.
- New per-lead column: `enrichment: ✓ / pending / failed`.
- New small `ENRICHMENT STATUS` card (or footer strip): last-run time, queue depth, worker heartbeat. Read-only.

### 5.2 Sequence editor

- New `Step 0 — Connect note` field. Textarea with live char counter. Turns red at 280, blocks save at 301.
- Renames current `first_message` field to `Step 1 — Post-acceptance first message`.
- Slot picker shows which slots are CSV-only (badge: `CSV`) vs enriched (badge: `ENRICHED`). Step 0 field filters to CSV only.
- Save validation: step 0 ≤ 300 chars with all slots at worst-case length; step 0 references no enriched slots; fallbacks declared for every slot used.

### 5.3 DraftFeed

Deleted in its current form. Replaced by a **Send Monitor** view on the leads page (or as a separate `/monitor` route — see §6.1):

- Live list of leads with status: `QUEUED_CONNECT`, `CONNECT_SENT`, `SENT`, failures.
- Rendered step 0 / step 1 shown as read-only preview on each row (for sanity / debugging, not for approval).
- No approve, reject, or regenerate buttons on sequence-driven leads.

Legacy `DraftFeed` approval flow stays accessible only for leads that were created under the old model — guarded by a feature flag or by checking whether a lead has an associated sequence. Once no legacy leads remain, delete.

## 6. Component-level design

### 6.1 Files touched

| File | Change |
|---|---|
| `apps/web/components/StartEnrichmentButton.tsx` | Rename label to `SEND INVITES`; call new send-only endpoint. Drop connect_only-specific "send after acceptance" button. No scraper invocation. |
| `apps/web/app/api/enrich/route.ts` | Replace with send-only orchestration: spawn `sender.py` for queued connects. Remove scraper spawn entirely. Consider renaming route to `/api/send-invites` for clarity. |
| `apps/web/app/api/enrich/connect-only/route.ts` | Collapse into the unified send endpoint or delete. |
| `apps/web/app/api/enrich/status/route.ts` | Repurpose to return enrichment worker status (queue depth, last-run, heartbeat) for the status card. Read-only. |
| `apps/web/components/EnrichmentStatusCard.tsx` (new, ~80 LOC) | Small read-only card on leads page showing enrichment worker state. Subscribes to `leads.enrichment_ready` updates. |
| `run_all.sh` | Add `--enrichment` flag that loops `scraper.py --mode enrich` on a polling cadence. |
| `apps/web/components/DraftFeed.tsx` | Remove `mission_control` variant; demote to legacy-only; new monitor component renders rendered-preview rows. |
| `apps/web/components/SequenceEditor*` (existing sequence UI) | Add step 0 field, slot tier validation, char counter. |
| `apps/web/app/actions.ts` | Remove `approveAndSendAllDrafts`, `approveDraft`, `regenerateDraft` from sequence-driven path; keep for legacy until removal. Add `triggerOutreachPipeline(batchId)` as the single-button action. |
| `workers/sender/sender.py` | Add "render step 0 from sequence + CSV slots → send connect" mode. Auto-arm step 1: after acceptance, render step 1 with enriched+CSV slots and send. Remove dependency on `drafts` table for sequence-driven sends. |
| `workers/scraper/scraper.py` | No functional change internally. Invocation moves from web-action spawn to the `run_all.sh --enrichment` loop. Scraper now polls `leads` WHERE `enrichment_ready=false`. |
| `mcp-server/run_agent.py` | Not called for sequence-driven leads. Preserved for any legacy fallback; can be deleted once legacy is gone. |
| Supabase schema | Add `leads.enrichment_ready bool`, `outreach_sequences.connect_note text`, `outreach_sequences.slot_fallbacks jsonb`. |

LOC budget: aggregate ~600 LOC changed / added across the listed files; no file expected to grow past existing size (per §0 of AGENTS.md, file size discipline). Zero new deps.

### 6.2 Sequence save validation

Executed in the sequence editor action (server-side):

1. Parse step 0 template, extract referenced slots.
2. Reject save if any referenced slot is in the ENRICHED tier.
3. Compute worst-case rendered length: every slot at its declared `max_chars`. Reject if > 300.
4. Reject save if any slot used has no fallback declared.

### 6.3 Sender rendering

New helper `render_step(template, slots, fallbacks) -> str`:

- Substitutes `{slot}` with value, or fallback if null/empty.
- Strips to declared `max_chars` per slot.
- Returns final string. Sender never invents text.

Called at two points:
- Before connect send: `render_step(step0, csv_slots, fallbacks)`.
- Before post-acceptance send: `render_step(step1, csv_slots ∪ enriched_slots, fallbacks)`.

### 6.4 Enrichment readiness check

Before rendering step 1, sender reads `leads.enrichment_ready`. If false, sender retries up to M times with backoff (configurable, default M=3, backoff 1h/4h/24h). If still false, render step 1 using only slots available and fall back on the rest. Log a warning; do not block the send.

## 7. Data model changes

- `leads.enrichment_ready boolean default false` — set true by scraper on successful enrichment.
- `leads.status` gains new value `QUEUED_CONNECT` (transient, between `NEW` and `CONNECT_SENT`). Enforced via check constraint update.
- `outreach_sequences.connect_note text null` — step 0 template.
- `outreach_sequences.slot_fallbacks jsonb default '{}'` — per-slot fallback strings.
- No new tables.
- `drafts` table retained, unused by new path. Kept for legacy leads and followup-agent output.

## 8. Removed or simplified UI surface

- `DraftFeed.tsx` `variant="mission_control"` branch and its empty state.
- `approveAndSendAllDrafts`, `approveDraft`, `regenerateDraft` server actions (kept on legacy guard only; scheduled for deletion).
- `DRAFT_READY` / `MESSAGE_ONLY_READY` / `MESSAGE_ONLY_APPROVED` as first-class statuses in the UI.
- `SEND MESSAGE AFTER FRIEND REQUEST ACCEPTANCE` button on connect-only leads.
- Per-lead draft review, editing, and regenerate buttons on the new path.

## 9. Risks

**9.1 Concurrent LinkedIn session.** Because enrichment is now its own loop on a polling cadence rather than co-triggered with send, concurrency is a scheduling choice, not an emergent coupling. Mitigations (pick one during implementation):

- Time-slice: sender runs during business hours, enrichment loop off-hours. Default.
- Session-separate: use two LinkedIn accounts (sender, enrichment). Requires account provisioning.
- Mutex via `run_all.sh`: enrichment loop holds a lock file while scraping; sender checks and defers. Cheapest if sender runs are short.

**9.2 Step 1 fires before enrichment completes.** Acceptance lag is typically days, so this is rare. Fallback rendering (§6.4) covers the edge case. Worst case: step 1 goes out with `{about_excerpt}` replaced by the declared fallback. Acceptable.

**9.3 Legacy drafts stranded.** Leads in `DRAFT_READY` / `APPROVED` at cutover need to either finish through the old UI or be bulk-transitioned. Implementation plan decides.

**9.4 Operator expects per-lead edits.** Cultural / workflow shift, not a technical risk. The sequence editor is now the edit surface; per-lead edits no longer exist. This is by design and is what the operator asked for.

## 10. Testing criteria

Verifiable success per `LLM_FRIENDLY_PLAN_TEST_DEBUG`:

1. **Save validation tests:** sequence with step 0 referencing enriched slot → rejected. Step 0 exceeding 300 at worst-case slot lengths → rejected. Step 0 with undeclared-fallback slot → rejected.
2. **Render tests:** `render_step` with all slots present returns fully substituted string. With null slot → substitutes fallback. With over-length slot value → truncates to `max_chars`.
3. **Pipeline trigger test:** clicking RUN ENRICHMENT spawns both scraper and sender processes; neither blocks the other.
4. **Post-acceptance arming test:** simulated acceptance on a lead with `enrichment_ready=true` → step 1 renders with enriched slots and sends. `enrichment_ready=false` after M retries → step 1 sends with fallbacks, warning logged.
5. **Mode parity test:** empty step 0 sequence behaves identically to today's `connect-only` (invite only, step 1 post-acceptance).
6. **Legacy guard test:** leads created before migration still surface in `DraftFeed` and are approvable via the old path.

## 11. Open choices (defer to implementation plan)

- Concurrent-session mitigation (§9.1) — pick one.
- Monitor view location: embed in leads page vs new `/monitor` route.
- Whether to delete `run_agent.py` in this phase or leave for a follow-up once legacy drafts are drained.
- `M` / backoff schedule for enrichment readiness check — defaults proposed, confirm during implementation.

---

## Notes

This spec respects AGENTS.md §0: vanilla-first, zero new deps, no speculative abstraction. Every change traces to either "300-char constraint" or "enrichment-is-a-gate" and removes more UI surface than it adds. The sequence editor becomes the single place a human reviews text; everything downstream is mechanical rendering.
