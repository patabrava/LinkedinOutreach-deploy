# Reply Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make existing `/followups` reply rows classify inbound replies as `positive` or `negative`, draft a constrained Gemini-assisted response, and keep manual review before send.

**Architecture:** Keep the feature inside the current followups slice: inbox scan still creates `followups`, `/followups` still renders the mixed review queue, `generateFollowupDraft()` remains the web action boundary, and `mcp-server/run_followup_agent.py` owns model classification plus draft generation. Persist only the selected reply intent and confidence on `followups`; do not add a new page, workflow, outreach mode, or sender path.

**Tech Stack:** Next.js 14 server actions, React 18, Supabase, Python 3.10+, Gemini REST API via Python standard library, Node `node:test`, Python `unittest`.

---

## Context-Zero

**Environment matrix**
- OS: macOS local development; Linux in Hostinger production containers.
- Web runtime: Next.js 14.2.11 in `apps/web`.
- Worker runtime: Python 3.10+; local venvs under `mcp-server/venv` and `workers/sender/venv`.
- Persistence: Supabase tables `followups`, `leads`, `drafts`, `outreach_sequences`.
- Existing UI route: `apps/web/app/followups/page.tsx`.
- Existing review component: `apps/web/components/FollowupsList.tsx`.
- Existing draft action: `apps/web/app/actions.ts::generateFollowupDraft()`.
- Existing model entrypoint: `mcp-server/run_followup_agent.py`.
- Current reply source: `workers/scraper/scraper.py --inbox --run` creates `followups.status='PENDING_REVIEW'` rows with `followup_type='REPLY'`.

**Non-functional requirements**
- Files: target 8 touched files, no generated artifacts outside `docs/superpowers/plans`, `supabase`, `mcp-server`, and the existing followups UI slice.
- LOC/file: `mcp-server/run_followup_agent.py` target +180 LOC and stays under 1000 LOC; `apps/web/app/actions.ts` target +45 LOC; `FollowupsList.tsx` target +70 LOC; tests each target under 250 LOC; SQL migration under 60 LOC.
- Deps: 0 new dependencies. Use `urllib.request` for Gemini REST instead of adding `google-genai`.
- Reliability: invalid JSON, missing Gemini env, and unsafe/generated link drift must keep the row in `PENDING_REVIEW` and surface `last_error`.
- Safety: never auto-send model output; approval still requires the existing manual action.
- Scope discipline: no new page, tab, route, sender mode, dashboard, or general inbox abstraction.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `supabase/migrations/018_add_reply_intent_to_followups.sql` | Create | Add `reply_intent` and `reply_intent_confidence` to `followups` with constraints and indexes. |
| `supabase/schema.sql` | Modify | Keep bootstrap schema aligned with the new followup metadata columns. |
| `mcp-server/run_followup_agent.py` | Modify | Add Gemini REST adapter, reply intent contract, draft safety validation, and keep legacy nudge behavior isolated. |
| `mcp-server/test_reply_drafting.py` | Create | Unit-test classification normalization, approved link preservation, invalid JSON rejection, and negative fallback behavior. |
| `apps/web/app/actions.ts` | Modify | Extend `FollowupRow`, persist `reply_intent` / confidence from agent output, and write `last_error` on generation failures. |
| `apps/web/components/FollowupsList.tsx` | Modify | Show subtle reply row treatment and `POSITIVE` / `NEGATIVE` intent badge without adding navigation. |
| `apps/web/lib/followupReplyIntent.ts` | Create | Tiny pure helper for intent labels/classes so UI intent behavior is testable without a React test framework. |
| `apps/web/lib/followupReplyIntent.test.ts` | Create | Node test for reply intent rendering helper and nudge no-op behavior. |

## Capability Map

- Reply classification: Gemini chooses exactly `positive` or `negative`; ambiguous output resolves to `negative`.
- Positive draft: preserves `https://api.degura.de/2.0/consultants/my-scheduling-link`.
- Negative draft: preserves `https://www.degura.de/arbeitnehmer`.
- Existing review flow: `PENDING_REVIEW -> draft_text -> APPROVED -> PROCESSING -> SENT` remains unchanged.
- Existing nudge behavior: `NUDGE` rows keep their sequence-template behavior and do not call reply-specific logic.
- UI distinguishability: reply rows keep the `REPLY` badge and add a small intent badge only after drafting.

