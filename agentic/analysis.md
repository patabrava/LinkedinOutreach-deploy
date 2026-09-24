# Current State

## Goal and Current State

Add aggregate UTM attribution to every DEGURA guide and Calendly URL at render time. Stored campaign copy and configured destination URLs remain canonical and untagged. The outgoing URL identifies LinkedIn, social traffic, campaign family/source sequence, A/B variant, touch or reply route, link type, and anonymous account slot. It never contains lead, company, LinkedIn-profile, email, or database identifiers.

## Research and User Decision

- Google Analytics recognizes `utm_source`, `utm_medium`, `utm_campaign`, and `utm_content`; values are case-sensitive and should follow one naming convention.
- Calendly records the same UTM values with a booking and exposes them in filters/exports.
- The live DEGURA guide page accepts query parameters and currently loads GA4, GTM, and HubSpot.
- The user selected UTM-only aggregate attribution. Individual click redirects and lead-level identifiers are out of scope.

## Tracking Contract

- `utm_source=linkedin`
- `utm_medium=social`
- `utm_campaign=degura_a_837149883`, `degura_b_836545727`, or `degura_c_837149889`
- `utm_content` uses lowercase underscore tokens: `v<variant>_<touch-or-reply-context>_<guide-or-booking>_slot<1-or-2>`
- Existing query parameters are preserved; existing UTM keys are deterministically replaced; fragments remain last.
- Only managed `DEGURA_A/B/C` messages are tagged. Legacy sequences remain unchanged.

## Completed Production Checklist

- [x] TypeScript tests cover deterministic UTM URL construction, existing-query replacement, fragments, PII exclusion, and tracked reply drafts.
- [x] Python tests cover the same URL semantics for managed variants, every stored sequence-message field, and anonymous account slots.
- [x] TypeScript reply drafts receive campaign, variant, source touch, reply route, link type, and account slot at render time.
- [x] Python sequence rendering hydrates campaign, variant, guide/booking URLs, and account slot before producing outbound copy.
- [x] Stored copy and configured base URLs remain untagged; legacy non-DEGURA sequences remain unchanged.
- [x] Direct-message sanitization preserves URL substrings byte-for-byte.
- [x] The full non-sending regression block passed, including Python, TypeScript, Next.js production build, and disposable PostgreSQL checks.
- [x] A production-function acceptance probe validated all eight URL occurrences in stored A/B variant messages; C guide/booking reply routes are covered by the TypeScript contract.

## Locality Budget

`{files: 5 existing files, LOC/file: approximately 20-90 changed lines each, deps: 0}`

Files: `apps/web/lib/deguraCampaign.ts`, its adjacent test, `apps/web/app/actions.ts`, `workers/sender/sender.py`, and its adjacent sequence-message test. No schema migration or frontend redesign is needed.

## Final Regression Block

Run `./agentic/testscripts/two-account-degura-smoke.sh`. Pass requires all Python and TypeScript tests, production Next.js build, and disposable PostgreSQL idempotency checks to exit zero, followed by static inspection proving only aggregate UTM tokens are emitted.

## Execution Status

Implementation and local verification are complete. No LinkedIn message, booking, deployment, or persistent Supabase mutation was performed. The mixed worktree remains preserved and no integration action has been taken.

## Remaining Work

No active implementation work. The completed, non-deployed campaign implementation is intended for publication on `main`; verify the exact remote commit from Git after publishing.
