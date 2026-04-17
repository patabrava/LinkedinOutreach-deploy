# LinkedIn Auth Session UX — Design

Date: 2026-04-17
Status: Draft

## Goal

Make LinkedIn authentication legible to operators at all times. The UI must clearly answer:

1. Are LinkedIn credentials saved?
2. Is there a usable cached session now?
3. Do I need to log in again before scraping?

The current flow hides that distinction behind a single `auth.json` cache and a generic “login window launched” message. That is the core usability gap.

## Non-Goals

- Replacing Playwright authentication with a different auth mechanism.
- Changing LinkedIn scraping behavior beyond the auth checks needed for clearer state.
- Storing LinkedIn secrets anywhere new.
- Predicting exact session lifetime. LinkedIn expiration is not deterministic, so the UI should surface verification results rather than pretend to know a fixed expiry.

## Recommendation

Use a single “LinkedIn Session” status card in the web UI backed by a small auth-status contract from the scraper side.

The card should show:

- A state label, such as `No credentials`, `Credentials saved`, `Session active`, `Session expired`, or `Login required`.
- A short explanation in plain language.
- The last successful verification time.
- The last login attempt time and result.
- A primary action that changes with state:
  - `Save credentials`
  - `Log in to LinkedIn`
  - `Recheck session`
  - `Reconnect session`
- A secondary action:
  - `Test session now`

This gives the user one place to look and one place to act.

## Why This Is the Best UX

- It separates `credentials saved` from `session usable`, which are currently conflated.
- It removes the ambiguity of `auth.json exists` versus `LinkedIn is actually logged in`.
- It tells the user when they need to do something now, not just whether a file exists.
- It lets the scraper refresh the UI state automatically after login and after failed verification.

## Alternatives Considered

### Option A: File-based only

Show whether `auth.json` exists and stop there.

- Pros: minimal changes.
- Cons: not user-friendly. Presence of a file does not tell the user whether scraping will work.

### Option B: Separate credentials and session indicators

Show `Credentials saved` and `Session active` as two independent badges.

- Pros: accurate and easy to understand.
- Cons: still slightly abstract unless the UI explains what to do next.

### Option C: Single status card with action-specific CTAs

Show a single state, explanation, last verified time, and a changing primary action.

- Pros: most legible for operators, least cognitive load.
- Cons: requires one additional backend status endpoint or server action.

Recommended: **Option C**.

## State Model

The UI should derive its display from a small status object, not from raw file checks.

Suggested shape:

```ts
type LinkedinAuthStatus = {
  credentialsSaved: boolean;
  sessionState: "no_credentials" | "credentials_saved" | "session_active" | "session_expired" | "login_required";
  authFilePresent: boolean;
  lastVerifiedAt: string | null;
  lastLoginAttemptAt: string | null;
  lastLoginResult: "success" | "failed" | "verification_required" | null;
  lastError: string | null;
};
```

Rules:

- `credentialsSaved` means the user has stored email/password in Supabase settings.
- `authFilePresent` means the local Playwright storage state exists on the worker host.
- `session_active` means the scraper has recently verified LinkedIn access successfully.
- `session_expired` means the cache exists but the verification check failed.
- `login_required` means the cache is absent or invalid and the scraper must open LinkedIn again.

The UI should not infer “good enough” from file presence alone.

## Architecture

Keep the implementation localized to the current scraper/auth flow and the settings UI.

### Web App

- Extend the settings page to render a dedicated LinkedIn session card.
- Fetch the auth status from the server side so the page can display the current state on load.
- Keep the existing credentials form, but place it under the status card so it is clearly a setup step, not the whole story.

### Scraper Worker

- Add a lightweight auth status probe that checks whether the current Playwright context is authenticated.
- Persist a non-secret status summary after successful login, failed verification, or missing-session detection.
- Reuse the same login flow for first-time setup and re-login after expiration.

### Shared Contract

- Use one status shape and one set of state labels across the web app and scraper worker.
- Do not introduce a second “auth truth” elsewhere in the system.

## User Flow

### First-time setup

1. User opens Settings.
2. The card shows `No credentials`.
3. User enters LinkedIn email and password.
4. UI shows `Credentials saved`.
5. User clicks `Log in to LinkedIn`.
6. A browser window opens, login completes, and the card updates to `Session active`.

### Normal reuse

1. User returns later.
2. The card shows `Session active`.
3. The card also shows `Last verified: ...`.
4. User can scrape without taking extra action.

### Session expiration

1. Cached session exists but LinkedIn rejects it.
2. The scraper detects the failure.
3. The card flips to `Session expired` or `Login required`.
4. The primary CTA becomes `Reconnect session`.
5. User can immediately relaunch login.

## Copy And Labels

Keep the language direct and non-technical.

Recommended strings:

- Title: `LinkedIn Session`
- State labels:
  - `No credentials`
  - `Credentials saved`
  - `Session active`
  - `Session expired`
  - `Login required`
- Helper text examples:
  - `Credentials are saved, but LinkedIn has not been verified yet.`
  - `Session is active and cached on this worker.`
  - `LinkedIn rejected the cached session. Please reconnect.`
  - `Last verified 2 hours ago.`
- Primary CTA examples:
  - `Save credentials`
  - `Log in to LinkedIn`
  - `Reconnect session`
  - `Recheck session`

Avoid exposing `auth.json` as the primary concept in the UI copy. It is an implementation detail.

## Data Flow

```text
Settings page
  -> fetch saved credentials summary
  -> fetch auth status summary
  -> render current state + next action

Start login action
  -> launch Playwright login window
  -> on success, save storage state
  -> write status summary
  -> recheck session
  -> return updated state to the UI

Scraper start
  -> load cached storage if present
  -> verify session
  -> if valid, continue
  -> if invalid, mark session expired and require login
```

## Error Handling

The auth UX should make failure obvious without being noisy.

| Situation | UI state | User message |
|---|---|---|
| No saved credentials | `No credentials` | `Add your LinkedIn email and password first.` |
| Credentials saved, no cached session | `Credentials saved` | `Login is still required before scraping.` |
| Cached session works | `Session active` | `You are ready to scrape.` |
| Cached session rejected | `Session expired` | `Please reconnect LinkedIn.` |
| Login window launched | transient | `Complete login in the browser window.` |
| Login verification fails | `Login required` | `LinkedIn did not accept the cached session.` |

If verification fails, the UI should preserve the last known good timestamp and the error reason so the user can understand whether this is a fresh setup issue or a session expiry.

## Testing

Validate both the UX and the state transitions.

1. Load Settings with no credentials saved.
2. Save credentials and confirm the card updates to `Credentials saved`.
3. Launch login and confirm the browser window opens.
4. Complete login and confirm the card updates to `Session active`.
5. Restart the scraper process and confirm the session is still reported correctly.
6. Force a stale or invalid session and confirm the card flips to `Session expired` or `Login required`.
7. Confirm the UI never requires the user to inspect `auth.json` to know what happened.

## Budget

- **Files:** keep changes small and localized, ideally 4 to 6 files total.
- **LOC/file:** aim for under 200 LOC per edited file.
- **Deps:** 0 new dependencies.

## Open Questions

None blocking. The remaining implementation choice is whether the auth-status check lives in a new API route or in an existing server action. Either is acceptable as long as the UI gets a single authoritative status object.
