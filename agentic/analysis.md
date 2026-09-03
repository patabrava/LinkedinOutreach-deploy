# Active Work

## Goal and State

Deploy the production DEGURA A/B/C campaign from `degura-linkedin-sequenzen.md`, import the mixed HubSpot export under `new_leads/`, preserve CRM source tracking, route documented replies, and retain two-account isolation. Production schema/configuration is migrated and 4,028 accepted leads are imported in three paused batches. The app and both account browser containers are healthy with background workers explicitly disabled. Live noVNC inspection shows both production browser profiles at LinkedIn login, so launch remains blocked on two account sign-ins. No outreach event was recorded and no campaign message was sent.

## Confirmed Contract

- Source `837149883` maps to A Rentenreform Du, `836545727` to B bAV Leitfaden Du, and `837149889` to C bAV Leitfaden Sie.
- The supplied CSV contains 4,030 rows. Production dry-run accepts 4,028 unique valid LinkedIn profiles: 2,087 A, 985 B, and 956 C; one duplicated URL and one malformed profile slug are rejected. Company names come from `Unternehmensname`; HubSpot contact/company IDs and last activity are retained.
- Newest source activity receives priority before deterministic 2-account x 2-variant assignment.
- Calls use 30 minutes. B1 intentionally shares the guide link before consent; B2 remains the ask-first control.
- Both active accounts have daily invite and message limits of 50. Sandra Molinero is stored for the matching account only; the other authenticated identity is not relabeled.
- Safe documented replies receive deterministic Du/Sie drafts. Price, competitor, legal/privacy, angry, unclear, unsupported-language, second-factual, and asset-follow-up cases remain human-only. Every inbound DEGURA reply stops scheduled touches before drafting.
- Full implementation authorizes deployment and a paused import, not starting workers or sending messages.

## Locality Budget

`{files: existing campaign/account vertical slice plus 4 migrations and one smoke script, LOC/file: new focused files under 300 and localized changes in existing large workers/actions, deps: 0}`

## Regression Evidence

- Python DEGURA/reply tests and 109 existing sender safety tests pass, including managed variant/company rendering.
- TypeScript campaign, analytics, sequence, follow-up, report, and worker tests pass; `tsc --noEmit` and the production Next.js build pass.
- Shell syntax and Docker Compose validation pass.
- Migrations 019-022 apply twice in PostgreSQL 16; the transactional mixed A/B/C import contract passes with paused rows and source metadata.
- Full acceptance command: `./agentic/testscripts/two-account-degura-smoke.sh`; result: `PASS: two-account DEGURA non-sending regression block`.
- The same acceptance block now also builds and boots the remote-browser image against deliberately stale Chromium singleton links, verifies CDP port readiness, and asserts production remains web-only without explicit worker opt-in.
- A production dry-run confirmed Unicode LinkedIn profile slugs are safely canonicalized and the accepted allocation is balanced 2,015 / 2,013 across slots before atomic import.
- Production readback confirms batches 30/31/32 contain 2,087/985/956 leads; all 4,028 rows are `NEW`, all are campaign-paused, all contain a company, A/B/C variants are split 1,044/1,043, 493/492, and 478/478, and the imported cohort has zero outreach events.
- Production migrations 021 and 022 are applied. Readback confirms two active account slots, six active variants, 50/50 limits, all three campaign URLs, and the atomic import RPC.

## Remaining Work

Publish and deploy the authenticated noVNC proxy-path correction, then verify anonymous browser routes fail closed and the public login remains healthy. Before launch, sign in both production LinkedIn browser slots and replace the configured guide URL: live readback currently resolves it to a DEGURA event page rather than the promised guide. Authenticated UI verification requires an operator magic-link session.
