# Current State

## Goal

Publish campaign-isolated analytics for the current DEGURA outreach: one overview for the regular A/B/C sequences and one for the COP Sales Navigator campaign.

## Implemented Contract

- `/analytics` is the authenticated campaign index and retains the historical all-outreach dashboard below it.
- `/analytics/regular` covers exact triples for Batches 30/31/32 and Sequences 7/8/9.
- `/analytics/sales-navigator` covers the exact Batch 33 / Sequence 10 Sales Navigator scope.
- Server queries validate batch, sequence, account ownership, and delivery mode before loading leads.
- Activity and outcomes come only from immutable `outreach_events`; booking and attendance values require their own persisted events.
- The selected 7/30/90-day window limits activity events, while cohort size and current lead statuses describe the exact campaign batches.
- The interface preserves the existing Mission Control design system and adapts through desktop and mobile layouts.

## Validation

- 68 web regression tests pass, including new exact-scope, cross-join exclusion, persisted-outcome, and page-authentication checks.
- Changed TypeScript files pass focused ESLint.
- The production Next.js build passes with the repository's `--no-lint` production command; the unscoped default build remains blocked by the pre-existing global lint backlog.
- Authenticated browser acceptance passes for the index and both campaign pages with no console warnings or errors.
- Live Supabase readback during browser acceptance showed 2,015 leads across regular A/B/C and 102 COP leads with 101 verified first touches, 4 replies, and a 4.0% recorded reply rate.

## Locality Budget

`{files: 8 implementation/test files plus this canonical ledger and one prevention-rule update, LOC/file: all changed/new files under 2,000, deps: 0}`

## Remaining Work

Commit the reviewed paths only, push the release branch, deploy the repo-backed revision to the existing Hostinger VPS project without replacing environment or persistent volumes, and verify the authenticated live routes.
