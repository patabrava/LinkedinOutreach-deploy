# Katharina COP InMail Campaign — implementation plan

## Scope budget

- Files: one migration, one sender worker, one co-located sender test module, and the required design/plan artifacts.
- LOC/file: sender worker stays below 1,000 LOC; tests remain focused and below 600 LOC; migration below 250 LOC.
- Dependencies: no new dependencies; reuse Playwright, Supabase, and the existing scraper invite adapter.

## Capability map and acceptance criteria

1. Persist `delivery_mode` and `inmail_subject` with a forward migration; the migration is idempotent and preserves current sequences.
2. Resolve and render the campaign’s natural Sie-copy with `{{first_name}}`, `{{last_name}}`, and `{{company_name}}`.
3. Add an account-scoped `--send-inmail-invites` worker mode with strict profile-scoped InMail routing, invite pairing, idempotency, failure persistence, and explicit test override gating.
4. Add failing tests first, then implement the smallest passing vertical slice.
5. Create the Katharina campaign and batch from the 102 profile-ready workbook rows, skipping URL duplicates without altering existing leads.
6. Run the two authorized test sends, read back recipient/account/surface/event evidence, then run the complete sender regression block.

## Debug scopes

- Contract: sequence fields and event metadata.
- Routing: profile target and Sales Navigator composer.
- State: claim, idempotency, test-override non-mutation, failure recovery.
- External: stored Katharina auth, LinkedIn relationship state, exact recipient.

## Real regression block

Run from the isolated worktree with the shared account-scoped auth directory. First run the sender unit/contract suite. Then apply the migration, create/read back the campaign, run only the two explicit lead IDs with `--test-override`, query the resulting events and lifecycle fields, and finally rerun the full sender suite. Do not open the 102-profile queue until the two tests and readback pass.
