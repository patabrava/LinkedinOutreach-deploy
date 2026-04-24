# Remove Nudge Review Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sender worker the sole owner of NUDGE followup creation so that messages 2 and 3 of every sequence flow automatically from sequence templates. Remove the scraper path that was creating empty `PENDING_REVIEW` NUDGE rows, and delete the stale rows already in the DB.

**Architecture:** Three surgical changes across two workers and the DB. (1) Remove the `elif is_outbound:` branch in `workers/scraper/scraper.py` that creates NUDGE followups. (2) Add a `followup_type="REPLY"` filter to `generateAllFollowupDrafts` in `apps/web/app/actions.ts` so the LLM draft pipeline never touches NUDGE rows. (3) Ship a one-time SQL migration that deletes the existing junk rows.

**Tech Stack:** Python 3.11 (scraper), TypeScript / Next.js 14 (web), PostgreSQL via Supabase migrations.

**Spec:** `docs/superpowers/specs/2026-04-24-remove-nudge-review-queue-design.md`

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `workers/scraper/scraper.py` | Modify | Delete `elif is_outbound:` branch and its orphaned counters/log lines. Inbox scan no longer creates NUDGE rows. |
| `apps/web/app/actions.ts` | Modify | Restrict `generateAllFollowupDrafts` fetch to `followup_type='REPLY'`. One added `.eq()` call. |
| `supabase/migrations/011_cleanup_pending_review_nudges.sql` | Create | One-time DELETE of stale `NUDGE + PENDING_REVIEW + empty draft_text` rows. |

