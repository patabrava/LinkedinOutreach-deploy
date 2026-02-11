---
name: plan-eye
description: Plan 2+ features as vertical feature-phases with testscripts, environment matrix, observability, and regression gates (EYE constitution)
license: MIT
compatibility: opencode
metadata:
  audience: humans-and-llms
  workflow: feature-phases
  doctrine: eye
---

## What I do

I produce an **EYE Plan** for **2+ features** (or any work requiring sequencing), using:

- Phase Zero: **environment matrix** + **non-functional requirements**
- Feature-phases: **vertical slices**, ordered, with dependencies
- For each phase:
  - deliverable scope
  - implementation boundaries + runtime-validated contracts
  - testscript (identifier, objective, setup, run commands, expected observations, artifact capture points, cleanup)
  - observation checklist (observed vs expected, artifact paths + timestamps, reproducibility)
  - explicit pass/fail gate

I optimize for **immediately-runnable execution** and **debuggability**.

---

## When to use me

Use me when:
- the request contains **2+ features**, OR
- there are dependencies, migration steps, risk of regressions, OR
- the work spans multiple components (UI + API + DB + auth, etc.).

Do NOT use me for a single small refactor or tiny change (implement directly).

---

## Inputs I need (Phase Zero)

If not provided, I will request or infer from repo files:

### Environment Matrix (capture as concrete values)
- OS + arch
- runtime versions (node/python/go/java/etc)
- package manager versions
- build identifiers (commit hash, tag)
- config flags / env vars that matter
- service dependencies (db, redis, external APIs)

### Non-functional Requirements (NFRs)
- latency/throughput targets
- memory ceilings
- reliability thresholds
- security boundaries (authz/authn, data exposure constraints)
- observability requirements (logs/metrics/traces)

---

## Output Format (EYE Plan Template)

### Phase Zero — Context
- Environment Matrix
- NFRs
- Constraints / assumptions
- Risks

### Phase Breakdown (ordered)
For each phase `P{n}`:

#### P{n}: <Phase Name>
**Objective:**  
**Deliverable Scope (vertical slice):**
- UI:
- API:
- Data:
- Validation/Errors:
- Observability:

**Dependencies:**  
**Implementation Boundaries (contracts):**
- Boundary A: input → output contract + validation rules
- Boundary B: ...
- Structured error envelope: `{ status_code, message, context, correlation_id }`

**Testscript**
- **ID:** TS-P{n}-<slug>
- **Objective:**
- **Prerequisites:**
- **Setup (commands):**
- **Run (commands):**
- **Expected Observations (at boundaries):**
  - O1:
  - O2:
- **Artifact Capture Points (exact paths + formats):**
  - logs:
  - screenshots:
  - json dumps:
- **Cleanup:**
- **Known Limitations:**

**Observation Checklist**
- env details confirmed:
- exact steps executed:
- observed vs expected:
- artifacts with timestamps:
- reproducibility rate (e.g., 3/3):

**Pass/Fail Gate**
- PASS if:
- FAIL if:

### Regression Rule (mandatory)
At every new phase gate:
- re-run all prior phase testscripts
- do not advance unless all pass

### Testscripts folder location

- Testscripts: If testscripts need to be created they will be created at `agents/testscripts/`.

---

## Planning Principles (EYE)

- **Vertical slice first:** each phase yields a working capability, not scaffolding.
- **Vanilla-first:** prefer language-native primitives over new frameworks.
- **Locality-first:** co-locate logic/interface/schema/validation together.
- **Instrument boundaries:** correlation IDs + structured errors at edges.
- **Whole-system tests:** run the app, verify behavior end-to-end.
- **Minimal targeted questions:** ask only for the missing artifact needed to decide.

---

## Important hard rules

1. For planning and coding you must always use the LLM_FRIENDLY_ENGINEERING_BACKEND, LLM_FRIENDLY_ENGINEERING_FRONTEND and LLM_FRIENDLY_PLAN_TEST_DEBUG instructions found in `/AGENTS.md` file.


