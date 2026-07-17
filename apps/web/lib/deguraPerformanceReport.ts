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
  note: string;
};

export type CallPotentialItem = {
  label: string;
  value: string;
  detail: string;
  emphasis?: boolean;
};

export type ConversationHighlight = {
  name: string;
  company: string;
  category: string;
  timeline: string;
  inbound: string;
  handling: string;
  whyItMatters: string;
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
  conversationHighlights: ConversationHighlight[];
  weeklyTracking: PeriodMetric[];
  monthlyTracking: PeriodMetric[];
  volumeScenarios: VolumeScenario[];
  nextActions: string[];
  methodology: string[];
};

const formatPercent = (value: number) => `${value.toFixed(1).replace(".", ",")}%`;

const funnel = [
  {
    label: "Kontakte im Haupttest",
    count: 3184,
    rateLabel: "Basis: SEQUENZ B / Batch 21",
    rate: 100,
  },
  {
    label: "Kontaktanfragen gesendet",
    count: 1077,
    rateLabel: `${formatPercent(33.8)} der Testkontakte`,
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
    rateLabel: `${formatPercent(99)} der angenommenen Kontakte`,
    rate: 99,
  },
  {
    label: "Antwortsignale",
    count: 61,
    rateLabel: `${formatPercent(19.9)} der Nachrichten`,
    rate: 19.9,
  },
  {
    label: "Lesbare Reply-Snippets",
    count: 55,
    rateLabel: "Qualitative Gesprächsanalyse",
    rate: 90.2,
  },
  {
    label: "Positive Gespräche",
    count: 12,
    rateLabel: `${formatPercent(22.6)} der lesbaren Snippets`,
    rate: 22.6,
  },
];

