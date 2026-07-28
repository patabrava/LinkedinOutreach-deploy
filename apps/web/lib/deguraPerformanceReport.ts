export type ReportKpi = {
  label: string;
  value: string;
  detail: string;
  accent?: "red" | "yellow" | "black";
};

export type ReportFunnelStep = {
  label: string;
  count: number;
  rateLabel: string;
  rate: number;
};

export type TrackingMode = "daily" | "weekly" | "monthly";

export type PeriodMetric = {
  label: string;
  range: string;
  connectionRequests: number;
  acceptedContacts: number;
  firstMessages: number;
  replySignals: number;
  readableReplies: number;
  positiveReplies: number;
  followupsSent: number;
  nudgeFollowupsSent: number;
  replyFollowupsSent: number;
  note: string;
};

export type ConversationHighlight = {
  name: string;
  company: string;
  category: string;
  note: string;
  emphasis?: boolean;
};

export type DeguraPerformanceReport = {
  snapshotAt: string;
  campaignWindow: string;
  sourceLabel: string;
  planningAssumption: string;
  hero: {
    title: string;
    eyebrow: string;
    summary: string;
  };
  kpis: ReportKpi[];
  periodFilters: Record<TrackingMode, PeriodMetric>;
  funnel: ReportFunnelStep[];
  keyLearnings: string[];
  conversationHighlights: ConversationHighlight[];
  methodology: string[];
};

const formatPercent = (value: number) => `${value.toFixed(1).replace(".", ",")}%`;

const funnel = [
  {
    label: "Kontakte in SEQUENZ B",
    count: 3184,
    rateLabel: "Hauptsequenz",
    rate: 100,
  },
  {
    label: "Kontaktanfragen gesendet",
    count: 1095,
    rateLabel: `${formatPercent(34.4)} der Kontakte`,
    rate: 34.4,
  },
  {
    label: "Angenommene Kontakte",
    count: 521,
    rateLabel: `${formatPercent(47.6)} der Anfragen`,
    rate: 47.6,
  },
  {
    label: "Erste Nachrichten gesendet",
    count: 521,
    rateLabel: `${formatPercent(100)} der angenommenen Kontakte`,
    rate: 100,
  },
  {
    label: "Antwortsignale",
    count: 81,
    rateLabel: `${formatPercent(15.5)} der ersten Nachrichten`,
    rate: 15.5,
  },
  {
    label: "Interessierte Replies",
    count: 15,
    rateLabel: `${formatPercent(18.1)} der lesbaren Antworten`,
    rate: 18.1,
  },
];

