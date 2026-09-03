"use client";

import { useFormState, useFormStatus } from "react-dom";

import {
  saveDeguraCampaignSettings,
  type DeguraCampaignSettingsState,
} from "../app/actions";

const INITIAL_STATE: DeguraCampaignSettingsState = { success: false };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" disabled={pending}>
      {pending ? "VALIDATING…" : "SAVE CAMPAIGN CONFIG"}
    </button>
  );
}

export function DeguraCampaignSettingsForm({
  bookingUrl,
  privacyUrl,
  guideUrl,
  guideAssetPath,
}: {
  bookingUrl: string;
  privacyUrl: string;
  guideUrl: string;
  guideAssetPath: string;
}) {
  const [state, action] = useFormState(saveDeguraCampaignSettings, INITIAL_STATE);
  return (
    <form className="card" action={action}>
      <div className="pill">DEGURA Campaign</div>
      <h3 className="section-title-tight">ACTIVATION CONFIG</h3>
      <p className="muted">Applied atomically to families A, B and C. A new PDF replaces the current campaign asset.</p>
      <label htmlFor="degura-booking-url">BOOKING URL</label>
      <input className="input" id="degura-booking-url" name="booking_url" type="url" defaultValue={bookingUrl} required style={{ marginBottom: 16 }} />
      <label htmlFor="degura-guide-url">GUIDE URL</label>
      <input className="input" id="degura-guide-url" name="guide_url" type="url" defaultValue={guideUrl} required style={{ marginBottom: 16 }} />
      <label htmlFor="degura-privacy-url">PRIVACY URL</label>
      <input className="input" id="degura-privacy-url" name="privacy_url" type="url" defaultValue={privacyUrl} required style={{ marginBottom: 16 }} />
      <label htmlFor="degura-guide-pdf">GUIDE PDF · MAX 10 MB</label>
      <input className="input" id="degura-guide-pdf" name="guide_pdf" type="file" accept="application/pdf,.pdf" style={{ marginBottom: 8 }} />
      <div className="muted" style={{ fontSize: 11, marginBottom: 18 }}>
        {guideAssetPath ? `CURRENT OPTIONAL ASSET: ${guideAssetPath}` : "URL DELIVERY ACTIVE · NO OPTIONAL PDF STORED"}
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <SaveButton />
        {state.success ? <span className="muted">SAVED.</span> : null}
        {state.error ? <span style={{ color: "var(--accent)" }}>{state.error}</span> : null}
      </div>
    </form>
  );
}