export function getDeguraPerformanceReport(): DeguraPerformanceReport {
  return {
    snapshotAt: "17. Juli 2026, 14:02 Uhr MESZ",
    campaignWindow: "Seit Start des Degura LinkedIn-Outreach-Prozesses",
    sourceLabel: "Auswertung aus dem LinkedIn-Outreach-System, Snapshot 2026-07-17",
    planningAssumption:
      "Für die operative Planung rechnen wir konservativ mit ca. 50 Kontaktanfragen pro LinkedIn-Account und Woche. LinkedIn veröffentlicht kein fixes Limit; das tatsächliche Limit hängt vom Account und vom Verhalten ab.",
    hero: {
      eyebrow: "Degura Marketing-Auswertung",
      title: "DEGURA OUTREACH PERFORMANCE",
      summary:
        "Die aktualisierte Auswertung zeigt mehr Top-of-Funnel-Volumen und eine stabilere Reporting-Basis: 1.077 Kontaktanfragen, 307 erste Nachrichten, 61 Antwortsignale und 55 lesbare Gespräche. Die neue Wochen- und Monatsansicht macht sichtbar, wann Volumen entsteht und wann daraus Antworten werden.",
    },
    kpis: [
      { label: "Leads im System", value: "3.186", detail: "Gesamter Datenbestand" },
      { label: "Hauptsequenz", value: "3.184", detail: "Kontakte in SEQUENZ B", accent: "black" },
      { label: "Kontaktanfragen", value: "1.077", detail: "Gesendet im Haupttest" },
      { label: "Angenommen", value: "311", detail: "28,9% der Anfragen", accent: "yellow" },
      { label: "Nachrichten", value: "307", detail: "Erste Nachrichten gesendet" },
      { label: "Antwortsignale", value: "61", detail: "19,9% der Nachrichten", accent: "yellow" },
      { label: "Positive Gespräche", value: "12", detail: "21,8% der lesbaren Snippets", accent: "red" },
      { label: "Call-Potenzial", value: "1 + 6", detail: "1 explizit, 6 qualifiziert", accent: "red" },
    ],
    funnel,
    responseClusters: [
      {
        title: "Zuschuss- oder bAV-Unsicherheit",
        count: 5,
        positive: 4,
        interpretation:
          "Mehrere Antworten zeigen genau den Kern-Hook der Kampagne: Personen wissen nicht sicher, ob sie den Zuschuss nutzen, haben keinen aktuellen Stand oder klären das Thema gerade erst.",
        implication:
          "Der stärkste CTA bleibt ein kurzer Statuscheck statt eines allgemeinen Vorsorge-Pitches.",
      },
      {
        title: "Kontextfrage: welcher Arbeitgeber oder warum Degura?",
        count: 4,
        positive: 3,
        interpretation:
          "Diese Antworten sind nicht automatisch Ablehnung. Sie zeigen, dass der Anlass der Ansprache und der frühere Arbeitgeber früher erklärt werden müssen.",
        implication:
          "Die nächste Textvariante sollte den Bezug in einer eigenen Kontextzeile sichtbar machen.",
      },
      {
        title: "Sprachwechsel oder Englisch benötigt",
        count: 2,
        positive: 2,
        interpretation:
          "Ein Teil der Zielgruppe ist erreichbar, aber die deutsche Erstnachricht erzeugt Reibung.",
        implication:
          "Internationale Profile sollten eine englische Folgeantwort oder direkt eine englische Variante erhalten.",
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
        count: 21,
        positive: 0,
        interpretation:
          "Viele negative Antworten kommen aus Auslandswechsel, Selbstständigkeit, fehlendem Arbeitgeber, Arbeitslosigkeit, falschem Arbeitgeberkontext oder nicht mehr passender Zielgruppe.",
        implication:
          "Vor Skalierung sollten Land, aktueller Beschäftigungsstatus, Arbeitgeberkontext und Sonderfälle wie Selbstständigkeit besser gefiltert werden.",
      },
      {
        title: "Bereits versorgt oder klares Desinteresse",
        count: 16,
        positive: 0,
        interpretation:
          "Ein relevanter Teil ist bereits abgesichert, hat einen Anbieter, lehnt bAV bewusst ab oder möchte keine weitere Ansprache.",
        implication:
          "Diese Gespräche sind wertvoll für Ausschlusslogik und Tonalität, aber nicht für kurzfristiges Sales-Potenzial.",
      },
    ],
    positiveSignals: [
      {
        label: "Unsicherheit als stärkster Aufhänger",
        example: "Eine Person ist neu im Unternehmen und weiß noch nicht, ob und in welchem Umfang der bAV-Zuschuss genutzt wird.",
        meaning: "Die Kampagne trifft dann, wenn der Status offen oder ungeprüft ist.",
        followUp: "Statuscheck als primären CTA ausspielen.",
      },
      {
        label: "Kontext wird aktiv nachgefragt",
        example: "Mehrere Personen fragen nach dem früheren Arbeitgeber oder warum Degura sie anspricht.",
        meaning: "Die Nachricht aktiviert Erinnerung, braucht aber mehr Begründung.",
        followUp: "Kontextzeile ergänzen: warum Degura schreibt und worauf sich der Anspruch beziehen könnte.",
      },
      {
        label: "Englisch als Türöffner",
        example: "Zwei positive Antworten bitten um Englisch oder sagen, dass Deutsch nicht funktioniert.",
        meaning: "Die Relevanz ist vorhanden, aber die Sprache erzeugt Reibung.",
        followUp: "Englische Kurzantwort vorbereiten und internationale Profile gezielt markieren.",
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
        "Die Detailprüfung der gespeicherten Antworten zeigt einen harten Meeting-Intent und sechs qualifizierte positive Antworten, die sinnvoll in einen Call oder Buchungslink überführt wurden.",
      items: [
        {
          label: "Explizite Terminbereitschaft",
          value: "1",
          detail: "Inbound-Antwort mit konkretem Vorschlag für nächste Woche, Dienstag oder Mittwoch ab 16 Uhr.",
          emphasis: true,
        },
        {
          label: "Qualifizierte Call-Kandidaten",
          value: "6",
          detail:
            "Positive Antworten mit bAV-Unsicherheit, bestätigtem Zuschuss, Arbeitgeber-Kontextfrage, Sprachwechsel oder neuem Jobstatus.",
        },
        {
          label: "Positive Antworten gesamt",
          value: "12",
          detail: "Alle positiv klassifizierten lesbaren Reply-Snippets in der Hauptsequenz.",
        },
        {
          label: "Booking-CTA gesendet",
          value: "13",
          detail:
            "Outbound-Follow-ups mit Buchungslink nach positiver Klassifizierung, inklusive einer Zusatznachricht mit korrigiertem Link.",
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
    conversationHighlights: [
      {
        name: "Thomas Rolfsmeyer-Wicklein",
        company: "Aginode",
        category: "Explizite Terminbereitschaft",
        timeline: "Reply am 26. Juni 2026; Booking-CTA danach gesendet.",
        inbound:
          "Er entschuldigt die späte Antwort und schlägt vor, das Thema in der nächsten Woche zu besprechen, Dienstag oder Mittwoch ab 16 Uhr.",
        handling:
          "Wir haben den Team-Kalender geschickt und den Fall als expliziten Meeting-Intent gezählt.",
        whyItMatters:
          "Das ist der klarste Beweis, dass der Statuscheck-CTA nicht nur Antworten, sondern konkrete Gesprächsbereitschaft erzeugen kann.",
        emphasis: true,
      },
      {
        name: "Saktheesh Muneeswaran",
        company: "reev",
        category: "bAV-Status unklar",
        timeline: "Reply am 5. Juni 2026; Booking-Link als Follow-up gesendet.",
        inbound:
          "Er ist erst vor Kurzem ins Unternehmen eingetreten und ist nicht sicher, ob oder in welchem Umfang er den Zuschuss nutzt.",
        handling:
          "Wir haben den Fall als sinnvollen kurzen Check eingeordnet und direkt auf einen Termin mit bAV-Experten geführt.",
        whyItMatters:
          "Dieses Muster passt exakt zur Degura-Hypothese: Jobwechsel erzeugt Unsicherheit, die mit einem kurzen Check auflösbar ist.",
      },
      {
        name: "Sriram Raghunathan",
        company: "Taxdoo",
        category: "Keine aktuelle Altersvorsorge",
        timeline: "Reply am 9. Juni 2026; Booking-Link als Follow-up gesendet.",
        inbound:
          "Er schreibt, dass er derzeit keine Altersvorsorge hat und nicht sicher ist, ob der nächste Arbeitgeber etwas anbietet.",
        handling:
          "Wir haben den Status als qualifizierten Check-Anlass behandelt und zum bAV-Termin weitergeleitet.",
        whyItMatters:
          "Das ist ein starkes Beispiel für latente Nachfrage: kein harter Terminwunsch, aber ein klares offenes Vorsorgethema.",
      },
      {
        name: "Tommy Nieminen",
        company: "Munich Electrification",
        category: "Zuschuss bestätigt",
        timeline: "Reply am 24. Juni 2026; Booking-Link als Follow-up gesendet.",
        inbound:
          "Er bestätigt, dass monatlich ein Zuschuss in die Altersvorsorge eingezahlt wird.",
        handling:
          "Wir haben auf einen kurzen Check fokussiert, ob der Zuschuss sauber genutzt wird.",
        whyItMatters:
          "Auch bereits aktive Zuschüsse können ein Gespräch wert sein, wenn Optimierung oder Vollständigkeit geprüft werden soll.",
      },
      {
        name: "Dennis Proll",
        company: "Microsoft",
        category: "Outbound-Nurture ohne Inbound-Reply",
        timeline: "Connect am 16. Juni, erster Text am 16. Juni, Follow-up am 25. Juni, dritte Nachricht am 8. Juli 2026.",
        inbound:
          "Für Dennis Proll ist im System noch keine eingehende Antwort gespeichert.",
        handling:
          "Die komplette Sequenz wurde ausgespielt: Erstnachricht zur bAV nach Arbeitgeberwechsel, Follow-up zum ungenutzten Zuschuss und finale Nachricht zu Zuschuss, Steuerförderung und Altersvorsorgedepot.",
        whyItMatters:
          "Der Fall zeigt, warum der Report Gespräche und Sequenzabdeckung trennt: Nicht jede sichtbare Konversation ist ein Reply, aber die Nurture-Strecke ist vollständig dokumentiert.",
      },
      {
        name: "Daniel Wolde-Selassie",
        company: "BRITA Group",
        category: "Kontextkritische Rückfrage",
        timeline: "Reply am 9. Juli 2026; Antwort wurde anschließend gesendet.",
        inbound:
          "Er fragt nach der Einladung, ob man sich kennt.",
        handling:
          "Der Entwurf erklärt knapp, dass noch kein persönlicher Kontakt bestand und dass der Anlass ein kurzer bAV-Check nach Arbeitgeberwechsel ist.",
        whyItMatters:
          "Das neueste Reply-Signal zeigt, dass Kontext und Beziehungserklärung in der Erstnachricht noch stärker sein müssen.",
      },
      {
        name: "Gal Schkolnik",
        company: "Mondly by Pearson",
        category: "Kein Arbeitgeber",
        timeline: "Reply am 17. Juli 2026; steht zur manuellen Prüfung an.",
        inbound:
          "Er weist darauf hin, dass er keinen Arbeitgeber hat und dass dies im Profil sichtbar gewesen wäre.",
        handling:
          "Der Fall gehört nicht in das positive Potenzial, sondern in die Zielgruppen- und Datenqualitätsauswertung.",
        whyItMatters:
          "Das Beispiel zeigt, warum wöchentlich nicht nur Volumen, sondern auch Ausschlussgründe getrackt werden sollten.",
      },
      {
        name: "Matthias Weiss",
        company: "Text: van Laak",
        category: "Selbstständigkeit",
        timeline: "Reply am 17. Juli 2026; steht zur manuellen Prüfung an.",
        inbound:
          "Er erklärt, dass er selbstständig ist und die Ansprache durch bessere Profilrecherche vermeidbar gewesen wäre.",
        handling:
          "Der Fall wird als Zielgruppen-Mismatch gelesen, nicht als Verkaufschance.",
        whyItMatters:
          "Das ist ein klares Signal für bessere Vorfilterung vor zusätzlichem Skalierungsvolumen.",
      },
    ],
    weeklyTracking: [
      {
        label: "KW 26",
        range: "22.-28. Juni",
        connectionRequests: 18,
        acceptedContacts: 22,
        firstMessages: 22,
        replySignals: 9,
        readableReplies: 9,
        positiveReplies: 3,
        followupsSent: 0,
        note: "Antwortqualität war hoch, aber das neue Anfragevolumen war niedrig.",
      },
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
        note: "Stärkste Follow-up-Woche: viele Booking- und Reply-Follow-ups wurden nachgezogen.",
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
        followupsSent: 1,
        note: "Viel Top-of-Funnel, aber kaum neue Annahmen und dadurch keine neuen ersten Nachrichten.",
      },
      {
        label: "KW 29",
        range: "13.-17. Juli",
        connectionRequests: 214,
        acceptedContacts: 1,
        firstMessages: 0,
        replySignals: 2,
        readableReplies: 2,
        positiveReplies: 0,
        followupsSent: 0,
        note: "Aktuelle Woche ist ein Teilzeitraum; beide neuen Antworten zeigen Zielgruppen-Mismatch.",
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
        note: "Setup- und Startphase mit kleinem Volumen.",
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
        followupsSent: 4,
        note: "Erste belastbare Antwortbasis; Annahmen und erste Nachrichten liefen noch eng zusammen.",
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
        followupsSent: 1,
        note: "Bester Monat für qualifizierte Antworten und Call-Potenzial.",
      },
      {
        label: "Juli MTD",
        range: "1.-17. Juli",
        connectionRequests: 451,
        acceptedContacts: 5,
        firstMessages: 0,
        replySignals: 16,
        readableReplies: 12,
        positiveReplies: 1,
        followupsSent: 47,
        note: "Juli zeigt viel neues Anfragevolumen, aber die Wirkung liegt zeitversetzt in Annahmen und Antworten.",
      },
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