## Pass-Fail Criteria

- `python3 -m unittest mcp-server/test_reply_drafting.py` passes.
- `npm --prefix apps/web exec tsc -- --noEmit` passes for the new TypeScript helper and test file.
- `npm run build:web` passes.
- `python3 -m pytest workers/sender/test_sender.py -k "followup"`, or the existing worker test command used locally, still passes enough to prove sender followup resolution was not changed.
- A synthetic positive reply draft stores `draft_text`, `reply_intent='positive'`, and the booking link.
- A synthetic negative or ambiguous reply draft stores `draft_text`, `reply_intent='negative'`, and the Degura website link.
- A failed Gemini call leaves `status='PENDING_REVIEW'`, does not write `draft_text`, and writes `last_error`.
- `/followups` still shows `REPLY` and `NUDGE` rows in one list; no new page, tab, or filter panel exists.

## Task 1: Add Reply Intent Columns

**Files:**
- Create: `supabase/migrations/018_add_reply_intent_to_followups.sql`
- Modify: `supabase/schema.sql`
- Test: SQL verification queries in this task

- [ ] **Step 1: Create the migration**

Create `supabase/migrations/018_add_reply_intent_to_followups.sql` with:

```sql
-- Migration 018: Store AI reply intent on followups.
-- The existing followup lifecycle remains unchanged; these fields only annotate
-- AI-generated REPLY drafts for operator review.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'followups' AND column_name = 'reply_intent'
    ) THEN
        ALTER TABLE followups ADD COLUMN reply_intent TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'followups' AND column_name = 'reply_intent_confidence'
    ) THEN
        ALTER TABLE followups ADD COLUMN reply_intent_confidence NUMERIC;
    END IF;
END $$;

ALTER TABLE followups DROP CONSTRAINT IF EXISTS followups_reply_intent_check;
ALTER TABLE followups ADD CONSTRAINT followups_reply_intent_check
CHECK (reply_intent IS NULL OR reply_intent IN ('positive', 'negative'));

ALTER TABLE followups DROP CONSTRAINT IF EXISTS followups_reply_intent_confidence_check;
ALTER TABLE followups ADD CONSTRAINT followups_reply_intent_confidence_check
CHECK (reply_intent_confidence IS NULL OR (reply_intent_confidence >= 0 AND reply_intent_confidence <= 1));

CREATE INDEX IF NOT EXISTS idx_followups_reply_intent ON followups(reply_intent)
WHERE reply_intent IS NOT NULL;

COMMENT ON COLUMN followups.reply_intent IS 'AI-classified inbound reply intent: positive or negative.';
COMMENT ON COLUMN followups.reply_intent_confidence IS 'Model confidence for reply_intent in the range 0..1.';
```

- [ ] **Step 2: Align the bootstrap schema**

In `supabase/schema.sql`, add the same columns to the `followups` table definition if the table is declared there. If `followups` is not currently declared in the bootstrap script, add a short comment near the migrations section instead:

```sql
-- Followup reply-intent metadata is added by
-- supabase/migrations/018_add_reply_intent_to_followups.sql.
```

- [ ] **Step 3: Verify migration syntax locally**

Run:

```bash
grep -n "reply_intent" supabase/migrations/018_add_reply_intent_to_followups.sql
```

Expected: lines for `reply_intent`, `reply_intent_confidence`, both constraints, the partial index, and both comments.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/018_add_reply_intent_to_followups.sql supabase/schema.sql
git commit -m "chore(db): add reply intent metadata to followups"
```

## Task 2: Add Gemini Reply Draft Contract Tests

**Files:**
- Create: `mcp-server/test_reply_drafting.py`
- Modify: none
- Test: `mcp-server/test_reply_drafting.py`

- [ ] **Step 1: Write failing tests for the reply contract**

Create `mcp-server/test_reply_drafting.py` with:

```python
#!/usr/bin/env python3
"""Tests for Gemini-backed reply draft contract."""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import run_followup_agent as agent