**No new test files.** This project has minimal unit-test infrastructure (only `apps/web/lib/workerControl.test.ts` using `node:test`, and a diagnostic-only `workers/sender/test_sender.py`). Verification is done through grep assertions, syntax checks, and manual smoke-tests against the running workers (consistent with the project's current practice). The spec's "test plan" (items 1–6) drives the verification steps in each task below.

---

## Task 1: Add defensive `followup_type='REPLY'` filter in `generateAllFollowupDrafts`

**Files:**
- Modify: `apps/web/app/actions.ts:779-782`

This is defense-in-depth. After Task 2 is deployed, no new NUDGE rows will land in `PENDING_REVIEW`, but this filter ensures the LLM draft pipeline can never overwrite a NUDGE's template text even if a stray row appears.

- [ ] **Step 1: Read the current query**

Run: `sed -n '775,795p' apps/web/app/actions.ts`

Expected output (note the query filters only on status):

```ts
  try {
    const client = supabaseAdmin();

    // Fetch all PENDING_REVIEW followups without a draft
    const { data: followups, error: fetchError } = await client
      .from("followups")
      .select("id, draft_text")
      .eq("status", "PENDING_REVIEW");
```

- [ ] **Step 2: Add the `followup_type` filter**

Edit `apps/web/app/actions.ts`. Change this block:

```ts
    // Fetch all PENDING_REVIEW followups without a draft
    const { data: followups, error: fetchError } = await client
      .from("followups")
      .select("id, draft_text")
      .eq("status", "PENDING_REVIEW");
```

To:

```ts
    // Fetch all PENDING_REVIEW followups without a draft.
    // Only REPLY followups need LLM-generated drafts; NUDGE rows carry template
    // text populated by the sender worker and must never be touched here.
    const { data: followups, error: fetchError } = await client
      .from("followups")
      .select("id, draft_text")
      .eq("status", "PENDING_REVIEW")
      .eq("followup_type", "REPLY");
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `cd apps/web && npm run lint`
Expected: no errors related to `actions.ts`.

- [ ] **Step 5: Verify the change**

Run: `grep -n 'followup_type' apps/web/app/actions.ts | grep -i 'reply'`
Expected: at least one line showing `.eq("followup_type", "REPLY")` near line 783.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/actions.ts
git commit -m "fix(followups): restrict bulk draft generation to REPLY type

Prevents the LLM draft pipeline from overwriting NUDGE followups
whose draft_text already contains the operator's sequence template.
Defensive — the scraper will stop creating review-queue NUDGE rows
in the next change."
```

---

## Task 2: Remove scraper's NUDGE-creation branch

**Files:**
- Modify: `workers/scraper/scraper.py:2170-2234` (delete the `elif is_outbound:` block)
- Modify: `workers/scraper/scraper.py` (remove orphaned counter declarations and summary references: lines 2008, 2011, 2253, 2256, 2268, 2271)

After this task, the scraper's `inbox_scan` only creates REPLY followups. When a conversation's last message is outbound and there is no reply yet, the scan simply updates `leads.last_inbox_scan_at` and moves on — the sender worker handles scheduling the next nudge at the right time using `workers/sender/sender.py:1418-1461`.

- [ ] **Step 1: Capture current line numbers for deletion**

Run: `grep -n "elif is_outbound:\|Create nudge followup\|nudges_detected\|skipped_too_recent" workers/scraper/scraper.py`

Expected output (line numbers may differ slightly if the file has been edited — always trust the greps, not the literal numbers below):

```
2008:        nudges_detected = 0
2011:        skipped_too_recent = 0
2170:            elif is_outbound:
2211:                                skipped_too_recent += 1
2220:                # Create nudge followup
2232:                nudges_detected += 1
2253:                "nudges": nudges_detected,
2256:                "skipped_too_recent": skipped_too_recent,
2268:        print(f"  Nudges created: {nudges_detected}")
2271:        print(f"  Too recent (48h): {skipped_too_recent}")
```

The `elif is_outbound:` block runs from the line labeled `elif is_outbound:` through the line immediately before `# Update lead with scan timestamp after processing (reply or nudge)`. Identify those two anchor lines before editing.

- [ ] **Step 2: Delete the `elif is_outbound:` branch**

Open `workers/scraper/scraper.py`. Delete every line from (and including) `elif is_outbound:` through (and including) the last line of that branch, which is `print(f"  ✓ NUDGE opportunity: {lead_full_name}")`. The line immediately after the deletion must be the `# Update lead with scan timestamp after processing (reply or nudge)` comment (still at the same indentation as the deleted `elif`).

After deletion, the structure around the edit should look like:

```python
            if is_their_reply:
                # This is a REPLY - they responded to our message
                upsert_followup_for_reply(
                    client,
                    lead_id=lead_id,
                    reply_id=None,
                    reply_snippet=text[:500] if text else "",
                    reply_timestamp=reply_ts,
                    followup_type="REPLY",
                    last_message_text=text[:2000] if text else "",
                    last_message_from="lead",
                )
                replies_detected += 1
                logger.info(f"✓ Created followup for REPLY from {lead_full_name}", {"leadId": lead_id})
                print(f"  ✓ REPLY detected from: {lead_full_name}")

            # Update lead with scan timestamp after processing (reply or nudge)
            execute_with_retry(
                client.table("leads").update({
                    "last_inbox_scan_at": scan_ts,
                    "pending_invite": False,
                }).eq("id", lead_id),
                desc=f"Update last_inbox_scan_at after processing {lead_id}",
            )
```

Do not touch `replies_detected`, `is_their_reply`, `reply_ts`, or the REPLY branch itself.

- [ ] **Step 3: Remove orphaned counter declarations**

Still in `workers/scraper/scraper.py`, delete the two orphan initializer lines (the exact line numbers will have shifted after Step 2, so locate them with grep before editing):

```python
        nudges_detected = 0
```

and

```python
        skipped_too_recent = 0
```

Do NOT touch `skipped_no_conversation = 0`: that counter is still used earlier in the loop at the `if not convo_info:` check.

- [ ] **Step 4: Remove orphaned summary references**

In the `logger.info("Inbox scan complete", data={...})` block, delete these two dict entries:

```python
                "nudges": nudges_detected,
```

and

```python
                "skipped_too_recent": skipped_too_recent,
```

Leave every other key in that dict intact, including `"skipped_no_conversation"`.

In the `print(...)` summary block below it, delete these two lines:

```python
        print(f"  Nudges created: {nudges_detected}")
```

and

```python
        print(f"  Too recent (48h): {skipped_too_recent}")
```

Leave every other `print(...)` line intact.

- [ ] **Step 5: Verify no orphaned references remain**

Run: `grep -n "nudges_detected\|skipped_too_recent" workers/scraper/scraper.py`
Expected: no output (both symbols are fully removed).

Run: `grep -n 'followup_type="NUDGE"' workers/scraper/scraper.py`
Expected: no output. The scraper no longer creates NUDGE followups.

Run: `grep -n 'upsert_followup_for_reply' workers/scraper/scraper.py`
Expected: exactly two matches — the `def upsert_followup_for_reply(` definition near line 1905, and the REPLY-branch call that passes `followup_type="REPLY"`.

- [ ] **Step 6: Python syntax check**

Run: `python3 -m py_compile workers/scraper/scraper.py`
Expected: no output, exit code 0. A `SyntaxError` or `IndentationError` here means the deletion broke structure — re-inspect Step 2.

- [ ] **Step 7: Commit**

```bash
git add workers/scraper/scraper.py
git commit -m "refactor(scraper): remove NUDGE followup creation

The sender worker is the sole owner of nudge scheduling. Deleting
the scraper's elif is_outbound: branch means inbox_scan only creates
REPLY followups going forward. Outbound-only conversations now fall
through to the generic scan-timestamp update.

Orphaned counters (nudges_detected, skipped_too_recent) removed
along with their summary log entries."
```

---

## Task 3: Add cleanup migration for stale `PENDING_REVIEW` NUDGE rows

**Files:**
- Create: `supabase/migrations/011_cleanup_pending_review_nudges.sql`

The sender's `sender.py:1418-1461` path already includes a dedup guard (`.eq("followup_type", "NUDGE").eq("attempt", attempt)`), so it will re-create correctly-formed NUDGE rows for any lead whose cleanup-deleted row it needs.

- [ ] **Step 1: Verify no migration with ID 011 already exists**

Run: `ls supabase/migrations/ | grep '^011_'`
Expected: no output. If a file exists, bump to `012_` and keep going.

- [ ] **Step 2: Create the migration file**

Create `supabase/migrations/011_cleanup_pending_review_nudges.sql` with this exact content:

```sql
-- Remove stale NUDGE followups stuck in PENDING_REVIEW with empty drafts.
--
-- Background: before this migration, the scraper's inbox_scan created NUDGE
-- followups as PENDING_REVIEW with empty draft_text, duplicating the sender's
-- own nudge scheduler (which creates them as APPROVED with template text).
-- The scraper path has been removed. This cleans up the orphaned rows.
--
-- The sender worker's nudge scheduler will re-create correctly-formed rows
-- (status='APPROVED', draft_text=sequence template) on its next pass for any
-- lead that is still eligible for a nudge.
--
-- Safety: only targets rows that (a) are NUDGE type, (b) are still in review,
-- and (c) have no draft text. Any row with operator-authored or LLM-generated
-- draft_text is preserved. REPLY followups are never touched.

DELETE FROM followups
WHERE followup_type = 'NUDGE'
  AND status = 'PENDING_REVIEW'
  AND (draft_text IS NULL OR draft_text = '');
```

- [ ] **Step 3: Inspect what the migration would affect (read-only)**

Before applying, run a read-only query against the target DB (staging first if available, then prod). Use whichever Supabase / psql interface the project uses — for a local Supabase CLI this is:

```bash
supabase db execute --db-url "$DATABASE_URL" --file - <<'SQL'
SELECT
  COUNT(*) FILTER (
    WHERE followup_type = 'NUDGE'
      AND status = 'PENDING_REVIEW'
      AND (draft_text IS NULL OR draft_text = '')
  ) AS will_delete,
  COUNT(*) FILTER (WHERE followup_type = 'REPLY') AS reply_total_untouched,
  COUNT(*) FILTER (WHERE followup_type = 'NUDGE' AND status = 'APPROVED') AS nudge_approved_untouched,
  COUNT(*) FILTER (WHERE followup_type = 'NUDGE' AND status = 'SENT') AS nudge_sent_untouched
FROM followups;
SQL
```

Expected: `will_delete` is a non-negative integer (the junk rows). All three `*_untouched` counters reflect the existing row counts and will not change after the migration runs. If `will_delete` is 0, ship the migration anyway — it becomes a no-op and documents intent for future readers.

- [ ] **Step 4: Verify file is well-formed SQL**

Run: `grep -c "^DELETE FROM followups" supabase/migrations/011_cleanup_pending_review_nudges.sql`
Expected: `1`.

Run: `grep -E "^--|^$|^DELETE|^WHERE|^\s+AND" supabase/migrations/011_cleanup_pending_review_nudges.sql | wc -l`
Expected: a number matching the total non-blank non-SQL lines plus the 5 SQL lines of the statement — essentially, no stray content outside comments and the one DELETE. Spot-check by reading the file end-to-end.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/011_cleanup_pending_review_nudges.sql
git commit -m "chore(db): drop stale PENDING_REVIEW NUDGE followups

Scraper-created NUDGE rows with empty draft_text are removed so the
/followups review queue contains only AI-drafted REPLY rows. The
sender worker re-schedules correctly-formed APPROVED NUDGE rows on
its next pass for any still-eligible lead."
```

---

## Task 4: End-to-end verification against a live environment

**Files:** (none modified)

This task is the go/no-go before merge. Run it on a staging environment if one exists; otherwise coordinate with the operator for a low-risk production window. No code changes happen here — the task is strictly verification.

- [ ] **Step 1: Confirm all three code changes are on the branch**

Run: `git log --oneline -n 3`
Expected: three commits matching the messages from Tasks 1, 2, and 3 (web filter, scraper refactor, DB migration) in some order.

- [ ] **Step 2: Apply the migration to the target DB**

Run (example — use whatever flow the operator uses for migrations):

```bash
supabase db push
```

Expected: migration `011_cleanup_pending_review_nudges.sql` reported as applied with a row count matching Task 3 Step 3's `will_delete` value.

- [ ] **Step 3: Smoke-test the `/followups` UI**

1. Open `/followups` in a logged-in browser session.
2. Confirm every row shown has `followup_type='REPLY'`. There should be no rows labeled `NUDGE`. (Operator can spot-check via the "FOLLOWUP TYPE" column / chip on each card.)
3. Click APPROVE & SEND on one REPLY row whose draft is good. Confirm it transitions to `APPROVED` then `SENT` via the sender worker's next pass.

- [ ] **Step 4: Run the scraper once and confirm no NUDGE row is created**

1. Trigger an inbox scan via the normal operator path (the scraper CLI or the UI action that kicks off the scraper).
2. While the scan is running (or after it finishes), query:

   ```sql
   SELECT COUNT(*) FROM followups
   WHERE followup_type = 'NUDGE'
     AND status = 'PENDING_REVIEW';
   ```

   Expected: `0`. If this returns non-zero after the scan, Task 2's deletion was incomplete — bisect by grepping `scraper.py` for `followup_type="NUDGE"`.

3. Check the scraper's summary log output (terminal or shared log). Confirm the summary no longer references `nudges` or `skipped_too_recent` keys.

- [ ] **Step 5: Run the sender once and confirm nudges still schedule correctly**

1. Pick a test lead whose last outbound message is older than the sequence's `followup_interval_days` and who has never replied.
2. Trigger the sender via the normal path.
3. Query:

   ```sql
   SELECT id, status, followup_type, attempt, left(draft_text, 80) AS draft_preview
   FROM followups
   WHERE lead_id = '<lead-id>'
   ORDER BY created_at DESC
   LIMIT 5;
   ```

   Expected: a new row exists with `followup_type='NUDGE'`, `status='APPROVED'`, `attempt=1`, and `draft_preview` starting with the sequence's rendered `second_message`. No row appears in `PENDING_REVIEW`.

- [ ] **Step 6: Regression check on `generateAllFollowupDrafts`**

1. Insert a synthetic row into `followups` that bypasses the migration:

   ```sql
   INSERT INTO followups (lead_id, status, followup_type, draft_text)
   VALUES ('<any-real-lead-id>', 'PENDING_REVIEW', 'NUDGE', '');
   ```

2. Trigger "Generate all drafts" via the UI or call `generateAllFollowupDrafts` directly.
3. Expected server response: `{ total: 0, generated: 0, failed: 0, errors: [] }`. The synthetic NUDGE row is ignored.
4. Clean up: delete the synthetic row.

   ```sql
   DELETE FROM followups
   WHERE followup_type = 'NUDGE'
     AND status = 'PENDING_REVIEW'
     AND draft_text = ''
     AND lead_id = '<any-real-lead-id>';
   ```

- [ ] **Step 7: Tag the verification outcome in the branch**

If all checks pass, push the branch and open a PR referencing the spec at `docs/superpowers/specs/2026-04-24-remove-nudge-review-queue-design.md`. If any check fails, do NOT merge. Open a follow-up task with the failure evidence and route back to the relevant Task (1, 2, or 3) for a fix.

---

## Rollback plan

Per the spec (§Rollback):

- **Task 1 rollback:** `git revert` the actions.ts commit. LLM pipeline resumes touching all PENDING_REVIEW rows.
- **Task 2 rollback:** `git revert` the scraper commit. Scraper resumes creating NUDGE-type `PENDING_REVIEW` rows.
- **Task 3 rollback:** deleted rows are not recoverable from the migration alone. Restore from Supabase point-in-time recovery if needed. Acceptable risk because deleted rows had empty `draft_text` (no human-authored content lost).

All three commits can be reverted independently; there are no cross-dependencies in the code changes themselves.
