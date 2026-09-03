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
  | "GUIDE_ASSET_REQUIRED";

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
  route: string;
  formal: boolean;
  bookingUrl: string;
  guideUrl: string;
}): string {
  const { route, formal, bookingUrl, guideUrl } = input;
  const drafts: Record<string, string> = {
    appointment: bookingUrl
      ? `${formal ? "Vielen Dank. Einen passenden Termin können Sie hier auswählen" : "Danke dir. Einen passenden Termin kannst du hier auswählen"}: ${bookingUrl}`
      : "",
    guide: `Sehr gern. Hier ist der Leitfaden: ${guideUrl}`.trim(),
    existing_bav: formal
      ? `Gut, dass Sie bereits eine bAV haben. Interessant ist dann vor allem, wie viele Mitarbeitende sie tatsächlich nutzen und wie viel Verwaltungsaufwand entsteht. Den Leitfaden finden Sie hier: ${guideUrl}`.trim()
      : `Gut, dass ihr bereits eine bAV habt. Interessant ist dann vor allem, wie viele Mitarbeitende sie tatsächlich nutzen und wie viel Verwaltungsaufwand entsteht. Den Leitfaden findest du hier: ${guideUrl}`.trim(),
    not_now: formal
      ? "Vielen Dank für die klare Rückmeldung. Ich melde mich zu einem späteren Zeitpunkt noch einmal. Bis dahin lasse ich Sie in Ruhe."
      : "Danke für die klare Rückmeldung. Ich melde mich zu einem späteren Zeitpunkt noch einmal. Bis dahin lasse ich dich in Ruhe.",
    email_request: formal
      ? "Gern. An welche E-Mail-Adresse darf ich Ihnen die Informationen schicken?"
      : "Mach ich. An welche E-Mail-Adresse soll ich dir die Informationen schicken?",
    internal_clarification: formal
      ? "Gern. Soll ich Ihnen vorab eine kurze Zusammenfassung der Kosten- und Aufwandsseite für die Geschäftsführung schicken?"
      : "Klingt gut. Soll ich dir vorab eine kurze Zusammenfassung der Kosten- und Aufwandsseite für die Geschäftsführung schicken?",
    no_time: "Verstehe ich. Genau deshalb geht es um 30 Minuten und nicht um ein Projekt. Der Aufwand entsteht ohnehin bei Rückfragen, Eintritten und Vertragsänderungen; der Termin bündelt diese Punkte.",
    employee_disinterest: "Das hören wir oft. Häufig liegt es weniger am Thema als am Einstieg: Wenn der Weg aus PDF, Beratungstermin und Papier besteht, sinkt die Beteiligung. Ein vollständig digitaler Einstieg senkt diese Hürde deutlich.",
    wrong_person: formal
      ? "Vielen Dank für den Hinweis. Wer ist bei Ihnen die richtige Ansprechperson für das Thema?"
      : "Danke für den Hinweis. Wer ist bei euch die richtige Ansprechperson für das Thema?",
    clear_no: formal
      ? "Verstanden, vielen Dank für die klare Rückmeldung. Ich melde mich nicht mehr dazu."
      : "Verstanden, danke dir für die klare Rückmeldung. Ich melde mich nicht mehr dazu.",
  };
  return drafts[route] || "";
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

export function validateGuidePdfBytes(bytes: Uint8Array, maxBytes = 10 * 1024 * 1024): boolean {
  if (bytes.byteLength < 5 || bytes.byteLength > maxBytes) return false;
  return String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
}

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
    const slug = decodeURIComponent(profileMatch[1]).trim().toLowerCase();
    if (!slug || !/^[a-z0-9%_.~-]+$/i.test(slug)) return "";
    return `https://www.linkedin.com/in/${encodeURIComponent(slug).replace(/%25/g, "%")}`;
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
  guideAssetPresent: boolean;
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
  if (!input.guideAssetPresent && !isValidHttpsUrl(input.guideUrl || "")) codes.push("GUIDE_ASSET_REQUIRED");
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
