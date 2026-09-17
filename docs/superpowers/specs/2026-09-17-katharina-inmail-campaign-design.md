# Katharina COP InMail Campaign

## Goal

Create a reusable Katharina campaign for the 102 workbook rows that contain a LinkedIn profile URL. Each eligible lead gets a first-touch InMail and a connection request in the same account-scoped worker flow. The campaign is created in Supabase and remains paused from automatic execution until the two named test sends are verified.

## Approved decisions

- Sender: the active Katharina account in browser slot 1.
- Source: `Kontakte` in `COP_Faelle_fuer_LinkedIn_enriched_scraped_aiark.xlsx`; rows without `LinkedIn Profil` are excluded.
- Employer personalization: `Unternehmen` is rendered as the former employer.
- Copy: German Sie-Ansprache, a neutral full-name greeting, and the approved case-note substance. The subject is `Ihre betriebliche Altersvorsorge`.
- Delivery: first-touch InMail plus a no-note connection request. The InMail is sent first because it does not require an accepted connection; the invite is attempted afterward.
- Testing: Camilo Echeverri and Isaac Fine are explicit, lead-id-scoped override targets. Their existing production history is not rewritten and they are not used as queue examples.

## Data contract

`outreach_sequences` gains `delivery_mode` and `inmail_subject`. The new sequence uses `delivery_mode = invite_and_inmail`, `tone = sie`, and the three stored message templates. Leads continue to use canonical `outreach_mode = connect_message`; the new delivery mode is selected from the assigned sequence, so existing invite and message-only queues cannot pick this campaign accidentally.

The campaign batch is account-owned, sequence-owned, and imported only for normalized profile URLs. Existing global profile-url uniqueness is respected: a workbook row already represented by a lead is reported as skipped instead of being duplicated or reassigned.

## Worker behavior

The new explicit CLI mode is `--send-inmail-invites`. A normal batch run selects only unstarted, unpaused rows assigned to a sequence with `invite_and_inmail`. It atomically claims a lead before opening LinkedIn. It opens the profile-scoped message action, requires the Sales Navigator/InMail composer, fills the exact subject and rendered body, and uses the existing scoped send verification. It then reopens the exact profile and runs the existing connection-request helper.

InMail and invite outcomes are recorded as immutable `touch_sent` and `invite_sent` events with `surface`, `delivery_mode`, `test_override`, and correlation metadata. A second run must not resend an already recorded InMail. If InMail succeeds but the invite fails, the lead is left in a visible failed state with the InMail event preserved for invite-only recovery; no duplicate InMail is attempted.

Test overrides require both `--lead-id` and `--test-override`, are restricted to the configured Katharina account, and bypass only the queue eligibility/history gates. They still require exact profile URL navigation, composer routing, full-body send completion, and relationship probing. Existing lead status, sequence ownership, timestamps, and reply-stop state are not rewritten; only test events are appended.

## Failure and safety boundaries

- Never fall back from an InMail composer to a direct-message composer.
- Never use a global Messages navigation target; the target must be inside the profile container.
- Never send to a row without a normalized LinkedIn URL.
- Never allow the new sequence into standard `connect_message`, `message-only`, or follow-up queues.
- Capture a full-page screenshot and persist a failure for profile, composer, subject/body, or invite verification failures.
- The existing sender account and credential/session isolation remain authoritative.

## Verification

- Pure contract tests cover delivery-mode selection, natural template rendering, test-override gating, idempotency, and outcome classification.
- Existing sender routing tests remain green.
- A Supabase readback confirms the new sequence, batch, candidate counts, and account ownership.
- Two live test runs target only Camilo Echeverri and Isaac Fine and read back exact `outreach_events` metadata and unchanged lead lifecycle fields.
- The full worker regression block is rerun before handoff.

## Non-goals

This change does not automatically send the stored reminder messages. The existing follow-up sender is direct-message-only by design; reminder InMails need a separate explicit follow-up surface and approval flow.
