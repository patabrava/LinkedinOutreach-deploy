import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeLinkedinUrl,
  distributeDeguraLeads,
  previewDeguraRows,
  validateCampaignReadiness,
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

test("accepts a configured guide URL", () => {
  const result = (validateCampaignReadiness as any)({
    accounts: [
      { browser_slot: 1, daily_invite_limit: 50, daily_message_limit: 50, has_password: true, session_active: true },
      { browser_slot: 2, daily_invite_limit: 50, daily_message_limit: 50, has_password: true, session_active: true },
    ],
    variantCount: 6,
    bookingUrl: "https://calendly.com/degura/demo",
    privacyUrl: "https://www.degura.de/datenschutz",
    guideUrl: "https://www.degura.de/bav-leitfaden-confirmation",
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.codes, []);
});

test("requires the guide URL", () => {
  const result = (validateCampaignReadiness as any)({
    accounts: [
      { browser_slot: 1, daily_invite_limit: 50, daily_message_limit: 50, has_password: true, session_active: true },
      { browser_slot: 2, daily_invite_limit: 50, daily_message_limit: 50, has_password: true, session_active: true },
    ],
    variantCount: 6,
    bookingUrl: "https://calendly.com/degura/demo",
    privacyUrl: "https://www.degura.de/datenschutz",
    guideUrl: "",
  });

  assert.equal(result.ready, false);
  assert.deepEqual(result.codes, ["GUIDE_URL_REQUIRED"]);
});

test("builds canonical aggregate DEGURA UTM URLs without personal identifiers", () => {
  const buildTrackedUrl = (deguraCampaign as any).buildDeguraUtmUrl;
  const result = typeof buildTrackedUrl === "function" ? buildTrackedUrl(
    "https://www.degura.de/bav-leitfaden-confirmation?lang=de&utm_source=old#download",
    {
      campaignKey: "DEGURA_B",
      variantKey: 2,
      context: "Touch 2 / Reply Guide",
      linkType: "guide",
      accountSlot: 1,
    },
  ) : null;

  assert.equal(
    result,
    "https://www.degura.de/bav-leitfaden-confirmation?lang=de&utm_source=linkedin&utm_medium=social&utm_campaign=degura_b_836545727&utm_content=v2_touch_2_reply_guide_slot1#download",
  );
  assert.doesNotMatch(String(result), /camilo|linkedin\.com\/in|company|contact-/i);
});

test("builds deterministic Du and Sie reply drafts for documented safe routes", () => {
  const buildDraft = (deguraCampaign as any).buildDeguraReplyDraft;
  const campaignA = typeof buildDraft === "function" ? buildDraft({
    campaignKey: "DEGURA_A",
    route: "appointment",
    firstName: "Camilo",
    companyName: "THE HUB DAO",
    bookingUrl: "https://example.test/demo",
    guideUrl: "https://example.test/guide",
    variantKey: 1,
    sourceTouch: "first_message",
    accountSlot: 2,
  }) : null;
  const campaignB = typeof buildDraft === "function" ? buildDraft({
    campaignKey: "DEGURA_B",
    route: "guide",
    firstName: "Camilo",
    companyName: "THE HUB DAO",
    bookingUrl: "https://example.test/demo",
    guideUrl: "https://example.test/guide",
    variantKey: 2,
    sourceTouch: "second_message",
    accountSlot: 1,
  }) : null;
  const campaignC = typeof buildDraft === "function" ? buildDraft({
    campaignKey: "DEGURA_C",
    route: "existing_bav",
    firstName: "Camilo",
    companyName: "THE HUB DAO",
    bookingUrl: "https://example.test/demo",
    guideUrl: "https://example.test/guide",
    variantKey: 1,
    sourceTouch: "first_message",
    accountSlot: 2,
  }) : null;
  const campaignCGuide = typeof buildDraft === "function" ? buildDraft({
    campaignKey: "DEGURA_C",
    route: "guide",
    firstName: "Camilo",
    companyName: "THE HUB DAO",
    bookingUrl: "https://example.test/demo",
    guideUrl: "https://example.test/guide",
    variantKey: 2,
    sourceTouch: "third_message",
    accountSlot: 1,
  }) : null;
  const noTime = typeof buildDraft === "function" ? buildDraft({
    campaignKey: "DEGURA_A",
    route: "no_time",
    firstName: "Camilo",
    companyName: "THE HUB DAO",
    bookingUrl: "https://example.test/demo",
    guideUrl: "https://example.test/guide",
    variantKey: 1,
    sourceTouch: "first_message",
    accountSlot: 2,
  }) : null;

  assert.equal(campaignA,
    "Sehr gern, Camilo. Du kannst dir gerne hier einen Termin mit unserem bAV Experten Toby buchen: https://example.test/demo?utm_source=linkedin&utm_medium=social&utm_campaign=degura_a_837149883&utm_content=v1_touch2_reply_appointment_booking_slot2");
  assert.equal(campaignB,
    "Sehr gern, Camilo. Hier ist er: https://example.test/guide?utm_source=linkedin&utm_medium=social&utm_campaign=degura_b_836545727&utm_content=v2_touch3_reply_guide_slot1\n\nWenn du beim Lesen an einer Stelle hängen bleibst, schreib mir einfach. Ich beantworte gerne alle Fragen und freue mich auf den Austausch.");
  assert.equal(campaignC,
    "Das ist eine gute Ausgangslage, Camilo, und häufiger die Ausnahme als die Regel.\n\nZwei Fragen sind dann meistens aufschlussreicher als die nach dem Anbieter: Wie hoch ist die Beteiligungsquote in Ihrer Belegschaft, und wie viele Stunden pro Monat bindet die Verwaltung? Bestehende Verträge übernehmen und digitalisieren wir, ein Anbieterwechsel ist dafür nicht nötig.\n\nWenn beide Zahlen bei Ihnen stimmen, brauchen Sie uns nicht. Wenn nicht, sind 30 Minuten gut investiert.");
  assert.equal(campaignCGuide,
    "Sehr gern, Camilo. Hier ist der Leitfaden: https://example.test/guide?utm_source=linkedin&utm_medium=social&utm_campaign=degura_c_837149889&utm_content=v2_touch4_reply_guide_slot1\n\nWenn beim Lesen eine Frage aufkommt, schreiben Sie mir einfach. Auf Rückfragen zum Leitfaden antworte ich schneller als auf alles andere.");
  assert.equal(noTime,
    "Verstehe ich, Camilo. Genau deshalb frage ich nach 30 Minuten und nicht nach einem Projekt.\n\nDer Aufwand entsteht ohnehin, nur verteilt: bei jeder Rückfrage, jedem Eintritt, jeder Vertragsänderung. Die 30 Minuten sind der Versuch, das zu bündeln.");
});

test("requires exactly two ready accounts and complete campaign config", () => {
  const result = validateCampaignReadiness({
    accounts: [],
    variantCount: 0,
    bookingUrl: "",
    privacyUrl: "",
  });

  assert.deepEqual(result.codes, [
    "TWO_ACTIVE_ACCOUNTS_REQUIRED",
    "SIX_ACTIVE_VARIANTS_REQUIRED",
    "BOOKING_URL_REQUIRED",
    "PRIVACY_URL_REQUIRED",
    "GUIDE_URL_REQUIRED",
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
