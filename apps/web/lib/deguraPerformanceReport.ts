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

export type TodayMetric = {
  label: string;
  value: string;
  detail: string;
  accent?: "red" | "yellow" | "black";
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
  todayMetrics: TodayMetric[];
  funnel: ReportFunnelStep[];
  weeklyTracking: PeriodMetric[];
  monthlyTracking: PeriodMetric[];
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
    count: 1077,
    rateLabel: `${formatPercent(33.8)} der Kontakte`,
    rate: 33.8,
  },
  {
    label: "Angenommene Kontakte",
    count: 311,
    rateLabel: `${formatPercent(28.9)} der Anfragen`,
    rate: 28.9,
  },
  {
    label: "Erste Nachrichten gesendet",
    count: 307,
    rateLabel: `${formatPercent(98.7)} der angenommenen Kontakte`,
    rate: 98.7,
  },
  {
    label: "Antwortsignale",
    count: 61,
    rateLabel: `${formatPercent(19.9)} der ersten Nachrichten`,
    rate: 19.9,
  },
  {
    label: "Positive Gespräche",
    count: 12,
    rateLabel: `${formatPercent(21.8)} der lesbaren Antworten`,
    rate: 21.8,
  },
];

export function getDeguraPerformanceReport(): DeguraPerformanceReport {
  return {
    snapshotAt: "21. Juli 2026, 14:02 Uhr MESZ",
    campaignWindow: "Degura LinkedIn-Outreach, SEQUENZ B / Batch 21",
    sourceLabel: "Live-Auswertung aus leads und followups, Snapshot 2026-07-21",
    planningAssumption:
      "Für die Planung ist Wochen- und Monats-Tracking die sauberste Ebene: Follow-ups wirken zeitversetzt, während Kontaktanfragen und Annahmen oft in unterschiedlichen Wochen liegen.",
    hero: {
      eyebrow: "Degura Reporting",
      title: "DEGURA OUTREACH",
      summary:
        "Die einfache Lesart: 1.077 Kontaktanfragen, 307 erste Nachrichten, 61 Antwortsignale, 12 positive Gespräche und 532 gesendete Follow-ups. Heute, am 21. Juli, wurden keine neuen Follow-ups, ersten Nachrichten oder Kontaktanfragen gesendet.",
    },
    kpis: [
      { label: "Leads in Sequenz B", value: "3.184", detail: "Reporting-Basis", accent: "black" },
      { label: "Kontaktanfragen", value: "1.077", detail: "33,8% der Sequenz" },
      { label: "Angenommen", value: "311", detail: "28,9% der Anfragen", accent: "yellow" },
      { label: "Erste Nachrichten", value: "307", detail: "98,7% der angenommenen Kontakte" },
      { label: "Antwortsignale", value: "61", detail: "19,9% der ersten Nachrichten", accent: "yellow" },
      { label: "Positive Gespräche", value: "12", detail: "21,8% der lesbaren Antworten", accent: "red" },
      { label: "Follow-ups gesendet", value: "532", detail: "480 Nudges, 52 Reply-Follow-ups", accent: "red" },
      { label: "Juli MTD Follow-ups", value: "192", detail: "1.-21. Juli: 145 Nudges, 47 Reply-Follow-ups" },
    ],
    todayMetrics: [
      { label: "Follow-ups heute", value: "0", detail: "Keine Follow-ups am 21. Juli gesendet", accent: "red" },
      { label: "Davon Nudges", value: "0", detail: "Keine zweite Nurture-Nachricht heute", accent: "black" },
      { label: "Neue Replies heute", value: "0", detail: "Keine neuen lesbaren Replies heute" },
      { label: "Positive Replies heute", value: "0", detail: "Keine positiven Replies am 21. Juli", accent: "yellow" },
    ],
    funnel,
    weeklyTracking: [
      {
        label: "KW 27",
        range: "29. Juni-5. Juli",
        connectionRequests: 217,
        acceptedContacts: 61,
        firstMessages: 61,
        replySignals: 9,
        readableReplies: 9,
        positiveReplies: 1,
        followupsSent: 46,
        nudgeFollowupsSent: 0,
        replyFollowupsSent: 46,
        note: "Viele Reply-Follow-ups wurden nachgezogen; gut für Call- und Booking-Tracking.",
      },
      {
        label: "KW 28",
        range: "6.-12. Juli",
        connectionRequests: 237,
        acceptedContacts: 4,
        firstMessages: 0,
        replySignals: 5,
        readableReplies: 1,
        positiveReplies: 0,
        followupsSent: 98,
        nudgeFollowupsSent: 97,
        replyFollowupsSent: 1,
        note: "Viel Top-of-Funnel und viele Nudges, aber kaum neue Annahmen.",
      },
      {
        label: "KW 29",
        range: "13.-19. Juli",
        connectionRequests: 214,
        acceptedContacts: 1,
        firstMessages: 0,
        replySignals: 2,
        readableReplies: 2,
        positiveReplies: 0,
        followupsSent: 48,
        nudgeFollowupsSent: 48,
        replyFollowupsSent: 0,
        note: "Die Woche brachte 48 Nudge-Follow-ups und zwei neue Zielgruppen-Mismatch-Replies.",
      },
      {
        label: "KW 30",
        range: "20.-21. Juli",
        connectionRequests: 0,
        acceptedContacts: 0,
        firstMessages: 0,
        replySignals: 0,
        readableReplies: 0,
        positiveReplies: 0,
        followupsSent: 0,
        nudgeFollowupsSent: 0,
        replyFollowupsSent: 0,
        note: "Aktuelle Woche zeigt bis zum 21. Juli noch keine neue Outreach-Aktivität.",
      },
    ],
    monthlyTracking: [
      {
        label: "April",
        range: "1.-30. April",
        connectionRequests: 17,
        acceptedContacts: 11,
        firstMessages: 12,
        replySignals: 0,
        readableReplies: 0,
        positiveReplies: 0,
        followupsSent: 0,
        nudgeFollowupsSent: 0,
        replyFollowupsSent: 0,
        note: "Startphase mit kleinem Volumen.",
      },
      {
        label: "Mai",
        range: "1.-31. Mai",
        connectionRequests: 217,
        acceptedContacts: 95,
        firstMessages: 95,
        replySignals: 9,
        readableReplies: 9,
        positiveReplies: 1,
        followupsSent: 40,
        nudgeFollowupsSent: 36,
        replyFollowupsSent: 4,
        note: "Erste belastbare Antwortbasis.",
      },
      {
        label: "Juni",
        range: "1.-30. Juni",
        connectionRequests: 392,
        acceptedContacts: 200,
        firstMessages: 200,
        replySignals: 36,
        readableReplies: 34,
        positiveReplies: 10,
        followupsSent: 300,
        nudgeFollowupsSent: 299,
        replyFollowupsSent: 1,
        note: "Bester Monat für qualifizierte Antworten und Follow-up-Volumen.",
      },
      {
        label: "Juli MTD",
        range: "1.-21. Juli",
        connectionRequests: 451,
        acceptedContacts: 5,
        firstMessages: 0,
        replySignals: 16,
        readableReplies: 12,
        positiveReplies: 1,
        followupsSent: 192,
        nudgeFollowupsSent: 145,
        replyFollowupsSent: 47,
        note: "Juli bleibt unverändert seit dem letzten Snapshot: hohes Anfrage- und Follow-up-Volumen, aber keine neue Aktivität am 21. Juli.",
      },
    ],
    keyLearnings: [
      "Follow-ups müssen als eigener Reporting-Block sichtbar sein; insgesamt wurden bereits 532 Follow-ups gesendet.",
      "Für Management-Reporting sind Monat und Woche besser als einzelne Inbox-Beispiele.",
      "Heute, am 21. Juli, gab es keine neuen Sends und keine neuen lesbaren Replies.",
      "Die letzten neuen Antworten von Gal Schkolnik und Matthias Weiss zeigen Zielgruppen-Mismatch, nicht Sales-Potenzial.",
      "Die nächste Optimierung liegt in Lead-Filterung und klarerer Kontextzeile, nicht nur in mehr Volumen.",
    ],
    conversationHighlights: [
      {
        name: "Dennis Proll",
        company: "Microsoft",
        category: "Vollständige Nurture-Sequenz",
        note:
          "Kein Inbound-Reply gespeichert, aber die Sequenz ist vollständig ausgespielt: Erstnachricht, Follow-up und finale Nudge-Nachricht. Genau solche Verläufe gehören in Follow-up-Tracking, nicht in Reply-Tracking.",
        emphasis: true,
      },
      {
        name: "Gal Schkolnik",
        company: "Mondly by Pearson",
        category: "Reply heute: Zielgruppen-Mismatch",
        note:
          "Antwort vom 17. Juli: kein Arbeitgeber. Für Reporting zählt das als Datenqualitäts- und Zielgruppenhinweis, nicht als positives Gespräch.",
      },
      {
        name: "Matthias Weiss",
        company: "Text: van Laak",
        category: "Reply heute: selbstständig",
        note:
          "Antwort vom 17. Juli: selbstständig. Wichtig für Filterung vor weiterer Skalierung.",
      },
      {
        name: "Thomas Rolfsmeyer-Wicklein",
        company: "Aginode",
        category: "Explizite Terminbereitschaft",
        note:
          "Klarster Meeting-Intent im Datensatz: konkrete Gesprächsbereitschaft mit Terminvorschlag.",
      },
    ],
    methodology: [
      "Funnel-Zahlen kommen aus leads: Verbindung gesendet, angenommen, Erstnachricht und Reply-Signal.",
      "Follow-up-Zahlen kommen aus followups.sent_at und zählen alle Typen: NUDGE und REPLY.",
      "Positive Gespräche zählen lesbare Reply-Snippets mit positiver Klassifizierung.",
      "Wochen- und Monatswerte sind nach UTC-Zeitstempeln aggregiert; der Report ist als operatives Tracking gedacht.",
    ],
  };
}
