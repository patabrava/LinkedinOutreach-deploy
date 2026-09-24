export type DeguraAccountReadiness = {
  id: string;
  is_active?: boolean;
  browser_slot?: number;
  daily_invite_limit?: number;
  daily_message_limit?: number;
  has_password?: boolean;
  session_active?: boolean;
};

export type CampaignReadinessCode =
  | "TWO_ACTIVE_ACCOUNTS_REQUIRED"
  | "ACCOUNT_BROWSER_SLOTS_REQUIRED"
  | "ACCOUNT_CREDENTIALS_REQUIRED"
  | "ACCOUNT_SESSIONS_REQUIRED"
  | "ACCOUNT_LIMITS_REQUIRED"
  | "SIX_ACTIVE_VARIANTS_REQUIRED"
  | "BOOKING_URL_REQUIRED"
  | "PRIVACY_URL_REQUIRED"
  | "GUIDE_URL_REQUIRED";

export type DeguraImportRow = Record<string, unknown> & { linkedin_url?: unknown };

export type DeguraCampaignFamily = "A" | "B" | "C";

export type DeguraCsvRow = DeguraImportRow & {
  linkedin_url: string;
  first_name: string;
  last_name: string;
  company_name: string;
  source_contact_id: string;
  source_company_id: string;
  source_sequence_id: string;
  source_last_activity_at: string;
};

export const DEGURA_SOURCE_SEQUENCE_FAMILY: Readonly<Record<string, DeguraCampaignFamily>> = {
  "837149883": "A",
  "836545727": "B",
  "837149889": "C",
};

const DEGURA_UTM_CAMPAIGN: Readonly<Record<string, string>> = {
  DEGURA_A: "degura_a_837149883",
  DEGURA_B: "degura_b_836545727",
  DEGURA_C: "degura_c_837149889",
};

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content"] as const;

function normalizeUtmToken(value: unknown): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

export function buildDeguraUtmUrl(baseUrl: string, input: {
  campaignKey: string;
  variantKey: number;
  context: string;
  linkType: "guide" | "booking";
  accountSlot: number;
}): string {
  const campaign = DEGURA_UTM_CAMPAIGN[input.campaignKey];
  if (!campaign || !baseUrl.trim()) return baseUrl;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") return baseUrl;
    for (const key of UTM_KEYS) parsed.searchParams.delete(key);
    const variant = input.variantKey === 1 || input.variantKey === 2 ? `v${input.variantKey}` : "v_unknown";
    const slot = input.accountSlot === 1 || input.accountSlot === 2 ? `slot${input.accountSlot}` : "slot_unknown";
    const context = normalizeUtmToken(input.context);
    const linkSuffix = context === input.linkType || context.endsWith(`_${input.linkType}`) ? "" : `_${input.linkType}`;
    parsed.searchParams.set("utm_source", "linkedin");
    parsed.searchParams.set("utm_medium", "social");
    parsed.searchParams.set("utm_campaign", campaign);
    parsed.searchParams.set(
      "utm_content",
      `${variant}_${context}${linkSuffix}_${slot}`,
    );
    return parsed.toString();
  } catch {
    return baseUrl;
  }
}

function replyTouchContext(sourceTouch: string): string {
  const contexts: Readonly<Record<string, string>> = {
    connect_note: "touch1",
    first_message: "touch2",
    second_message: "touch3",
    third_message: "touch4",
    asset_followup_1: "asset_followup1",
    asset_followup_2: "asset_followup2",
  };
  return contexts[sourceTouch] || normalizeUtmToken(sourceTouch);
}

const valueFor = (record: Record<string, unknown>, aliases: string[]): string => {
  for (const alias of aliases) {
    const value = record[alias];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
};

export function normalizeDeguraCsvRecord(record: Record<string, unknown>): DeguraCsvRow {
  return {
    linkedin_url: valueFor(record, ["linkedin_url", "LinkedIn URL", "LinkedIn-URL", "Legacy LinkedIn URL", "LinkedIn"]),
    first_name: valueFor(record, ["first_name", "firstName", "First Name", "Vorname"]),
    last_name: valueFor(record, ["last_name", "lastName", "Last Name", "Nachname"]),
    company_name: valueFor(record, ["company_name", "Company Name", "Current Company", "Legacy Current Company", "Unternehmensname", "Company"]),
    source_contact_id: valueFor(record, ["source_contact_id", "Datensatz-ID - Contact"]),
    source_company_id: valueFor(record, ["source_company_id", "Datensatz-ID - Company"]),
    source_sequence_id: valueFor(record, ["source_sequence_id", "Letzte Sequenz, in die ein Kontakt aufgenommen war"]),
    source_last_activity_at: valueFor(record, ["source_last_activity_at", "Datum der letzten Aktivität"]),
  };
}

function recentSortValue(value: unknown): string {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized) ? normalized : "";
}

