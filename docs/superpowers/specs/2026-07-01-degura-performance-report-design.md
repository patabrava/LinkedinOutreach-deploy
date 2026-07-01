# Degura Performance Report Dashboard Design

Date: 2026-07-01
Owner: Codex
Audience: Degura Marketing Lead
Target host: `report.deguraleads.de`

## Goal

Create a client-facing German performance report dashboard for Degura. The page should be hosted under the `report` subdomain on the existing Hostinger-backed `deguraleads.de` setup and use the current Mission Control visual style: black and white base, thick borders, uppercase operational labels, red emphasis, yellow highlights, compact data panels, and no new design system.

The dashboard must help Degura understand what has happened since the outreach process started, what kind of messages created positive responses, where the current limits are, and why the next decision should be controlled volume growth.

## Constraints

- Active repo instructions: `AGENTS.md`.
- Bridgecode route: EYE execution through `bridgecode/EYE.md` and `bridgecode/plan-code-debug.md` after this design is accepted.
- Frontend style: reuse `apps/web/app/globals.css` tokens and existing analytics/report UI patterns.
- German writing: client-facing copy is German and should be reviewed with `humanizer-de` in Sachlich mode.
- Data exposure: do not expose raw internal operations or full personal reply dumps. Use aggregate counts, anonymized/paraphrased examples, and strategic interpretation.
- Dependencies: 0 new dependencies.
- File budget: fewer is better.
- LOC budget: keep each touched file under 1000 LOC; split only if a file approaches 2000 LOC.

## Recommended Approach

Build a curated report route instead of exposing the internal `/analytics` page.

Route options:

- Preferred app route: `/reports/degura-performance`.
- Hostinger routing target: `report.deguraleads.de` should resolve to the same app and rewrite or route to the report page.

Access model:

- Use a public-unlisted report link for the first deployment.
- The public page must not show raw personal replies, full names, LinkedIn URLs, lead IDs, stack traces, or operational controls.
- If Degura later asks for stronger privacy, add host-level protection or a simple report token in a follow-up slice.

## Current Evidence Snapshot

Live readback on 2026-07-01 showed:

- Leads in system: 3,186.
- Lead batches: 4.
- Outreach sequences: 4.
- Reply rows: 53.
- Positive replies: 13.
- Negative replies: 40.
- Main sequence: `SEQUENZ B OHNE VERTRAG`.
- Main sequence leads: 1,000.
- Main sequence invites sent: 580.
- Main sequence accepted connections: 273.
- Main sequence messages sent: 274.
- Main sequence replies: 44.
- Main sequence positive replies: 11.
- Main sequence reply rate: 16.1% of sent messages.
- Main sequence positive reply rate: 4.0% of sent messages.
- Main sequence positive share of replies: 25.0%.

Important caveat:

- LinkedIn does not publish a fixed invitation number. For operational planning, the report should use a conservative assumption of about 50 connection requests per account per week, and state that the real limit depends on account health and LinkedIn restrictions.

## Dashboard Structure

### 1. Hero

Title:

`DEGURA OUTREACH PERFORMANCE`

Subtitle:

`LinkedIn-Agentenreport fuer die Degura Marketing-Auswertung`

Required metadata:

- Campaign window.
- Snapshot timestamp.
- Data source label: LinkedIn outreach system / Supabase live snapshot.
- Conservative volume assumption: approximately 50 connection requests per LinkedIn account per week.

Main message:

The campaign has produced a real signal, but the current sample size is still limited by safe LinkedIn invitation volume.

### 2. Executive KPI Strip

Show the primary numbers in existing metric-card style:

- Total leads.
- Main campaign leads.
- Invites sent.
- Accepted connections.
- Messages sent.
- Replies.
- Positive replies.
- Positive reply rate.
- Positive share of replies.

The KPI strip must clarify the denominator for every rate. Do not show a rate without its base.

### 3. Campaign Funnel

Use the existing analytics funnel language but client-safe labels:

- Kontakte im Test.
- Kontaktanfragen gesendet.
- Angenommene Kontakte.
- Erste Nachrichten gesendet.
- Antworten.
- Positive Antworten.

Each step should show count and conversion from the previous relevant step.

### 4. Response Cluster Matrix

Create a section titled:

`Was die Antworten wirklich zeigen`

Cluster actual inbound replies into marketing-relevant themes:

1. Kontextfrage: welcher Arbeitgeber oder welcher Vertrag?
   - Count: 14.
   - Positive: 6.
   - Marketing readout: the hook works, but the old-employer/context bridge needs to be clearer.
   - Copy implication: when possible, include the former employer or explain why Degura is reaching out.

2. Sprachwechsel oder English needed.
   - Count: 7.
   - Positive: 2.
   - Marketing readout: some interested leads are not lost, but German-only copy adds friction.
   - Copy implication: add a short English fallback path for profiles where German is uncertain.

3. Unklarer bAV-Status.
   - Count: 3 in the strict cluster, with additional positive replies showing similar uncertainty.
   - Marketing readout: uncertainty is a real opening. People do not always know whether they use the employer subsidy or how a job switch changed their situation.
   - Copy implication: frame the CTA as a quick status or eligibility check.

4. Naechster Schritt offen.
   - Count: 1 direct meeting-ready reply.
   - Positive: 1.
   - Marketing readout: low volume but high value.
   - Copy implication: keep a low-friction scheduling CTA.

5. Nicht relevant oder Zielgruppen-Mismatch.
   - Count: at least 2 direct mismatch replies, plus multiple negatives caused by country, self-employment, public-sector coverage, already-covered status, or wrong company context.
   - Marketing readout: scaling should improve qualification before adding large volume.
   - Copy implication: refine filters for current country, employment state, and employer context.

6. Klares Desinteresse.
   - Count: 1 direct explicit no-interest reply in the readback.
   - Marketing readout: the campaign is not mainly producing hostile rejection. Many negatives are qualification mismatches or not-relevant-now cases.

### 5. Positive Signal Examples

Show short anonymized/paraphrased examples, not full raw messages:

- A lead asks to continue in English.
- A lead asks which former employer the message refers to.
- A lead says they are unsure about current bAV usage after joining a new company.
- A lead says they do receive an employer pension contribution.
- A lead proposes meeting times.

Each example should include:

- Cluster label.
- Why it matters.
- Suggested follow-up angle.

No full names, LinkedIn URLs, or personal identifiers.

### 6. Copy Learnings

German section title:

`Was wir fuer die naechste Nachricht lernen`

Required conclusions:

- The message triggers relevant questions around employer subsidy and bAV status.
- The context bridge should be clearer.
- A bilingual fallback is worth testing.
- The CTA should focus on checking status or eligibility, not on a broad pension explanation.
- Follow-up copy should handle people who are unsure, outside Germany, self-employed, or already covered differently.

### 7. Volume And Scaling Model

German section title:

`Warum mehr kontrolliertes Volumen noetig ist`

Show a simple planning model:

- 1 account at about 50 invites/week.
- 2 accounts at about 100 invites/week.
- 3 accounts at about 150 invites/week.

State this as planning guidance, not a guaranteed LinkedIn limit.

The section should explain:

- The current positive signal is meaningful but still based on a limited reply count.
- A Marketing Lead needs a larger sample to judge copy performance with confidence.
- Increasing volume should be controlled: more qualified leads, safe per-account sending, and weekly review.

Primary CTA:

`Volumen kontrolliert erhoehen`

CTA text, German, Sachlich:

`Die bisherigen Antworten zeigen echtes Interesse, vor allem bei Personen, die ihre aktuelle bAV-Situation nicht genau einschaetzen koennen oder nach einem Arbeitgeberwechsel unsicher sind. Der limitierende Faktor ist aktuell die verfuegbare Kontaktmenge. Fuer die operative Planung rechnen wir konservativ mit etwa 50 Kontaktanfragen pro LinkedIn-Account und Woche. Um belastbarere Ergebnisse zu bekommen, sollte Degura den naechsten Test mit hoeherem, aber sauber begrenztem Volumen fahren: mehr qualifizierte Kontakte, ein klarer Baseline-Text, eine gezielte Textvariante und eine woechentliche Auswertung nach positiven Antwortmustern.`

