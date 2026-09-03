import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeLinkedinUrl,
  distributeDeguraLeads,
  previewDeguraRows,
  validateCampaignReadiness,
  validateGuidePdfBytes,
} from "./deguraCampaign";
import * as deguraCampaign from "./deguraCampaign";

const ACCOUNT_ONE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_TWO = "22222222-2222-4222-8222-222222222222";

test("canonicalizes LinkedIn profile URLs for global dedupe", () => {
  assert.equal(
    canonicalizeLinkedinUrl(" http://www.linkedin.com/in/Camilo-Test/?trk=foo "),
    "https://www.linkedin.com/in/camilo-test",
  );
  assert.equal(
    canonicalizeLinkedinUrl("https://linkedin.com/in/J%C3%B6rg-M%C3%BCller/"),
    "https://www.linkedin.com/in/j%c3%b6rg-m%c3%bcller",
  );
  assert.equal(canonicalizeLinkedinUrl("https://linkedin.com/in/not%2Fa-profile"), "");
});

test("accepts only a PDF signature within the asset size boundary", () => {
  assert.equal(validateGuidePdfBytes(new TextEncoder().encode("%PDF-1.7")), true);
  assert.equal(validateGuidePdfBytes(new TextEncoder().encode("not-pdf")), false);
  assert.equal(validateGuidePdfBytes(new TextEncoder().encode("%PDF-1.7"), 5), false);
});

test("balances four priority-ordered leads across both accounts and variants without re-sorting", () => {
  const result = distributeDeguraLeads(
    [
      "https://linkedin.com/in/d",
      "https://linkedin.com/in/b",
      "https://linkedin.com/in/a",
      "https://linkedin.com/in/c",
    ],
    [ACCOUNT_ONE, ACCOUNT_TWO],
    [101, 102],
  );

  assert.deepEqual(result.map((row) => [row.accountId, row.variantId]), [
    [ACCOUNT_ONE, 101],
    [ACCOUNT_TWO, 101],
    [ACCOUNT_ONE, 102],
    [ACCOUNT_TWO, 102],
  ]);
  assert.deepEqual(result.map((row) => row.linkedinUrl), [
    "https://www.linkedin.com/in/d",
    "https://www.linkedin.com/in/b",
    "https://www.linkedin.com/in/a",
    "https://www.linkedin.com/in/c",
  ]);
});

test("normalizes the German HubSpot export and preserves campaign source metadata", () => {
  const normalize = (deguraCampaign as any).normalizeDeguraCsvRecord;
  const result = typeof normalize === "function" ? normalize({
    "Datensatz-ID - Contact": "contact-1",
    Vorname: " Ada ",
    Nachname: " Lovelace ",
    "LinkedIn-URL": "linkedin.com/in/Ada-Lovelace/",
    "Datensatz-ID - Company": "company-1",
    Unternehmensname: " Analytical Engines GmbH ",
    "Letzte Sequenz, in die ein Kontakt aufgenommen war": "837149883",
    "Datum der letzten Aktivität": "2026-08-31 17:18",
  }) : null;

  assert.deepEqual(result, {
    linkedin_url: "linkedin.com/in/Ada-Lovelace/",
    first_name: "Ada",
    last_name: "Lovelace",
    company_name: "Analytical Engines GmbH",
    source_contact_id: "contact-1",
    source_company_id: "company-1",
    source_sequence_id: "837149883",
    source_last_activity_at: "2026-08-31 17:18",
  });
});

test("groups mixed source sequences into A, B and C and orders newest activity first", () => {
  const group = (deguraCampaign as any).groupDeguraRowsByFamily;
  const result = typeof group === "function" ? group([
    { linkedin_url: "https://linkedin.com/in/old", source_sequence_id: "837149883", source_last_activity_at: "2026-08-01 09:00" },
    { linkedin_url: "https://linkedin.com/in/formal", source_sequence_id: "837149889", source_last_activity_at: "2026-08-30 09:00" },
    { linkedin_url: "https://linkedin.com/in/new", source_sequence_id: "837149883", source_last_activity_at: "2026-08-31 09:00" },
    { linkedin_url: "https://linkedin.com/in/guide", source_sequence_id: "836545727", source_last_activity_at: "" },
  ]) : null;

  assert.deepEqual(Object.fromEntries(Object.entries(result || {}).map(([family, rows]) => [
    family,
    (rows as any[]).map((row) => row.linkedin_url),
  ])), {
    A: ["https://linkedin.com/in/new", "https://linkedin.com/in/old"],
    B: ["https://linkedin.com/in/guide"],
    C: ["https://linkedin.com/in/formal"],
  });
});

test("accepts a configured guide URL when no PDF asset is present", () => {
  const result = (validateCampaignReadiness as any)({
    accounts: [
      { browser_slot: 1, daily_invite_limit: 50, daily_message_limit: 50, has_password: true, session_active: true },
      { browser_slot: 2, daily_invite_limit: 50, daily_message_limit: 50, has_password: true, session_active: true },
    ],
    variantCount: 6,
    bookingUrl: "https://calendly.com/degura/demo",
    privacyUrl: "https://www.degura.de/datenschutz",
    guideUrl: "https://www.degura.de/bav-leitfaden-confirmation",
    guideAssetPresent: false,
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.codes, []);
});

test("builds deterministic Du and Sie reply drafts for documented safe routes", () => {
  const buildDraft = (deguraCampaign as any).buildDeguraReplyDraft;
  const informal = typeof buildDraft === "function" ? buildDraft({
    route: "email_request",
    formal: false,
    bookingUrl: "https://example.test/demo",
    guideUrl: "https://example.test/guide",
  }) : null;
  const formal = typeof buildDraft === "function" ? buildDraft({
    route: "existing_bav",
    formal: true,
    bookingUrl: "https://example.test/demo",
    guideUrl: "https://example.test/guide",
  }) : null;
  const noTime = typeof buildDraft === "function" ? buildDraft({
    route: "no_time",
    formal: true,
    bookingUrl: "https://example.test/demo",
    guideUrl: "https://example.test/guide",
  }) : null;

  assert.match(informal || "", /An welche E-Mail-Adresse soll ich dir/);
  assert.match(formal || "", /Den Leitfaden finden Sie hier: https:\/\/example\.test\/guide/);
  assert.match(noTime || "", /30 Minuten/);
});

test("requires exactly two ready accounts and complete campaign config", () => {
  const result = validateCampaignReadiness({
    accounts: [],
    variantCount: 0,
    bookingUrl: "",
    privacyUrl: "",
    guideAssetPresent: false,
  });

  assert.deepEqual(result.codes, [
    "TWO_ACTIVE_ACCOUNTS_REQUIRED",
    "SIX_ACTIVE_VARIANTS_REQUIRED",
    "BOOKING_URL_REQUIRED",
    "PRIVACY_URL_REQUIRED",
    "GUIDE_ASSET_REQUIRED",
  ]);
});

test("preview rejects duplicates, suppressions and missing eligibility confirmation", () => {
  const rows = [
    { linkedin_url: "https://linkedin.com/in/a" },
    { linkedin_url: "https://linkedin.com/in/b" },
  ];
  const result = previewDeguraRows(rows, {
    eligibilityConfirmed: false,
    existingUrls: new Set(["https://www.linkedin.com/in/a"]),
    suppressedUrls: new Set(["https://www.linkedin.com/in/b"]),
  });

  assert.equal(result.canCreateBatch, false);
  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.rejected.map((row) => row.reason), [
    "ELIGIBILITY_CONFIRMATION_REQUIRED",
    "ELIGIBILITY_CONFIRMATION_REQUIRED",
  ]);
});