export function getDeguraPerformanceReport(): DeguraPerformanceReport {
  return {
    snapshotAt: "28. Juli 2026, 14:41 Uhr MESZ",
    campaignWindow: "Degura LinkedIn-Outreach, SEQUENZ B / Batch 21",
    sourceLabel: "Live-Auswertung aus leads und followups, Snapshot 2026-07-28",
    planningAssumption:
      "Der Filter schaltet die Hauptansicht zwischen Tages-, Wochen- und Monatszahlen. So bleibt der Report kurz, ohne Daily-, Weekly- oder Monthly-Blöcke untereinander zu stapeln.",
    hero: {
      eyebrow: "Degura Reporting",
      title: "DEGURA OUTREACH",
      summary:
        "Die einfache Lesart bis 28. Juli: 1.095 Kontaktanfragen, 521 erste Nachrichten, 81 Antwortsignale, 15 interessierte Replies und 563 gesendete Follow-ups. Heute kamen 20 lesbare Replies rein; Elias und Disha zeigen echtes Interesse.",
    },
    kpis: [
      { label: "Leads in Sequenz B", value: "3.184", detail: "Reporting-Basis", accent: "black" },
      { label: "Kontaktanfragen", value: "1.095", detail: "34,4% der Sequenz" },
      { label: "Angenommen", value: "521", detail: "47,6% der Anfragen", accent: "yellow" },
      { label: "Erste Nachrichten", value: "521", detail: "100,0% der angenommenen Kontakte" },
      { label: "Antwortsignale", value: "81", detail: "15,5% der ersten Nachrichten", accent: "yellow" },
      { label: "Interessierte Replies", value: "15", detail: "18,1% der 83 lesbaren Replies", accent: "red" },
      { label: "Follow-ups gesendet", value: "563", detail: "480 Nudges, 83 Reply-Follow-ups", accent: "red" },
      { label: "Juli MTD Follow-ups", value: "223", detail: "1.-28. Juli: 145 Nudges, 78 Reply-Follow-ups" },
    ],
    periodFilters: {
      daily: {
        label: "28. Juli",
        range: "Heute",
        connectionRequests: 0,
        acceptedContacts: 0,
        firstMessages: 0,
        replySignals: 20,
        readableReplies: 20,
        positiveReplies: 2,
        followupsSent: 31,
        nudgeFollowupsSent: 0,
        replyFollowupsSent: 31,
        note: "Heute wurden 31 Reply-Follow-ups gesendet. 20 lesbare Replies kamen rein; Elias und Disha zeigen echtes Interesse.",
      },
      weekly: {
        label: "KW 31",
        range: "27.-28. Juli",
        connectionRequests: 0,
        acceptedContacts: 8,
        firstMessages: 8,
        replySignals: 20,
        readableReplies: 20,
        positiveReplies: 2,
        followupsSent: 31,
        nudgeFollowupsSent: 0,
        replyFollowupsSent: 31,
        note: "Die aktuelle Woche ist reply-lastig: keine neuen Kontaktanfragen, aber 20 lesbare Replies und 31 gesendete Reply-Follow-ups.",
      },
      monthly: {
        label: "Juli MTD",
        range: "1.-28. Juli",
        connectionRequests: 469,
        acceptedContacts: 215,
        firstMessages: 214,
        replySignals: 36,
        readableReplies: 37,
        positiveReplies: 4,
        followupsSent: 223,
        nudgeFollowupsSent: 145,
        replyFollowupsSent: 78,
        note: "Juli hat 469 Kontaktanfragen, 214 erste Nachrichten, 37 lesbare Replies und 4 interessierte Replies geliefert.",
      },
    },
    funnel,
    keyLearnings: [
      "Der Report fokussiert jetzt interessierte Replies statt langer Daily- oder Weekly-Blöcke.",
      "Am 28. Juli wurden 31 Reply-Follow-ups gesendet; der aktuelle Gesamtstand liegt damit bei 563 Follow-ups. Der letzte gespeicherte Follow-up liegt um 10:24 Uhr MESZ.",
      "Die aktuelle Antwortqualität ist gemischt: 20 lesbare Replies heute, 2 davon klar interessant.",
      "Juli MTD steht bei 223 Follow-ups und 4 interessierten Replies; die beste aktuelle Follow-up-Arbeit liegt in den positiven Antworten von Elias, Disha und Daniel.",
      "Weiteres Volumen lohnt sich nur mit sauberer Zielgruppenfilterung, weil viele neue Replies weiterhin Selbstständigkeit, Ausland oder fehlenden Bedarf signalisieren.",
    ],
    conversationHighlights: [
      {
        name: "Elias Constantino Gil Morel",
        company: "Preply",
        category: "Interessiert heute: konkreter Beratungsbedarf",
        note:
          "Fragt, ob die Regelung nach Arbeitgeber- und Länderwechsel in seinem Fall greift. Das ist einer der klarsten aktuellen Beratungsanlässe.",
        emphasis: true,
      },
      {
        name: "Disha Devidas",
        company: "Exasol",
        category: "Interessiert heute: HR-Check",
        note:
          "Hat die bAV-Leistung beim aktuellen Arbeitgeber noch nicht geprüft und will mit HR nachsehen. Gute Gelegenheit für eine klare, hilfreiche Nachfassnachricht.",
        emphasis: true,
      },
      {
        name: "Daniel Wolde-Selassie",
        company: "BRITA Group",
        category: "Interessiert: Links oder kurzer Call",
        note:
          "Bittet um hilfreiche Links und ist alternativ offen für einen kurzen Call. Diese Antwort sollte im Report klar vor Zielgruppen-Mismatch-Replies stehen.",
        emphasis: true,
      },
      {
        name: "Thomas Rolfsmeyer-Wicklein",
        company: "Aginode",
        category: "Interessiert: Terminbereitschaft",
        note:
          "Klarster Meeting-Intent im Datensatz: konkrete Gesprächsbereitschaft mit Terminvorschlag.",
        emphasis: true,
      },
      {
        name: "Tommy Nieminen",
        company: "Munich Electrification",
        category: "Interessiert: Zuschuss vorhanden",
        note:
          "Bestätigt einen monatlichen Zuschuss in die Altersvorsorge. Relevanter Fall für Prüfung, ob der Zuschuss sauber genutzt wird.",
      },
      {
        name: "Mariia Khristina",
        company: "Taxfix",
        category: "Interessiert: bAV-Klärung im Juli",
        note:
          "Hat ein Jobangebot erhalten und will das bAV-Thema im Juli klären. Das ist ein gutes Timing-Signal für Follow-up und Terminlink.",
      },
    ],
    methodology: [
      "Funnel-Zahlen kommen aus leads: Verbindung gesendet, angenommen, Erstnachricht und Reply-Signal.",
      "Follow-up-Zahlen kommen aus followups.sent_at und zählen alle Typen: NUDGE und REPLY.",
      "Interessierte Replies zählen eindeutige lesbare Reply-Snippets mit reply_intent=positive; reine Link-Nachfasszeilen werden nicht als neuer Interessens-Reply gezählt.",
      "Daily, Weekly und Monthly nutzen Berlin-Kalendertage; der aktuelle Snapshot wurde am 28. Juli um 14:41 Uhr MESZ frisch gegen Supabase geprüft.",
    ],
  };
}