During implementation, run this and other German copy through `humanizer-de` Sachlich mode and keep substance intact.

### 8. Next Test Plan

Show three concrete next moves:

1. Increase sending capacity safely.
   - More sender capacity or longer runtime.
   - Keep per-account weekly volume conservative.

2. Run one copy variation against the baseline.
   - Baseline: current `SEQUENZ B OHNE VERTRAG`.
   - Variant: clearer context line plus status-check CTA.

3. Improve qualification before scaling.
   - Prioritize Germany/current employer relevance.
   - Flag English-friendly profiles.
   - Separate self-employed/public-sector/abroad cases.

### 9. Methodology

Short section explaining:

- What the agents did: connection request, post-acceptance message, follow-up/reply review.
- What counts as a positive reply: interest, question, scheduling intent, uncertainty worth continuing, or explicit openness to clarify.
- What counts as negative: no interest, not relevant, wrong geography, already covered, self-employed, or other dead-end response.
- Why the report uses clusters: a Marketing Lead needs patterns, not raw inbox noise.

## Data Flow

Preferred implementation:

- First deployment uses a frozen verified snapshot based on the 2026-07-01 Supabase readback, so the client page is stable and does not expose a public live query surface.
- A small report-specific data helper shapes the exact report contract from the frozen snapshot.
- The page renders a curated dashboard from that contract.
- A later iteration can replace the frozen snapshot with a server-only Supabase query if recurring live reports are needed.

Report contract should include:

- `snapshotAt`.
- `campaignWindow`.
- `kpis`.
- `funnel`.
- `responseClusters`.
- `positiveExamples`.
- `copyLearnings`.
- `volumeModel`.
- `nextTestPlan`.

Errors:

- If Supabase is unavailable on the deployed host, render a client-safe error state.
- Do not expose env names, stack traces, tokens, lead IDs, or raw database errors to the public route.

## Visual Direction

Use existing app style:

- White background.
- Black text.
- Thick black borders.
- Red for critical emphasis or primary CTA.
- Yellow for selected insight highlights.
- Uppercase labels.
- Dense grid layout on desktop.
- Single-column readable stack on mobile.
- No gradients, no stock images, no decorative cards.

The page should feel like the existing app but read as a client report, not an operator console.

## Testing Requirements

Minimum verification:

- TypeScript/build check for the web app.
- Browser check on local dev route.
- Mobile viewport screenshot/check.
- Confirm no raw personal identifiers are displayed.
- Confirm `report.deguraleads.de` resolves to the report page after deployment.
- Confirm deployed page loads without requiring Mission Control auth, unless token protection is intentionally added.

Suggested testscripts:

- `TS-P1-report-contract`: verify report data helper returns all required fields and no raw lead identifiers.
- `TS-P2-report-render`: run local app, open report route, verify hero, KPI strip, cluster matrix, volume model, and CTA.
- `TS-P3-hostinger-route`: verify `report.deguraleads.de` reaches the report route after DNS/proxy deployment.

## Implementation Budget

- Files: 3-5 touched.
- LOC/file:
  - report route/component: 350-650 LOC.
  - report data helper: 200-350 LOC.
  - CSS additions in existing global stylesheet or feature-local CSS: 200-350 LOC.
  - optional test: 80-180 LOC.
- Dependencies: 0.

## Implementation Decisions

1. Access: public-unlisted for the first deployment, because the report will show aggregated and anonymized/paraphrased data only.
2. Data: frozen verified snapshot for the first deployment, using the 2026-07-01 Supabase readback.
3. Routing: configure Hostinger/Traefik so `report.deguraleads.de` reaches the same app and serves `/reports/degura-performance` as the report entrypoint.
4. Privacy: no raw message dumps, personal names, LinkedIn URLs, lead IDs, env details, stack traces, or internal controls on the public report route.
