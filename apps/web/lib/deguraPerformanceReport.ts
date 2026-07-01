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

export type ResponseCluster = {
  title: string;
  count: number;
  positive: number;
  interpretation: string;
  implication: string;
};

export type PositiveSignal = {
  label: string;
  example: string;
  meaning: string;
  followUp: string;
};

export type VolumeScenario = {
  label: string;
  weeklyInvites: number;
  note: string;
};

export type CallPotentialItem = {
  label: string;
  value: string;
  detail: string;
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
  funnel: ReportFunnelStep[];
  responseClusters: ResponseCluster[];
  positiveSignals: PositiveSignal[];
  callPotential: {
    title: string;
    summary: string;
    items: CallPotentialItem[];
    note: string;
  };
  copyLearnings: string[];
  volumeScenarios: VolumeScenario[];
  nextActions: string[];
  methodology: string[];
};

const formatPercent = (value: number) => `${value.toFixed(1).replace(".", ",")}%`;

const funnel = [
  {
    label: "Kontakte im Haupttest",
    count: 1000,
    rateLabel: "Basis der Sequenz",
    rate: 100,
  },
  {
    label: "Kontaktanfragen gesendet",
    count: 580,
    rateLabel: `${formatPercent(58)} der Testkontakte`,
    rate: 58,
  },
  {
    label: "Angenommene Kontakte",
    count: 273,
    rateLabel: `${formatPercent(47.1)} der Anfragen`,
    rate: 47.1,
  },
  {
    label: "Erste Nachrichten gesendet",
    count: 274,
    rateLabel: "Nach Annahme gesendet",
    rate: 47.2,
  },
  {
    label: "Antworten",
    count: 44,
    rateLabel: `${formatPercent(16.1)} der Nachrichten`,
    rate: 16.1,
  },
  {
    label: "Positive Antworten",
    count: 11,
    rateLabel: `${formatPercent(25)} der Antworten`,
    rate: 25,
  },
];

