---
name: debug-eye
description: Debug via systematic isolation-- classify boundary, build minimal reproducer, one-hypothesis/one-variable iterations, smallest local fix, regression guard (EYE constitution)
license: MIT
compatibility: opencode
metadata:
  audience: humans-and-llms
  workflow: isolation-debugging
  doctrine: eye
---

## What I do

I break “fix-retry loops” by forcing a disciplined debug pipeline:

1. **Classify** the defect to a boundary category.
2. **Isolate** with a minimal reproducer (no semantic changes).
3. **Instrument first** (correlation IDs, boundary logs) before modifying code.
4. Iterate with **one hypothesis + one variable** per attempt.
5. Validate in isolation, then apply **smallest most-local fix** to the real system.
6. Prove with reproducer → full testscript.
7. Add a **regression check** to prevent recurrence.
8. Cleanup temporary harnesses.

I also request **minimal targeted artifacts** (exact commands, exact paths, exact formats).

---

## When to use me

Use me when:
- a bug was not fixed after **one turn**, OR
- the failure is intermittent/flaky, OR
- the system behavior is unclear and needs isolation.

---

## Defect Boundary Classification (pick one first)

- environment mismatch
- dependency drift
- configuration gap
- contract mismatch
- stateful side-effect
- timing race
- resource limit
- filesystem semantic
- network factor
- clock timeout
- data corruption
- test-production divergence

State the chosen boundary and the evidence that supports it.

---

## Debug Output Format (EYE Debug Template)

### 1) Defect Snapshot
- **Title:**
- **Severity:**
- **Frequency:** (always / intermittent / 1-of-n)
- **Phase impacted:**
- **Environment Matrix:** (OS, runtime versions, commit/build)
- **Reproduction Steps:** (exact)
- **Observed vs Expected:**

### 2) Boundary Classification
- **Suspected boundary:**
- **Why (evidence):**
- **What would falsify this hypothesis:**

### 3) Minimal Reproducer (Isolation Harness)
Goal: isolate the failing behavior without changing semantics.

- **Reproducer ID:** R-<slug>
- **Setup command(s):**
- **Run command:**
- **Expected observation:**
- **Artifact capture points:**
  - logs path:
  - dumps path:
  - timestamps:

### 4) Instrumentation (before edits)
Add/enable:
- correlation IDs across boundaries
- structured error envelope `{ status_code, message, context, correlation_id }`
- boundary logs at entry/exit and error paths

### 5) One Hypothesis / One Variable Iteration
For iteration `i`:
- **Hypothesis:**
- **Single change:**
- **Validation command:**
- **Expected observation:**
- **Result:** (pass/fail + artifact refs)

Stop after **two failed iterations** and request **new specific observations**.

### 6) Smallest Local Fix (after isolation proof)
- **Patch scope:** smallest possible
- **Why it fixes the boundary:**
- **Verify:** reproducer → full application testscript

### 7) Regression Guard
Add:
- a testscript step, assertion, or check
- ensure it runs at the relevant phase
- stabilize flaky checks (flake = critical)

### 8) Cleanup
Remove temporary harnesses or mark them clearly as debug-only fixtures.

---

## Minimal Targeted Data Requests (rules)

When evidence is insufficient, request ONLY what’s needed, like:
- exact command to run
- exact file path to attach
- exact log segment boundaries
- exact output format (txt/json)
- exact timestamp range

Avoid broad “send everything” requests.

---

## Failure report

When you fail at debugging after isolating the issue, create a `failure_report.md` in `agents/testscripts/` explaining why it failed and what the human in the loop should test, research or any relevant action to break the loop.


---

## Important hard rules

1. For debugging and coding you must always use the LLM_FRIENDLY_ENGINEERING_BACKEND, LLM_FRIENDLY_ENGINEERING_FRONTEND and LLM_FRIENDLY_PLAN_TEST_DEBUG instructions found in `/AGENTS.md` file.

---

## When planning isolation

If root cause is obvious, modify core code without issues, but if root cause of issues is not obvious, run isolation debugging before modifying core code. 