class ReplyDraftingTest(unittest.TestCase):
    def test_positive_reply_preserves_booking_link(self):
        payload = json.dumps({
            "intent": "positive",
            "draft_text": "Freut mich zu hören, hier kannst du einen Termin buchen https://api.degura.de/2.0/consultants/my-scheduling-link",
            "confidence": 0.91,
        })
        result = agent.parse_reply_generation_response(payload)

        self.assertEqual(result["intent"], "positive")
        self.assertEqual(result["confidence"], 0.91)
        self.assertIn(agent.POSITIVE_REPLY_LINK, result["message"])

    def test_negative_reply_preserves_website_link(self):
        payload = json.dumps({
            "intent": "negative",
            "draft_text": "Kein Problem, falls es später interessant wird findest du hier Infos https://www.degura.de/arbeitnehmer",
            "confidence": 0.74,
        })
        result = agent.parse_reply_generation_response(payload)

        self.assertEqual(result["intent"], "negative")
        self.assertIn(agent.NEGATIVE_REPLY_LINK, result["message"])

    def test_ambiguous_intent_defaults_to_negative(self):
        payload = json.dumps({
            "intent": "unclear",
            "draft_text": "Schau gerne hier vorbei https://www.degura.de/arbeitnehmer",
            "confidence": 0.32,
        })
        result = agent.parse_reply_generation_response(payload)

        self.assertEqual(result["intent"], "negative")
        self.assertIn(agent.NEGATIVE_REPLY_LINK, result["message"])

    def test_rejects_missing_required_link(self):
        payload = json.dumps({
            "intent": "positive",
            "draft_text": "Freut mich, ich melde mich dazu.",
            "confidence": 0.9,
        })

        with self.assertRaises(ValueError) as raised:
            agent.parse_reply_generation_response(payload)

        self.assertIn("approved link", str(raised.exception))

    def test_rejects_invalid_json(self):
        with self.assertRaises(ValueError) as raised:
            agent.parse_reply_generation_response("not json")

        self.assertIn("valid JSON", str(raised.exception))

    def test_generate_reply_uses_gemini_adapter_for_reply_rows(self):
        context = {
            "followup_id": "fu_1",
            "followup_type": "REPLY",
            "reply_snippet": "Ja, das klingt interessant.",
            "last_message_text": "Ja, das klingt interessant.",
            "last_message_from": "lead",
        }
        payload = json.dumps({
            "intent": "positive",
            "draft_text": f"Gerne, buch dir hier einen Termin {agent.POSITIVE_REPLY_LINK}",
            "confidence": 0.88,
        })

        with patch.object(agent, "call_gemini_reply_model", return_value=payload):
            result = agent.generate_followup(context)

        self.assertEqual(result["intent"], "positive")
        self.assertEqual(result["message_type"], "reply_positive")
        self.assertIn(agent.POSITIVE_REPLY_LINK, result["message"])
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
python3 -m unittest mcp-server/test_reply_drafting.py
```

Expected: FAIL because `POSITIVE_REPLY_LINK`, `NEGATIVE_REPLY_LINK`, `parse_reply_generation_response()`, and `call_gemini_reply_model()` do not exist yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add mcp-server/test_reply_drafting.py
git commit -m "test(followups): cover reply intent draft contract"
```

## Task 3: Implement Gemini Reply Drafting

**Files:**
- Modify: `mcp-server/run_followup_agent.py`
- Test: `mcp-server/test_reply_drafting.py`

- [ ] **Step 1: Add constants and reply helpers**

In `mcp-server/run_followup_agent.py`, add these imports and constants near the top:

```python
import urllib.error
import urllib.request

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
GEMINI_ENDPOINT_TEMPLATE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
POSITIVE_REPLY_LINK = "https://api.degura.de/2.0/consultants/my-scheduling-link"
NEGATIVE_REPLY_LINK = "https://www.degura.de/arbeitnehmer"
POSITIVE_REPLY_ANCHOR = (
    "Freut mich zu hören, kannst dir gerne hier einen Termin mit einem unserer "
    f"bAV Experten buchen {POSITIVE_REPLY_LINK}"
)
NEGATIVE_REPLY_ANCHOR = (
    "Wenn es später interessant wird, findest du hier einen Überblick: "
    f"{NEGATIVE_REPLY_LINK}"
)
```