export function sortDeguraRowsByRecent<T extends DeguraImportRow>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const recent = recentSortValue(right.source_last_activity_at).localeCompare(recentSortValue(left.source_last_activity_at));
    if (recent) return recent;
    return String(left.linkedin_url || "").localeCompare(String(right.linkedin_url || ""));
  });
}

export function groupDeguraRowsByFamily<T extends DeguraImportRow>(rows: T[]): Record<DeguraCampaignFamily, T[]> {
  const grouped: Record<DeguraCampaignFamily, T[]> = { A: [], B: [], C: [] };
  for (const row of rows) {
    const family = DEGURA_SOURCE_SEQUENCE_FAMILY[String(row.source_sequence_id || "").trim()];
    if (family) grouped[family].push(row);
  }
  grouped.A = sortDeguraRowsByRecent(grouped.A);
  grouped.B = sortDeguraRowsByRecent(grouped.B);
  grouped.C = sortDeguraRowsByRecent(grouped.C);
  return grouped;
}

export function buildDeguraReplyDraft(input: {
  campaignKey: string;
  route: string;
  firstName: string;
  companyName: string;
  bookingUrl: string;
  guideUrl: string;
  variantKey: number;
  sourceTouch: string;
  accountSlot: number;
}): string {
  const { campaignKey, route } = input;
  const context = `${replyTouchContext(input.sourceTouch)}_reply_${normalizeUtmToken(route)}`;
  const bookingUrl = buildDeguraUtmUrl(input.bookingUrl, {
    campaignKey,
    variantKey: input.variantKey,
    context,
    linkType: "booking",
    accountSlot: input.accountSlot,
  });
  const guideUrl = buildDeguraUtmUrl(input.guideUrl, {
    campaignKey,
    variantKey: input.variantKey,
    context,
    linkType: "guide",
    accountSlot: input.accountSlot,
  });
  const firstName = input.firstName.trim();
  const formal = campaignKey === "DEGURA_C";
  const a: Record<string, string> = {
    appointment: `Sehr gern, ${firstName}. Du kannst dir gerne hier einen Termin mit unserem bAV Experten Toby buchen: ${bookingUrl}`,
    guide: `Klar, ich schicke dir unseren bAV-Leitfaden für HR-Teams. Dort findest du die wichtigsten Aspekte einer bAV Implementierung. Hier ist der Link: ${guideUrl}\n\nUnd falls du danach Fragen hast, buche dir gerne einen unverbindlichen Termin bei unserem bAV Experten Toby: ${bookingUrl}`,
    not_now: `Danke für die klare Rückmeldung, ${firstName}.\n\nIch melde mich dann nochmal. Bis dahin lasse ich dich in Ruhe. Falls sich vorher etwas ändert, weißt du, wo ich bin.`,
    existing_bav: `Gut, dass ihr überhaupt eine habt, ${firstName}. Viele haben das nur auf dem Papier.\n\nInteressanter ist dann meistens: Wie viele deiner Mitarbeitenden nutzen sie wirklich, und wie viel Handarbeit kostet euch die Verwaltung? Wie sieht es mit potenziellen Haftungsfallen aus?\n\nDen Leitfaden schicke ich dir trotzdem, dann liegt er da, wenn du ihn brauchst: ${guideUrl}`,
    wrong_person: `Danke, ${firstName}, das spart uns beiden Zeit.\n\nMagst du mir den Namen nennen, oder mich kurz weiterleiten? Ich melde mich dann direkt dort und du hast das Thema vom Tisch.`,
    email_request: `Mach ich, ${firstName}. An welche Adresse soll ich dir die Infos schicken?`,
    clear_no: `Alles gut, ${firstName}. Danke für die direkte Antwort, ich melde mich nicht mehr. Viel Erfolg.`,
    internal_clarification: `Klingt gut, ${firstName}. Damit du da nicht mit leeren Händen reingehst: soll ich dir eine Seite schicken, die die Kosten- und Aufwandsseite für die Geschäftsführung zusammenfasst?\n\nSag mir Bescheid, dann hast du sie vor dem Termin.`,
  };
  const b: Record<string, string> = {
    ...a,
    guide: `Sehr gern, ${firstName}. Hier ist er: ${guideUrl}\n\nWenn du beim Lesen an einer Stelle hängen bleibst, schreib mir einfach. Ich beantworte gerne alle Fragen und freue mich auf den Austausch.`,
    appointment: `Noch besser, ${firstName}. Du kannst dir gerne hier einen Termin mit unserem bAV Experten Toby buchen: ${bookingUrl}\n\nIch schicke dir den Leitfaden trotzdem mit, dann hast du ihn vor dem Termin: ${guideUrl}`,
    not_now: `Alles klar, ${firstName}, danke für die Antwort.\n\nDen Leitfaden schicke ich dir trotzdem, dann liegt er da, wenn du ihn brauchst: ${guideUrl}`,
    internal_clarification: `Gute Idee, ${firstName}. Der Leitfaden ist genau dafür gemacht, er fasst die wesentlichen Aspekte zusammen.\nIch schicke ihn Dir trotzdem, dann liegt er da, wenn du ihn brauchst: ${guideUrl}`,
  };
  const c: Record<string, string> = {
    guide: `Sehr gern, ${firstName}. Hier ist der Leitfaden: ${guideUrl}\n\nWenn beim Lesen eine Frage aufkommt, schreiben Sie mir einfach. Auf Rückfragen zum Leitfaden antworte ich schneller als auf alles andere.`,
    existing_bav: `Das ist eine gute Ausgangslage, ${firstName}, und häufiger die Ausnahme als die Regel.\n\nZwei Fragen sind dann meistens aufschlussreicher als die nach dem Anbieter: Wie hoch ist die Beteiligungsquote in Ihrer Belegschaft, und wie viele Stunden pro Monat bindet die Verwaltung? Bestehende Verträge übernehmen und digitalisieren wir, ein Anbieterwechsel ist dafür nicht nötig.\n\nWenn beide Zahlen bei Ihnen stimmen, brauchen Sie uns nicht. Wenn nicht, sind 30 Minuten gut investiert.`,
    clear_no: `Verstanden, ${firstName}. Danke für die klare Antwort, ich melde mich nicht mehr. Alles Gute.`,
    appointment: `Sehr gern, ${firstName}. Einen passenden Termin mit unserem bAV Experten Toby können Sie hier auswählen: ${bookingUrl}`,
    not_now: `Vielen Dank für die klare Rückmeldung, ${firstName}. Ich melde mich zu einem späteren Zeitpunkt noch einmal. Bis dahin lasse ich Sie in Ruhe.`,
    email_request: `Gern, ${firstName}. An welche E-Mail-Adresse darf ich Ihnen die Informationen schicken?`,
    internal_clarification: `Gern, ${firstName}. Soll ich Ihnen vorab eine kurze Zusammenfassung der Kosten- und Aufwandsseite für die Geschäftsführung schicken?`,
    wrong_person: `Vielen Dank, ${firstName}. Wer ist bei Ihnen die richtige Ansprechperson für das Thema?`,
  };
  const common = formal ? {
    no_time: `Verstehe ich, ${firstName}. Genau deshalb frage ich nach 30 Minuten und nicht nach einem Projekt.\n\nDer Aufwand entsteht ohnehin, nur verteilt: bei jeder Rückfrage, jedem Eintritt, jeder Vertragsänderung. Die 30 Minuten sind der Versuch, das zu bündeln.`,
    employee_disinterest: "Das hören wir oft, und meistens stimmt die Beobachtung, nur nicht die Erklärung.\n\nWenn der Einstieg aus einem PDF, einem Beratungstermin und einer Unterschrift auf Papier besteht, sinkt die Beteiligung. Nicht weil das Thema uninteressant ist, sondern weil der Weg dahin unattraktiv ist. Bei einem digitalen Einstieg steigt die Quote deutlich.",
  } : {
    no_time: `Verstehe ich, ${firstName}. Genau deshalb frage ich nach 30 Minuten und nicht nach einem Projekt.\n\nDer Aufwand entsteht ohnehin, nur verteilt: bei jeder Rückfrage, jedem Eintritt, jeder Vertragsänderung. Die 30 Minuten sind der Versuch, das zu bündeln.`,
    employee_disinterest: "Das hören wir oft, und meistens stimmt die Beobachtung, nur nicht die Erklärung.\n\nWenn der Einstieg aus einem PDF, einem Beratungstermin und einer Unterschrift auf Papier besteht, sinkt die Beteiligung. Nicht weil das Thema uninteressant ist, sondern weil der Weg dahin unattraktiv ist. Bei einem digitalen Einstieg steigt die Quote deutlich.",
  };
  const campaignDrafts = campaignKey === "DEGURA_A" ? a : campaignKey === "DEGURA_B" ? b : campaignKey === "DEGURA_C" ? c : {};
  return campaignDrafts[route] || common[route as keyof typeof common] || "";
}

