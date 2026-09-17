-- Align the paused Katharina COP InMail campaign with the formal DEGURA C style.
-- Keep the former employer as the company personalization source.
UPDATE outreach_sequences
SET
  first_message = $copy$
Guten Tag {{first_name}} {{last_name}},

wir haben mit Ihrem früheren Arbeitgeber {{company_name}} im Bereich der betrieblichen Altersvorsorge zusammengearbeitet.

Nach einem Arbeitgeberwechsel ist häufig unklar, wie es mit der bAV weitergeht. Infrage kommen eine Übertragung auf den neuen Arbeitgeber, eine private Weiterführung oder eine Beitragsfreistellung.

Haben Sie inzwischen einen neuen Arbeitgeber? Wenn Sie mir kurz antworten, kann ich Ihnen die passenden nächsten Schritte nennen.

Viele Grüße
Katharina$copy$,
  second_message = $copy$
Noch ein Punkt, {{first_name}}, dann komme ich nicht mehr darauf zurück.

Bei einem Arbeitgeberwechsel ist nicht nur die Frage entscheidend, ob der Vertrag weiterläuft. Auch die weitere Behandlung sollte sauber geklärt werden: Übertragung auf den neuen Arbeitgeber, private Weiterführung oder Beitragsfreistellung.

Welche Option passt, hängt vom bestehenden Vertrag und Ihrer aktuellen Situation ab.

Ist das für Sie bereits geklärt? Wenn Sie mir kurz antworten, kann ich Ihnen die nächsten Schritte nennen.

Viele Grüße
Katharina$copy$,
  third_message = $copy$
{{first_name}}, dies ist meine letzte Nachricht zu dem Thema.

Ist die betriebliche Altersvorsorge nach Ihrem Austritt bei {{company_name}} bereits geklärt, oder bin ich bei der falschen Ansprechperson gelandet? Im zweiten Fall: Wer wäre zuständig?

Im ersten Fall: verständlich. Wenn sich daran etwas ändert, können Sie sich jederzeit melden.

Viele Grüße
Katharina$copy$,
  updated_at = now()
WHERE id = 10
  AND name = 'COP bAV InMail · Katharina · 2026-09-17'
  AND delivery_mode = 'invite_and_inmail';