Add these helpers below `sanitize_message()`:

```python
def _is_reply_context(context: Dict[str, Any]) -> bool:
    followup_type = str(context.get("followup_type") or "").upper()
    last_message_from = str(context.get("last_message_from") or "").lower()
    return followup_type == "REPLY" or last_message_from == "lead" or bool(context.get("reply_snippet"))


def _clamp_confidence(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, numeric))


def _extract_json_object(raw_content: str) -> Dict[str, Any]:
    raw = (raw_content or "").strip()
    if not raw:
        raise ValueError("Gemini returned empty content instead of valid JSON")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            raise ValueError("Gemini did not return valid JSON")
        try:
            return json.loads(match.group())
        except json.JSONDecodeError as exc:
            raise ValueError("Gemini did not return valid JSON") from exc


def parse_reply_generation_response(raw_content: str) -> Dict[str, Any]:
    payload = _extract_json_object(raw_content)
    intent = str(payload.get("intent") or "").strip().lower()
    if intent not in {"positive", "negative"}:
        intent = "negative"

    draft_text = sanitize_message(str(payload.get("draft_text") or payload.get("message") or ""))
    if not draft_text:
        raise ValueError("Gemini reply draft is empty")

    required_link = POSITIVE_REPLY_LINK if intent == "positive" else NEGATIVE_REPLY_LINK
    if required_link not in draft_text:
        raise ValueError(f"Gemini reply draft did not preserve approved link: {required_link}")

    return {
        "message": draft_text,
        "intent": intent,
        "confidence": _clamp_confidence(payload.get("confidence")),
        "message_type": f"reply_{intent}",
        "tone": "friendly",
    }
```

- [ ] **Step 2: Add the Gemini REST adapter**

Add this function below `parse_reply_generation_response()`:

```python
def build_reply_generation_prompt(context: Dict[str, Any]) -> str:
    reply_text = context.get("last_message_text") or context.get("reply_snippet") or ""
    first_name = context.get("first_name") or ""
    company_name = context.get("company_name") or ""
    original_message = context.get("original_message") or ""

    return "\n".join([
        "Du klassifizierst eine LinkedIn Antwort und formulierst eine sehr kurze Antwort.",
        "Erlaubte intents: positive, negative.",
        "Wenn die Antwort unklar, ablehnend, vertroestend oder ohne klares Interesse ist, waehle negative.",
        "Wenn die Person Interesse zeigt, ein Gespraech will oder mehr wissen moechte, waehle positive.",
        "Nutze nur eine leichte Umformulierung der passenden genehmigten Vorlage.",
        "Keine neuen Links, keine neuen Angebote, kein langer Chatbot-Text.",
        "",
        f"Positive Vorlage: {POSITIVE_REPLY_ANCHOR}",
        f"Negative Vorlage: {NEGATIVE_REPLY_ANCHOR}",
        "",
        "Antworte ausschliesslich als JSON:",
        '{"intent":"positive|negative","draft_text":"string","confidence":0.0}',
        "",
        f"Kontakt Vorname: {first_name}",
        f"Firma: {company_name}",
        f"Unsere vorherige Nachricht: {original_message[:500]}",
        f"Antwort des Kontakts: {reply_text[:1000]}",
    ])


def call_gemini_reply_model(context: Dict[str, Any]) -> str:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY not set")

    endpoint = GEMINI_ENDPOINT_TEMPLATE.format(model=GEMINI_MODEL, api_key=api_key)
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": build_reply_generation_prompt(context)}],
            }
        ],
        "generationConfig": {
            "temperature": 0.25,
            "maxOutputTokens": 300,
            "responseMimeType": "application/json",
        },
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini HTTP {exc.code}: {detail[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Gemini request failed: {exc}") from exc

    try:
        return payload["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"Gemini response missing text content: {json.dumps(payload)[:500]}") from exc
```

