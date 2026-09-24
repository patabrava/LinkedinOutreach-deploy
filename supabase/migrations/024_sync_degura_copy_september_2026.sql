-- Apply the September 2026 corrections from the sole approved campaign source.
-- The earlier copy migration remains immutable; this forward patch is safe to
-- rerun and updates only the six active managed DEGURA variants.

DO $$
BEGIN
  IF (SELECT count(*)
      FROM outreach_sequence_variants AS variant
      JOIN outreach_sequences AS sequence ON sequence.id = variant.sequence_id
      WHERE sequence.campaign_key IN ('DEGURA_A', 'DEGURA_B', 'DEGURA_C')
        AND sequence.is_active
        AND variant.is_active) <> 6 THEN
    RAISE EXCEPTION 'DEGURA_COPY_PATCH_FAILED: expected six active variants';
  END IF;
END $$;

WITH raw_patch(campaign_key, variant_key, field_name, content) AS (
  VALUES
    ('DEGURA_A', 1, 'second_message',
$copy${{first_name}}, ich schiebe noch einen Gedanken nach, dann lasse ich dich in Ruhe.

Eine Betriebsrente scheitert selten am Interesse der Mitarbeitenden. Fast immer am Aufwand. Verträge in der Abrechnung anlegen, Ein- und Austritte pflegen, Rückfragen beantworten, die du rechtlich gar nicht beantworten darfst.

Genau diesen Teil übernehmen wir komplett, inklusive Altverträgen und der Anbindung an eure Payroll. Bedeutet konkret: bis zu 80 Prozent weniger Verwaltungsaufwand. Hands-off bAV.

Lohnt sich für dich ein Blick darauf, wie das bei {{company_name}} aussehen würde? 30 Minuten, unverbindlich.

Toby, unser bAV Experte, kann es Dir zeigen: https://calendly.com/toby-weber-degura/videotelefonat-mit-toby-30min$copy$),

    ('DEGURA_A', 2, 'first_message',
$copy$Danke fürs Vernetzen, {{first_name}}.

Eine Frage, weil du gerade wahrscheinlich mitten drin bist: Fragen deine Mitarbeitenden seit der Rentenkommission häufiger nach der bAV?

Ich frage, weil das bei vielen HR-Teams, mit denen ich rede, gerade passiert. Und weil die Antwort darauf fast immer davon abhängt, wie viel Aufwand eine bAV im Alltag macht. Wenn jede Rückfrage drei Stunden Handarbeit bedeutet, wird aus dem Thema nie ein echtes strategisches Benefit.

Wie ist die bAV bei {{company_name}} gerade aufgestellt?$copy$),

    ('DEGURA_A', 2, 'second_message',
$copy$Noch ein Punkt, {{first_name}}, dann bin ich still.

Eine bAV wird erst dann als Benefit wahrgenommen, wenn der Arbeitgeber sichtbar etwas dazugibt. Ohne Zuschuss hört dein Team: "mir wird was vom Gehalt abgezogen". Mit spürbarem Zuschuss hört es: "mein Arbeitgeber legt für mich drauf".

Das ist derselbe Vertrag. Nur eine andere Geschichte. Und genau diese freiwillige Verbreitung will die Reform erreichen, ohne Zwang.

Hast du diese oder nächste Woche Zeit für einen kurzen Call? Herr Weber, unser bAV Experte, kann Dir in 30 Minuten unverbindlich zeigen, was sich für deine Belegschaft rechnet: https://calendly.com/toby-weber-degura/videotelefonat-mit-toby-30min$copy$),

    ('DEGURA_B', 2, 'first_message',
$copy$Danke fürs Vernetzen, {{first_name}}.

Etwas, das ich in vielen HR Gesprächen höre: Die bAV ist eingerichtet, sie erfüllt die gesetzliche Pflicht, und trotzdem nutzt sie kaum jemand. Meistens nicht, weil das Interesse fehlt, sondern weil sie nicht richtig kommuniziert wird. Wie macht ihr es aktuell bei {{company_name}}?

Wir haben zusammengefasst, wie {{company_name}} die bAV als ein strategisches Benefit nutzen kann, welches echte Wirkung zeigt und Talente langfristig bindet. Soll ich dir den Leitfaden schicken?$copy$),

    ('DEGURA_C', 1, 'connect_note',
$copy$Guten Tag {{full_name}}, wir haben einen Leitfaden für HR-Verantwortliche zur betrieblichen Altersvorsorge erstellt: Durchführungswege, Pflichten aus dem BetrAVG, Reform 2027. Ich würde mich gern mit Ihnen vernetzen und ihn zusenden.$copy$),

    ('DEGURA_C', 1, 'first_message',
$copy$Vielen Dank für die Vernetzung.

Kurz zum Anlass: Die betriebliche Altersvorsorge ist in vielen HR-Abteilungen ein dauerhafter Aufwandstreiber. Rückfragen von Mitarbeitenden, Abstimmung mit der Lohnbuchhaltung, Pflege von Vertragsänderungen. Gleichzeitig steht HR in der Pflicht, das Thema strategisch sauber aufzustellen.

Wir haben einen Leitfaden erstellt, der beides zusammenbringt: die operativen Fallstricke und die strategischen Hebel. Fünf Durchführungswege im Vergleich, Pflichten aus dem BetrAVG, Ausblick auf die Reform 2027.

Darf ich Ihnen den Leitfaden zukommen lassen?$copy$),

    ('DEGURA_C', 1, 'second_message',
$copy$Hallo, ein Aspekt, der in der Praxis regelmäßig unterschätzt wird.

Wenn Mitarbeitende über Entgeltumwandlung in die bAV einzahlen, entfallen für {{company_name}} die Sozialabgaben auf diese Beiträge. Aus diesen Ersparnissen lässt sich der gesetzliche Mindestzuschuss von 15 Prozent in vielen Fällen vollständig gegenfinanzieren. Wie weit das im Einzelfall trägt, hängt von Gehaltsstruktur und Beteiligungsquote ab.

Für die Geschäftsführung ist das ein anderes Gespräch als das über einen Kostenblock.

Der Leitfaden enthält die Rechenlogik dazu. Soll ich ihn Ihnen zusenden?$copy$),

    ('DEGURA_C', 2, 'connect_note',
$copy$Guten Tag {{full_name}}, ich arbeite mit HR-Verantwortlichen an der Digitalisierung der betrieblichen Altersvorsorge. Bei {{company_name}} dürfte das Thema Substanz haben. Ich würde mich gern mit Ihnen vernetzen.$copy$)
),
copy_patch AS (
  SELECT campaign_key,
         variant_key,
         max(content) FILTER (WHERE field_name = 'connect_note') AS connect_note,
         max(content) FILTER (WHERE field_name = 'first_message') AS first_message,
         max(content) FILTER (WHERE field_name = 'second_message') AS second_message
  FROM raw_patch
  GROUP BY campaign_key, variant_key
)
UPDATE outreach_sequence_variants AS variant
SET connect_note = coalesce(copy_patch.connect_note, variant.connect_note),
    first_message = coalesce(copy_patch.first_message, variant.first_message),
    second_message = coalesce(copy_patch.second_message, variant.second_message),
    updated_at = now()
FROM outreach_sequences AS sequence, copy_patch
WHERE sequence.id = variant.sequence_id
  AND sequence.campaign_key = copy_patch.campaign_key
  AND variant.variant_key = copy_patch.variant_key
  AND sequence.is_active
  AND variant.is_active;