export type DeguraRejectedRow = {
  row: DeguraImportRow;
  linkedinUrl: string;
  reason:
    | "ELIGIBILITY_CONFIRMATION_REQUIRED"
    | "INVALID_LINKEDIN_URL"
    | "DUPLICATE_LINKEDIN_URL"
    | "GLOBAL_SUPPRESSION_ACTIVE";
};

export function canonicalizeLinkedinUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  try {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname !== "linkedin.com") return "";
    const profileMatch = parsed.pathname.match(/^\/in\/([^/?#]+)\/?$/i);
    if (!profileMatch) return "";
    const slug = decodeURIComponent(profileMatch[1]).trim().normalize("NFKC").toLowerCase();
    if (!slug || /[\u0000-\u001f\u007f\s/?#]/u.test(slug)) return "";
    const encodedSlug = encodeURIComponent(slug).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `https://www.linkedin.com/in/${encodedSlug.toLowerCase()}`;
  } catch {
    return "";
  }
}

export function distributeDeguraLeads(
  linkedinUrls: string[],
  accountIds: [string, string] | string[],
  variantIds: [number, number] | number[],
) {
  if (accountIds.length !== 2 || variantIds.length !== 2) {
    throw new Error("Exactly two LinkedIn accounts and two variants are required.");
  }
  return linkedinUrls
    .map(canonicalizeLinkedinUrl)
    .filter(Boolean)
    .map((linkedinUrl, index) => ({
      linkedinUrl,
      accountId: accountIds[index % 2],
      variantId: variantIds[Math.floor(index / 2) % 2],
    }));
}

function isValidHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function validateCampaignReadiness(input: {
  accounts: DeguraAccountReadiness[];
  variantCount: number;
  bookingUrl: string;
  privacyUrl: string;
  guideUrl?: string;
}) {
  const accounts = input.accounts.filter((account) => account.is_active !== false);
  const codes: CampaignReadinessCode[] = [];
  if (accounts.length !== 2) {
    codes.push("TWO_ACTIVE_ACCOUNTS_REQUIRED");
  } else {
    const slots = new Set(accounts.map((account) => account.browser_slot));
    if (slots.size !== 2 || !slots.has(1) || !slots.has(2)) codes.push("ACCOUNT_BROWSER_SLOTS_REQUIRED");
    if (accounts.some((account) => account.has_password === false)) codes.push("ACCOUNT_CREDENTIALS_REQUIRED");
    if (accounts.some((account) => account.session_active === false)) codes.push("ACCOUNT_SESSIONS_REQUIRED");
    if (accounts.some((account) => (account.daily_invite_limit ?? 0) <= 0 || (account.daily_message_limit ?? 0) <= 0)) {
      codes.push("ACCOUNT_LIMITS_REQUIRED");
    }
  }
  if (input.variantCount !== 6) codes.push("SIX_ACTIVE_VARIANTS_REQUIRED");
  if (!isValidHttpsUrl(input.bookingUrl)) codes.push("BOOKING_URL_REQUIRED");
  if (!isValidHttpsUrl(input.privacyUrl)) codes.push("PRIVACY_URL_REQUIRED");
  if (!isValidHttpsUrl(input.guideUrl || "")) codes.push("GUIDE_URL_REQUIRED");
  return { ready: codes.length === 0, codes };
}

export function previewDeguraRows(
  rows: DeguraImportRow[],
  options: {
    eligibilityConfirmed: boolean;
    existingUrls?: Set<string>;
    suppressedUrls?: Set<string>;
  },
) {
  const existingUrls = new Set([...options.existingUrls ?? []].map(canonicalizeLinkedinUrl).filter(Boolean));
  const suppressedUrls = new Set([...options.suppressedUrls ?? []].map(canonicalizeLinkedinUrl).filter(Boolean));
  const accepted: Array<{ row: DeguraImportRow; linkedinUrl: string }> = [];
  const rejected: DeguraRejectedRow[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const linkedinUrl = canonicalizeLinkedinUrl(row.linkedin_url);
    let reason: DeguraRejectedRow["reason"] | undefined;
    if (!options.eligibilityConfirmed) reason = "ELIGIBILITY_CONFIRMATION_REQUIRED";
    else if (!linkedinUrl) reason = "INVALID_LINKEDIN_URL";
    else if (existingUrls.has(linkedinUrl) || seen.has(linkedinUrl)) reason = "DUPLICATE_LINKEDIN_URL";
    else if (suppressedUrls.has(linkedinUrl)) reason = "GLOBAL_SUPPRESSION_ACTIVE";

    if (reason) rejected.push({ row, linkedinUrl, reason });
    else {
      accepted.push({ row, linkedinUrl });
      seen.add(linkedinUrl);
    }
  }

  return { accepted, rejected, canCreateBatch: options.eligibilityConfirmed && accepted.length > 0 };
}