- [ ] **Step 3: Route reply contexts through Gemini**

At the top of `generate_followup(context)`, before the OpenAI legacy path, add:

```python
    if _is_reply_context(context):
        logger.debug("Generating Gemini reply draft", data={
            "followup_id": context.get("followup_id"),
            "has_reply": bool(context.get("reply_snippet") or context.get("last_message_text")),
        })
        raw_content = call_gemini_reply_model(context)
        return parse_reply_generation_response(raw_content)
```

Keep the existing OpenAI prompt path below this branch for non-reply legacy behavior only.

- [ ] **Step 4: Include intent in operation logs**

In `main()`, update the `logger.operation_complete()` result object:

```python
        logger.operation_complete("followup-generation", result={
            "message_length": len(result.get("message", "")),
            "message_type": result.get("message_type"),
            "intent": result.get("intent"),
            "confidence": result.get("confidence"),
        })
```

- [ ] **Step 5: Run tests**

Run:

```bash
python3 -m unittest mcp-server/test_reply_drafting.py
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/run_followup_agent.py mcp-server/test_reply_drafting.py
git commit -m "feat(followups): draft reply responses with Gemini"
```

## Task 4: Persist Reply Intent From the Web Action

**Files:**
- Modify: `apps/web/app/actions.ts`
- Test: `npm run build:web`

- [ ] **Step 1: Extend the FollowupRow type**

In `FollowupRow`, add:

```ts
  reply_intent?: "positive" | "negative" | null;
  reply_intent_confidence?: number | null;
```

- [ ] **Step 2: Pass followup type into the agent context**

Inside `generateFollowupDraft()`, add `followup_type` to the context object:

```ts
      followup_type: followup.followup_type || "REPLY",
```

- [ ] **Step 3: Parse and persist intent metadata**

Replace the parse/update block with:

```ts
      const parsed = JSON.parse(result.trim());
      const draft = parsed.message || parsed.draft_text || "";
      const replyIntent = parsed.intent === "positive" || parsed.intent === "negative"
        ? parsed.intent
        : null;
      const replyIntentConfidence = typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : null;

      if (draft) {
        const updatePayload: Record<string, any> = {
          draft_text: draft,
          last_error: null,
        };
        if ((followup.followup_type || "REPLY") === "REPLY") {
          updatePayload.reply_intent = replyIntent;
          updatePayload.reply_intent_confidence = replyIntentConfidence;
        }

        const { error: updateError } = await client
          .from("followups")
          .update(updatePayload)
          .eq("id", followupId);

        if (updateError) {
          logger.error("Failed to update followup draft", { correlationId, followupId }, updateError);
          return { success: false, error: updateError.message || "Draft update failed" };
        }

        logger.actionComplete("generateFollowupDraft", { correlationId, followupId }, {
          draftLength: draft.length,
          replyIntent,
          replyIntentConfidence,
        });
        revalidatePath("/followups");
        return { success: true, draft };
      }
```

- [ ] **Step 4: Write generation failures to the row**

Inside the `catch (execError: any)` block for agent execution, before returning, add:

```ts
      const errorMessage = execError.message || "Agent execution failed";
      await client
        .from("followups")
        .update({ last_error: errorMessage.slice(0, 500) })
        .eq("id", followupId);
      revalidatePath("/followups");
      return { success: false, error: errorMessage };
```

Remove the old `return { success: false, error: execError.message || "Agent execution failed" };` from that same catch block.

- [ ] **Step 5: Verify TypeScript build**

Run:

```bash
npm run build:web
```

Expected: PASS, or only unrelated ambient build failures already known in this repo. If it fails on `reply_intent` types or `generateFollowupDraft()`, fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/actions.ts
git commit -m "feat(followups): persist reply intent metadata"
```

## Task 5: Add Intent UI Helper and Tests

**Files:**
- Create: `apps/web/lib/followupReplyIntent.ts`
- Create: `apps/web/lib/followupReplyIntent.test.ts`
- Test: `apps/web/lib/followupReplyIntent.test.ts`

- [ ] **Step 1: Add the pure UI helper**

Create `apps/web/lib/followupReplyIntent.ts`:

```ts
export type ReplyIntent = "positive" | "negative";

