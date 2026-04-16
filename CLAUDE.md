# CLAUDE.md

Companion to `AGENTS.md`. AGENTS.md is authoritative for:
- **§0 Locality envelope** (vanilla-first, file/LOC/dep budgets, explicit `{files, LOC/file, deps}` per plan)
- **§1 Role routing** (bridgecode: `INSTRUCT` / `LIRA` / `EYE`, and the `LLM_FRIENDLY_*` blocks for backend / frontend / plan-test-debug)
- **§2 Specific repo rules** (CSV import, outreach mode normalization, `run_all.sh` port/cache hygiene, follow-up sender semantics, sequence placeholder rules, etc.)

When AGENTS.md and CLAUDE.md conflict, **AGENTS.md wins**. This file adds two things AGENTS.md doesn't cover: product-facing design context, and short Claude-specific behavioral rails that reinforce AGENTS.md §0.

---

## Design Context

### Users
Small internal team (2–5 operators) running LinkedIn outreach. Sophisticated power users who live in this tool daily. Context of use: batch uploads, reviewing drafts, approving sends, scanning inbox replies, managing follow-ups. Job-to-be-done: move leads through a state machine as fast as possible with confidence that the right thing is being sent at the right time.

### Brand Personality
Raw. Rebellious. Distinctive. The interface should feel like a cockpit for someone who knows what they're doing — no hand-holding, no friendly onboarding fluff. Three words: **assertive, honest, mechanical**. Emotional goals: operator feels in control and trusts the machine. Zero corporate polish.

### Aesthetic Direction
**Brutalist — locked.** Space Mono monospace, black/white/red/yellow only, 3px hard borders, zero border-radius, uppercase labels, no shadows, no gradients, no glass. This is the concrete execution of AGENTS.md's `LLM_FRIENDLY_ENGINEERING_FRONTEND` blacklist (no Inter/Roboto, no purple-white gradients, no safe centered hero, no generic card grids).

Anti-references (explicit):
- Generic SaaS (Linear/Stripe/Vercel clones — too polished, too safe)
- LinkedIn itself (no blue, no rounded corners, no profile-card UI)
- AI-slop dashboards (no gradient metrics, no glassmorphism, no hero stats)
- Enterprise CRM (no dense gray form walls, no Salesforce density)

### Design Principles
1. **Brutalism is a commitment, not a style** — every element earns its borders. No soft edges anywhere. If it looks "nice," it's probably wrong.
2. **Density over whitespace** — power users want information, not breathing room. Tables are king; cards are suspect.
3. **State transitions must be loud** — statuses, sends, approvals need visible, unambiguous feedback. Red = acted / success. Black solid = committed. Black dashed = error. Yellow = attention / in-progress.
4. **Monospace discipline** — every measurement/ID/status reads cleanly in Space Mono. If it looks bad in mono, it's bad data.
5. **No redundant chrome** — no heroes, no intro paragraphs restating page titles, no decorative icons. Labels do the work.

### Token Vocabulary (current)
`--bg` `--fg` `--accent` `--highlight` `--muted` `--border-*` `--space-xs..xl` `--row-alt` `--success` (= accent) `--error` (= fg, apply with `border-style: dashed`) `--neutral-200`. Utility classes: `.page-title`, `.dashboard-grid`, `.action-stack`, `.status-chip`, `.status-*` modifiers. Do not introduce new palette hex values.

---

## Working Principles

Short version of the Karpathy guidelines ([source](https://x.com/karpathy/status/2015883857489522876)), framed to reinforce AGENTS.md §0 and the `LLM_FRIENDLY_PLAN_TEST_DEBUG` block. For trivial tasks, use judgment — these bias toward caution.

### 1. Think before coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, surface them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- When something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first
Minimum code that solves the problem. Nothing speculative. This is AGENTS.md §0 in four bullets:
- No features beyond what was asked.
- No abstractions for single-use code (respect the rule of three before promoting to shared).
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you wrote 200 lines and it could be 50, rewrite it.

Test: *"Would a senior engineer say this is overcomplicated?"* If yes, simplify.

### 3. Surgical changes
Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken.
- Match existing style, even if you'd do it differently.
- Notice unrelated dead code → mention it, don't delete it.
- Remove imports/variables YOUR changes orphaned; leave pre-existing dead code unless asked.

Test: *every changed line should trace directly to the user's request.*

### 4. Goal-driven execution
Define success criteria. Loop until verified. This mirrors AGENTS.md's `LLM_FRIENDLY_PLAN_TEST_DEBUG` testscript discipline:
- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- "Refactor X" → ensure tests pass before and after.

For multi-step tasks, state a brief plan with a `verify:` check per step.

---

## Quick pointers
- Before a Plan: state `{files, LOC/file, deps}` per AGENTS.md §0.
- Before touching Supabase / sender / scraper: re-read the matching bullets in AGENTS.md §2.
- Before adding a new package: confirm 0-deps-default; justify if >0.
- Before a UI change: re-read Design Context above + Aesthetic Direction; confirm it doesn't introduce an AI-slop tell.