export function getDeguraPerformanceReport(): DeguraPerformanceReport {
  return {
    snapshotAt: "1. Juli 2026, 22:33 Uhr MESZ",
    campaignWindow: "Seit Start des Degura LinkedIn-Outreach-Prozesses",
    sourceLabel: "Auswertung aus dem LinkedIn-Outreach-System, Snapshot 2026-07-01",
    planningAssumption:
      "Für die operative Planung rechnen wir konservativ mit ca. 50 Kontaktanfragen pro LinkedIn-Account und Woche. LinkedIn veröffentlicht kein fixes Limit; das tatsächliche Limit hängt vom Account und vom Verhalten ab.",
    hero: {
      eyebrow: "Degura Marketing-Auswertung",
      title: "DEGURA OUTREACH PERFORMANCE",
      summary:
        "Die Kampagne liefert ein klares erstes Signal: Ein Viertel der Antworten aus der Hauptsequenz ist positiv oder offen genug, um weiter bearbeitet zu werden. Für eine belastbare Marketingbewertung braucht Degura jetzt vor allem mehr kontrolliertes Volumen.",
    },
    kpis: [
      { label: "Leads im System", value: "3.186", detail: "Gesamter Datenbestand" },
      { label: "Hauptsequenz", value: "1.000", detail: "Kontakte in SEQUENZ B", accent: "black" },
      { label: "Kontaktanfragen", value: "580", detail: "Gesendet im Haupttest" },
      { label: "Angenommen", value: "273", detail: "47,1% der Anfragen", accent: "yellow" },
      { label: "Nachrichten", value: "274", detail: "Erste Nachrichten gesendet" },
      { label: "Antworten", value: "44", detail: "16,1% Antwortrate", accent: "yellow" },
      { label: "Positive Antworten", value: "11", detail: "25,0% der Antworten", accent: "red" },
      { label: "Call-Potenzial", value: "1 + 5", detail: "1 explizit, 5 qualifiziert", accent: "red" },
    ],
    funnel,
    responseClusters: [
      {
        title: "Kontextfrage: welcher Arbeitgeber oder Vertrag?",
        count: 14,
        positive: 6,
        interpretation:
          "Der Einstieg erzeugt Aufmerksamkeit, aber viele Personen brauchen mehr Kontext, warum Degura sie genau anspricht.",
        implication:
          "Die nächste Variante sollte den alten Arbeitgeber oder den Anlass klarer machen, sofern diese Information sauber vorliegt.",
      },
      {
        title: "Sprachwechsel oder Englisch benötigt",
        count: 7,
        positive: 2,
        interpretation:
          "Ein Teil der Zielgruppe ist nicht verloren, sondern braucht eine englische Fortsetzung.",
        implication:
          "Ein kurzer englischer Fallback ist ein sinnvoller Test, besonders bei internationalen Profilen.",
      },
      {
        title: "Unklarer bAV-Status",
        count: 3,
        positive: 0,
        interpretation:
          "Die strenge Clusterzahl ist klein, aber mehrere positive Antworten zeigen dieselbe Unsicherheit: Personen wissen nicht genau, ob und wie sie ihren Arbeitgeberzuschuss nutzen.",
        implication:
          "Der CTA sollte als kurzer Status- oder Anspruchscheck formuliert werden, nicht als allgemeiner Altersvorsorge-Pitch.",
      },
      {
        title: "Explizite Terminbereitschaft",
        count: 1,
        positive: 1,
        interpretation:
          "Eine Person hat konkret vorgeschlagen, das Thema in der nächsten Woche zu besprechen, inklusive möglicher Tage und Uhrzeit.",
        implication:
          "Das ist der klarste Sales-Trigger im Datensatz und sollte getrennt von allgemeinem Interesse ausgewiesen werden.",
      },
      {
        title: "Nicht relevant oder Zielgruppen-Mismatch",
        count: 2,
        positive: 0,
        interpretation:
          "Ein Teil der negativen Antworten entsteht nicht durch die Nachricht, sondern durch falsche oder nicht mehr passende Zielgruppenmerkmale.",
        implication:
          "Vor Skalierung sollten Land, aktueller Beschäftigungsstatus, Arbeitgeberkontext und Sonderfälle wie Selbstständigkeit besser gefiltert werden.",
      },
      {
        title: "Klares Desinteresse",
        count: 1,
        positive: 0,
        interpretation:
          "Direktes Desinteresse ist im Verhältnis zur Antwortmenge niedrig. Viele negative Antworten sind eher Nicht-Passung als Ablehnung.",
        implication:
          "Die Kampagne sollte nicht wegen einzelner Absagen gestoppt werden; wichtiger ist bessere Qualifizierung bei höherem Volumen.",
      },
    ],
    positiveSignals: [
      {
        label: "Englisch als Türöffner",
        example: "Eine interessierte Person bittet darum, die Unterhaltung auf Englisch fortzuführen.",
        meaning: "Die Relevanz ist vorhanden, aber die Sprache erzeugt Reibung.",
        followUp: "Englische Kurzantwort vorbereiten und internationale Profile gezielt markieren.",
      },
      {
        label: "Kontext wird aktiv nachgefragt",
        example: "Mehrere Personen fragen, auf welchen früheren Arbeitgeber sich Degura bezieht.",
        meaning: "Die Nachricht aktiviert Erinnerung, braucht aber mehr Begründung.",
        followUp: "Kontextzeile ergänzen: warum Degura schreibt und worauf sich der Anspruch beziehen könnte.",
      },
      {
        label: "Unsicherheit nach Jobwechsel",
        example: "Eine Person ist neu im Unternehmen und weiß noch nicht, ob der bAV-Zuschuss genutzt wird.",
        meaning: "Das ist ein starker Aufhänger für einen Statuscheck.",
        followUp: "CTA auf einen kurzen Check zuspitzen: 'Wir prüfen, ob etwas ungenutzt bleibt.'",
      },
      {
        label: "Bestehender Zuschuss wird bestätigt",
        example: "Eine Person bestätigt, dass monatlich ein Zuschuss in die Altersvorsorge fließt.",
        meaning: "Das Thema ist konkret und anschlussfähig, auch wenn nicht jeder Fall ein neuer Abschluss ist.",
        followUp: "Folgefrage: ob die aktuelle Lösung passt oder ob Zuschuss und Vertrag vollständig genutzt werden.",
      },
      {
        label: "Terminbereitschaft",
        example: "Eine Person schlägt konkrete Zeiten für die nächste Woche vor.",
        meaning: "Das ist der klarste Sales-Trigger im Datensatz.",
        followUp: "Termin sofort absichern und den Kontext vor dem Gespräch knapp zusammenfassen.",
      },
    ],
    callPotential: {
      title: "Call-Potenzial sauber getrennt",
      summary:
        "Die Detailprüfung der gespeicherten Antworten zeigt einen harten Meeting-Intent und mehrere qualifizierte positive Antworten, die sinnvoll in einen Call oder Buchungslink überführt wurden.",
      items: [
        {
          label: "Explizite Terminbereitschaft",
          value: "1",
          detail: "Inbound-Antwort mit konkretem Vorschlag für nächste Woche, Dienstag oder Mittwoch ab 16 Uhr.",
          emphasis: true,
        },
        {
          label: "Qualifizierte Call-Kandidaten",
          value: "5",
          detail:
            "Positive Antworten mit bAV-Unsicherheit, bestätigtem Zuschuss, Arbeitgeber-Kontextfrage oder neuem Jobstatus.",
        },
        {
          label: "Positive Antworten gesamt",
          value: "13",
          detail: "Alle positiv klassifizierten Reply-Zeilen im Datensatz, inklusive Sprachwechsel und Rückfragen.",
        },
        {
          label: "Booking-CTA gesendet",
          value: "12",
          detail:
            "Outbound-Follow-ups mit Buchungslink nach positiver Klassifizierung; nicht als inbound Call-Anfrage gezählt.",
        },
      ],
      note:
        "Wichtig für die Bewertung: Der Bericht zählt nur echte eingehende Terminbereitschaft als expliziten Call-Intent. Booking-Link-Texte, die wir danach verschickt haben, werden separat ausgewiesen.",
    },
    copyLearnings: [
      "Die Nachricht funktioniert dort gut, wo Personen ihren aktuellen bAV-Status nicht sicher einordnen können.",
      "Der Kontext zum früheren Arbeitgeber sollte früher und klarer kommen.",
      "Ein englischer Fallback ist kein Nice-to-have, sondern ein messbarer Testpunkt.",
      "Die stärkere Formulierung ist ein Statuscheck oder Anspruchscheck, nicht ein allgemeiner Rentenhinweis.",
      "Negative Antworten sollten getrennt werden: echtes Desinteresse, falsche Zielgruppe und aktuell nicht relevant sind unterschiedliche Fälle.",
    ],
    volumeScenarios: [
      {
        label: "1 Account",
        weeklyInvites: 50,
        note: "Sauberer Basistest, aber langsamer Weg zu belastbarer Fallzahl.",
      },
      {
        label: "2 Accounts",
        weeklyInvites: 100,
        note: "Sinnvoller nächster Schritt, wenn Qualität und Account-Sicherheit stabil bleiben.",
      },
      {
        label: "3 Accounts",
        weeklyInvites: 150,
        note: "Schnellerer Lernzyklus, aber nur mit sauberer Lead-Qualifizierung und Wochenkontrolle.",
      },
    ],
    nextActions: [
      "Volumen kontrolliert erhöhen: mehr qualifizierte Kontakte oder zusätzliche sichere Senderkapazität.",
      "Vergleichsbasis behalten: SEQUENZ B bleibt Bezugspunkt für die nächste Auswertung.",
      "Eine klare Textvariante testen: Kontextzeile plus Statuscheck-CTA.",
      "Call-Potenzial separat tracken: explizite Terminbereitschaft, qualifizierte Call-Kandidaten und outbound Booking-CTA nicht vermischen.",
      "Antworten wöchentlich clustern: Interesse, Kontextfrage, Sprachwechsel, Nicht-Passung, klares Desinteresse.",
    ],
    methodology: [
      "Gezählt wurden Kontaktanfragen, angenommene Kontakte, gesendete erste Nachrichten und erkannte Antworten.",
      "Als positiv gelten Antworten mit Interesse, Rückfragen, Terminbereitschaft oder relevanter Unsicherheit.",
      "Als negativ gelten klares Desinteresse, Nicht-Passung, falscher Kontext, Ausland, Selbstständigkeit oder bereits gelöste Versorgung.",
      "Die Cluster fassen Muster zusammen, damit Marketingentscheidungen nicht aus einzelnen Inbox-Beispielen abgeleitet werden.",
    ],
  };
}