type IntentView = {
  label: string;
  className: string;
  title: string;
};

export function getReplyIntentView(
  followupType?: string | null,
  replyIntent?: string | null,
): IntentView | null {
  if ((followupType || "REPLY").toUpperCase() !== "REPLY") {
    return null;
  }

  if (replyIntent === "positive") {
    return {
      label: "POSITIVE",
      className: "status-approved",
      title: "Interested reply. Draft should keep the booking link.",
    };
  }

  if (replyIntent === "negative") {
    return {
      label: "NEGATIVE",
      className: "status-pending",
      title: "No-interest or ambiguous reply. Draft should keep the website link.",
    };
  }

  return null;
}
```

- [ ] **Step 2: Add tests**

Create `apps/web/lib/followupReplyIntent.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { getReplyIntentView } from "./followupReplyIntent";

test("shows positive intent for reply rows", () => {
  const view = getReplyIntentView("REPLY", "positive");
  assert.equal(view?.label, "POSITIVE");
  assert.equal(view?.className, "status-approved");
});

test("shows negative intent for reply rows", () => {
  const view = getReplyIntentView("REPLY", "negative");
  assert.equal(view?.label, "NEGATIVE");
  assert.equal(view?.className, "status-pending");
});

test("does not show intent for nudge rows", () => {
  assert.equal(getReplyIntentView("NUDGE", "positive"), null);
});

test("does not show intent before drafting", () => {
  assert.equal(getReplyIntentView("REPLY", null), null);
});
```

- [ ] **Step 3: Run helper tests**

Run:

```bash
npm --prefix apps/web exec tsc -- --noEmit
```

Expected: TypeScript compiles the helper and test import path remains valid.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/followupReplyIntent.ts apps/web/lib/followupReplyIntent.test.ts
git commit -m "test(followups): cover reply intent labels"
```

## Task 6: Render Reply Intent in FollowupsList

**Files:**
- Modify: `apps/web/components/FollowupsList.tsx`
- Test: `npm run build:web`

- [ ] **Step 1: Import the helper**

Add:

```ts
import { getReplyIntentView } from "../lib/followupReplyIntent";
```

- [ ] **Step 2: Add subtle reply row treatment**

Inside the `sortedRows.map()` block after `typeInfo`, add:

```ts
                const intentView = getReplyIntentView(followupTypeKey, row.reply_intent);
                const isReplyRow = followupTypeKey === "REPLY";
```

Change the `<tr>` opening tag to:

```tsx
                  <tr
                    key={row.id}
                    style={isReplyRow ? { boxShadow: "inset 3px 0 0 rgba(20, 184, 166, 0.55)" } : undefined}
                  >
```

- [ ] **Step 3: Show the intent badge below the REPLY badge**

In the `TYPE` cell, after the existing type badge, render:

```tsx
                      {intentView ? (
                        <div style={{ marginTop: 6 }}>
                          <span
                            className={`status-chip ${intentView.className}`}
                            title={intentView.title}
                            style={{ minWidth: 72, textAlign: "center", fontSize: 10 }}
                          >
                            {intentView.label}
                          </span>
                        </div>
                      ) : null}
```

- [ ] **Step 4: Improve the draft placeholder for reply rows**

Change the textarea placeholder to:

```tsx
                          placeholder={followupTypeKey === "REPLY" ? "Generate or enter reply message..." : "Enter follow-up message..."}
```

- [ ] **Step 5: Build**

Run:

```bash
npm run build:web
```

Expected: PASS, or no new failure attributable to `FollowupsList.tsx`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/FollowupsList.tsx
git commit -m "feat(followups): show reply intent badges"
```

## Task 7: End-to-End Manual Verification Script

**Files:**
- Modify: none
- Test: Supabase + local web + existing workers

- [ ] **Step 1: Apply the migration to the target Supabase project**

Use the project’s normal migration path. If using the Supabase CLI locally:

```bash
supabase db push
```

Expected: migration `018_add_reply_intent_to_followups.sql` applies cleanly.

- [ ] **Step 2: Verify environment variables**

Run:

```bash
printenv GEMINI_API_KEY >/dev/null && echo "GEMINI_API_KEY present"
```

Expected: `GEMINI_API_KEY present`.

- [ ] **Step 3: Start the local web app**

Run:

```bash
lsof -ti tcp:3000 | xargs -r kill
rm -rf apps/web/.next
npm run dev:web
```

Expected: Next.js reports it is ready on port `3000`.

- [ ] **Step 4: Insert or identify one positive reply followup**

Use an existing safe test lead or insert a synthetic row linked to a test lead:

```sql
INSERT INTO followups (
  lead_id,
  status,
  followup_type,
  reply_snippet,
  last_message_text,
  last_message_from,
  attempt
) VALUES (
  '<test-lead-id>',
  'PENDING_REVIEW',
  'REPLY',
  'Ja, das klingt interessant. Wo kann ich einen Termin buchen?',
  'Ja, das klingt interessant. Wo kann ich einen Termin buchen?',
  'lead',
  1
);
```

Expected: row appears in `/followups` with `REPLY`.

- [ ] **Step 5: Generate a draft from the UI**

Open `http://localhost:3000/followups`, click `DRAFT WITH AI` on the positive reply.

Expected:
- The textarea receives a short draft.
- The draft contains `https://api.degura.de/2.0/consultants/my-scheduling-link`.
- The row shows `POSITIVE`.
- Supabase row has `reply_intent='positive'` and non-null `reply_intent_confidence`.

- [ ] **Step 6: Verify a negative reply**

Use a second safe test row:

```sql
INSERT INTO followups (
  lead_id,
  status,
  followup_type,
  reply_snippet,
  last_message_text,
  last_message_from,
  attempt
) VALUES (
  '<test-lead-id>',
  'PENDING_REVIEW',
  'REPLY',
  'Nein danke, aktuell kein Interesse.',
  'Nein danke, aktuell kein Interesse.',
  'lead',
  1
);
```

Generate the draft.

Expected:
- The draft contains `https://www.degura.de/arbeitnehmer`.
- The row shows `NEGATIVE`.
- Supabase row has `reply_intent='negative'`.

- [ ] **Step 7: Verify manual approval still gates send**

For each test row, do not click `APPROVE & SEND` until after checking the draft. Then edit one word and click `APPROVE & SEND`.

Expected:
- The row updates to `APPROVED` or sender processing starts.
- No row sends before the approval click.
- The edited text is what is stored in `draft_text`.

- [ ] **Step 8: Verify nudge behavior did not change**

Run:

```bash
python3 -m pytest workers/sender/test_sender.py -k "followup"
```

Expected: existing followup sender tests pass, or any failure is unrelated to this plan’s changed files. Confirm `NUDGE` rows do not receive `reply_intent` during bulk draft generation.

- [ ] **Step 9: Commit final verification notes if implementation changed docs**

If any implementation note is added to docs, commit it:

```bash
git add docs
git commit -m "docs(followups): record reply management verification"
```

## Self-Review

**Spec coverage**
- Keep replies inside `/followups`: Tasks 4, 6, and 7.
- Auto-classify `positive` / `negative`: Tasks 1, 2, 3, and 4.
- Use Gemini: Task 3.
- Preserve approved style and links: Tasks 2 and 3.
- Preserve manual review: Tasks 4, 6, and 7.
- Make replies visually distinguishable: Tasks 5 and 6.
- Error handling: Tasks 3 and 4.
- Testing: Tasks 2, 5, and 7.
- No new reply dashboard or sender behavior: enforced in File Structure and Pass-Fail Criteria.

**Placeholder scan**
- No `TBD`, `TODO`, `implement later`, or unspecified helper names remain in executable steps.
- Every new function referenced in a later task is defined in an earlier task.

**Type consistency**
- Database columns use `reply_intent` and `reply_intent_confidence`.
- Python returns `intent`, `confidence`, `message`, `message_type`, and `tone`.
- TypeScript maps `intent` -> `reply_intent` and `confidence` -> `reply_intent_confidence`.
- UI reads `row.reply_intent` from the extended `FollowupRow`.
