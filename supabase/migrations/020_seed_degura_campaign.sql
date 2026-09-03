-- Seed the approved DEGURA LinkedIn campaign families and stable A/B variants.

INSERT INTO outreach_sequences (
  name, campaign_key, tone, primary_goal, is_managed_campaign, is_active
)
SELECT 'DEGURA A · Rentenreform', 'DEGURA_A', 'du', 'call', TRUE, TRUE
WHERE NOT EXISTS (SELECT 1 FROM outreach_sequences WHERE campaign_key = 'DEGURA_A');

INSERT INTO outreach_sequences (
  name, campaign_key, tone, primary_goal, is_managed_campaign, is_active
)
SELECT 'DEGURA B · bAV Leitfaden Du', 'DEGURA_B', 'du', 'guide_then_call', TRUE, TRUE
WHERE NOT EXISTS (SELECT 1 FROM outreach_sequences WHERE campaign_key = 'DEGURA_B');

INSERT INTO outreach_sequences (
  name, campaign_key, tone, primary_goal, is_managed_campaign, is_active
)
SELECT 'DEGURA C · bAV Leitfaden Sie', 'DEGURA_C', 'sie', 'guide_then_call', TRUE, TRUE
WHERE NOT EXISTS (SELECT 1 FROM outreach_sequences WHERE campaign_key = 'DEGURA_C');

UPDATE outreach_sequences SET
  name = 'DEGURA A · Rentenreform', tone = 'du', primary_goal = 'call',
  is_managed_campaign = TRUE, is_active = TRUE
WHERE campaign_key = 'DEGURA_A';
UPDATE outreach_sequences SET
  name = 'DEGURA B · bAV Leitfaden Du', tone = 'du', primary_goal = 'guide_then_call',
  is_managed_campaign = TRUE, is_active = TRUE
WHERE campaign_key = 'DEGURA_B';
UPDATE outreach_sequences SET
  name = 'DEGURA C · bAV Leitfaden Sie', tone = 'sie', primary_goal = 'guide_then_call',
  is_managed_campaign = TRUE, is_active = TRUE
WHERE campaign_key = 'DEGURA_C';

INSERT INTO outreach_sequence_variants (
  sequence_id, variant_key, connect_note, first_message, second_message,
  third_message, asset_followup_1, asset_followup_2
)
SELECT s.id, 1,
$copy$Hallo {{first_name}}, seit dem Bericht der Rentenkommission fragen Mitarbeitende bei HR nach ihrer Rente. Ich sehe gerade, wie Unternehmen wie {{company_name}} darauf antworten. Würde mich gern mit dir vernetzen.$copy$,
$copy$Danke fürs Vernetzen, {{first_name}}.

Kurz, warum ich dich angeschrieben habe: Die Rentenkommission empfiehlt keine Pflicht zur Betriebsrente. Das wird oft falsch berichtet. Sie empfiehlt, dass mehr Unternehmen freiwillig eine anbieten, über einfachere Prozesse, Portabilität und weniger Bürokratie.

Nur ändert eine Empfehlung nichts daran, dass die Frage "und was ist mit meiner Rente?" schon jetzt bei dir landet und nicht erst, wenn ein Gesetz kommt.

Wie ist die bAV bei {{company_name}} gerade aufgestellt?$copy$,
$copy${{first_name}}, ich schiebe noch einen Gedanken nach, dann lasse ich dich in Ruhe.

Eine Betriebsrente scheitert selten am Interesse der Mitarbeitenden. Fast immer am Aufwand. Verträge in der Abrechnung anlegen, Ein- und Austritte pflegen, Rückfragen beantworten, die du rechtlich gar nicht beantworten darfst.

Genau diesen Teil übernehmen wir komplett, inklusive Altverträgen und der Anbindung an eure Payroll. Bedeutet konkret: rund 80 Prozent weniger Verwaltungsaufwand. Hands-off bAV.

Lohnt sich für dich ein Blick darauf, wie das bei {{company_name}} aussehen würde? 30 Minuten, unverbindlich.$copy$,
$copy${{first_name}}, ich gehe davon aus, dass bAV bei dir gerade nicht oben auf der Liste steht. Völlig in Ordnung.

Zwei Sätze noch, dann melde ich mich nicht mehr aktiv. Falls das Thema doch hochkommt, etwa weil jemand aus dem Team fragt oder der Gesetzgebungsprozess in Gang kommt: schreib mir einfach. Und falls jemand anderes bei {{company_name}} dafür zuständig ist, sag mir gern wer, dann spare ich dir die weiteren Nachrichten.

Ansonsten: viel Erfolg mit dem Rest der Liste.$copy$,
$copy${{first_name}}, hattest du reingeschaut?

Falls ja, interessiert mich eine Sache: Welcher Teil war für {{company_name}} am relevantesten? Ich frage nicht aus Höflichkeit, sondern weil die Antwort meistens zeigt, wo bei euch der Schuh drückt.$copy$,
$copy$Letzter Anstoß von mir, {{first_name}}.

Der Leitfaden zeigt, wie bAV grundsätzlich funktioniert. Was er nicht zeigt: was bei {{company_name}} tatsächlich rauskommt, mit euren Gehältern, euren Verträgen und euren Systemen. Das rechnen wir in 30 Minuten durch, ohne Präsentation.

Wenn das gerade nicht passt, ist das auch eine Antwort. Dann höre ich auf.$copy$
FROM outreach_sequences s WHERE s.campaign_key = 'DEGURA_A'
ON CONFLICT (sequence_id, variant_key) DO UPDATE SET
  connect_note = EXCLUDED.connect_note, first_message = EXCLUDED.first_message,
  second_message = EXCLUDED.second_message, third_message = EXCLUDED.third_message,
  asset_followup_1 = EXCLUDED.asset_followup_1, asset_followup_2 = EXCLUDED.asset_followup_2,
  is_active = TRUE;

INSERT INTO outreach_sequence_variants (
  sequence_id, variant_key, connect_note, first_message, second_message,
  third_message, asset_followup_1, asset_followup_2
)
SELECT s.id, 2,
$copy$Hallo {{first_name}}, die Rentenkommission hat 33 Empfehlungen abgeliefert, eine davon betrifft HR direkt: die bAV soll deutlich verbreiteter werden. Ich schaue mir an, was das für Teams eurer Größe heißt. Vernetzen wir uns?$copy$,
$copy$Danke fürs Vernetzen, {{first_name}}.

Eine Frage, weil du gerade wahrscheinlich mitten drin bist: Fragen deine Mitarbeitenden seit der Rentendiskussion häufiger nach der bAV?

Ich frage, weil das bei den meisten HR-Teams, mit denen ich rede, gerade passiert. Und weil die Antwort darauf fast immer davon abhängt, wie viel Aufwand eine bAV im Alltag macht. Wenn jede Rückfrage drei Stunden Handarbeit bedeutet, wird aus dem Thema nie ein Benefit.$copy$,
$copy$Noch ein Punkt, {{first_name}}, dann bin ich still.

Eine bAV wird erst dann als Benefit wahrgenommen, wenn der Arbeitgeber sichtbar etwas dazugibt. Ohne Zuschuss hört dein Team: "mir wird was vom Gehalt abgezogen". Mit spürbarem Zuschuss hört es: "mein Arbeitgeber legt für mich drauf".

Das ist derselbe Vertrag. Nur eine andere Geschichte. Und genau diese freiwillige Verbreitung will die Reform erreichen, ohne Zwang.

Ich würde dir gern in 30 Minuten zeigen, was sich für deine Belegschaft rechnet. Passt das diese oder nächste Woche?$copy$,
$copy${{first_name}}, letzte Nachricht von mir.

Ist bAV bei {{company_name}} aktuell kein Thema, oder bin ich einfach bei der falschen Person gelandet? Falls letzteres: wer wäre die richtige?

Falls ersteres: alles gut, ich melde mich nicht mehr.$copy$,
$copy${{first_name}}, hattest du reingeschaut?

Falls ja, interessiert mich eine Sache: Welcher Teil war für {{company_name}} am relevantesten? Ich frage nicht aus Höflichkeit, sondern weil die Antwort meistens zeigt, wo bei euch der Schuh drückt.$copy$,
$copy$Letzter Anstoß von mir, {{first_name}}.

Der Leitfaden zeigt, wie bAV grundsätzlich funktioniert. Was er nicht zeigt: was bei {{company_name}} tatsächlich rauskommt, mit euren Gehältern, euren Verträgen und euren Systemen. Das rechnen wir in 30 Minuten durch, ohne Präsentation.

Wenn das gerade nicht passt, ist das auch eine Antwort. Dann höre ich auf.$copy$
FROM outreach_sequences s WHERE s.campaign_key = 'DEGURA_A'
ON CONFLICT (sequence_id, variant_key) DO UPDATE SET
  connect_note = EXCLUDED.connect_note, first_message = EXCLUDED.first_message,
  second_message = EXCLUDED.second_message, third_message = EXCLUDED.third_message,
  asset_followup_1 = EXCLUDED.asset_followup_1, asset_followup_2 = EXCLUDED.asset_followup_2,
  is_active = TRUE;

INSERT INTO outreach_sequence_variants (
  sequence_id, variant_key, connect_note, first_message, second_message,
  third_message, asset_followup_1, asset_followup_2
)
SELECT s.id, 1,
$copy$Hallo {{first_name}}, wir haben einen bAV-Leitfaden für HR-Teams gemacht: fünf Durchführungswege im Vergleich, Pflichten, Reform 2027. Vernetzen wir uns, dann schicke ich dir den rüber.$copy$,
$copy$Danke fürs Vernetzen, {{first_name}}. Hier ist der Link zu unserem Leitfaden: https://www.degura.de/bav-leitfaden-confirmation. Was mich interessieren würde: Wie verwaltet {{company_name}} aktuell die bAV?$copy$,
$copy${{first_name}}, ein Punkt aus dem Leitfaden, weil er in der Praxis oft überrascht.

Wenn Mitarbeitende über Entgeltumwandlung einzahlen, sparst du als Arbeitgeber die Sozialabgaben auf diese Beträge. In vielen Fällen reicht das, um den gesetzlichen Zuschuss von 15 Prozent gegenzufinanzieren. Wie viel genau bei {{company_name}} hängen bleibt, hängt von Gehältern und Beteiligung ab, die Mechanik ist aber immer dieselbe.

Heißt: bAV muss kein Kostenblock sein. Sie ist meistens nur schlecht aufgesetzt.

Sag kurz Bescheid, dann schicke ich dir den Leitfaden.$copy$,
$copy${{first_name}}, letzte Nachricht.

Ist bAV bei {{company_name}} gerade kein Thema, oder bin ich bei der falschen Person gelandet? Falls letzteres: wer wäre die richtige?

Falls ersteres: alles gut. Der Leitfaden steht, wenn du ihn mal brauchst.$copy$,
$copy${{first_name}}, hattest du reingeschaut?

Falls ja, interessiert mich eine Sache: Welcher Teil war für {{company_name}} am relevantesten? Ich frage nicht aus Höflichkeit, sondern weil die Antwort meistens zeigt, wo bei euch der Schuh drückt.$copy$,
$copy$Letzter Anstoß von mir, {{first_name}}.

Der Leitfaden zeigt, wie bAV grundsätzlich funktioniert. Was er nicht zeigt: was bei {{company_name}} tatsächlich rauskommt, mit euren Gehältern, euren Verträgen und euren Systemen. Das rechnen wir in 30 Minuten durch, ohne Präsentation.

Wenn das gerade nicht passt, ist das auch eine Antwort. Dann höre ich auf.$copy$
FROM outreach_sequences s WHERE s.campaign_key = 'DEGURA_B'
ON CONFLICT (sequence_id, variant_key) DO UPDATE SET
  connect_note = EXCLUDED.connect_note, first_message = EXCLUDED.first_message,
  second_message = EXCLUDED.second_message, third_message = EXCLUDED.third_message,
  asset_followup_1 = EXCLUDED.asset_followup_1, asset_followup_2 = EXCLUDED.asset_followup_2,
  is_active = TRUE;

INSERT INTO outreach_sequence_variants (
  sequence_id, variant_key, connect_note, first_message, second_message,
  third_message, asset_followup_1, asset_followup_2
)
SELECT s.id, 2,
$copy$Hallo {{first_name}}, ich arbeite mit HR-Teams in Unternehmen wie {{company_name}} am Thema betriebliche Altersvorsorge. Würde mich gern vernetzen, dann teile ich ab und zu was, das dir Arbeit spart.$copy$,
$copy$Danke fürs Vernetzen, {{first_name}}.

Etwas, das ich in fast jedem HR-Gespräch höre: Die bAV ist eingerichtet, sie erfüllt die Pflicht aus dem BetrAVG, und trotzdem nutzt sie kaum jemand. Meistens nicht, weil das Interesse fehlt, sondern weil der Weg dahin aus Papier besteht.

Wir haben aufgeschrieben, woran das liegt und was HR-Teams 2026 dazu wissen sollten. Durchführungswege, Pflichten, Reform 2027.

Soll ich dir den Leitfaden schicken?$copy$,
$copy$Noch ein Gedanke, {{first_name}}.

Beim Thema bAV schauen die meisten HR-Teams auf den Verwaltungsaufwand. Verständlich. Die Perspektive, die dabei untergeht, ist die der Mitarbeitenden. Wer seinen Vertrag nicht versteht, nutzt ihn nicht. Und wer ihn nicht nutzt, rechnet ihn dem Arbeitgeber auch nicht als Benefit an.

Über die Degura App sehen deine Leute ihre Vorsorge so, wie sie ihr Konto sehen. Kein Papier, kein Ordner, keine Rückfrage bei dir.

Im Leitfaden steht, was das konkret für die Beteiligung bedeutet. Soll ich ihn dir schicken?$copy$,
$copy$Ich höre auf zu fragen, {{first_name}}.

Falls das Thema irgendwann hochkommt, weil jemand aus dem Team fragt oder ihr in einer Verhandlung ein Benefit braucht: eine Zeile von dir reicht, dann hast du den Leitfaden am selben Tag.

Bis dahin viel Erfolg.$copy$,
$copy${{first_name}}, hattest du reingeschaut?

Falls ja, interessiert mich eine Sache: Welcher Teil war für {{company_name}} am relevantesten? Ich frage nicht aus Höflichkeit, sondern weil die Antwort meistens zeigt, wo bei euch der Schuh drückt.$copy$,
$copy$Letzter Anstoß von mir, {{first_name}}.

Der Leitfaden zeigt, wie bAV grundsätzlich funktioniert. Was er nicht zeigt: was bei {{company_name}} tatsächlich rauskommt, mit euren Gehältern, euren Verträgen und euren Systemen. Das rechnen wir in 30 Minuten durch, ohne Präsentation.

Wenn das gerade nicht passt, ist das auch eine Antwort. Dann höre ich auf.$copy$
FROM outreach_sequences s WHERE s.campaign_key = 'DEGURA_B'
ON CONFLICT (sequence_id, variant_key) DO UPDATE SET
  connect_note = EXCLUDED.connect_note, first_message = EXCLUDED.first_message,
  second_message = EXCLUDED.second_message, third_message = EXCLUDED.third_message,
  asset_followup_1 = EXCLUDED.asset_followup_1, asset_followup_2 = EXCLUDED.asset_followup_2,
  is_active = TRUE;

INSERT INTO outreach_sequence_variants (
  sequence_id, variant_key, connect_note, first_message, second_message,
  third_message, asset_followup_1, asset_followup_2
)
SELECT s.id, 1,
$copy$Guten Tag {{first_name}}, wir haben einen Leitfaden für HR-Verantwortliche zur betrieblichen Altersvorsorge erstellt: Durchführungswege, Pflichten aus dem BetrAVG, Reform 2027. Ich würde mich gern mit Ihnen vernetzen und ihn zusenden.$copy$,
$copy$Vielen Dank für die Vernetzung, {{first_name}}.

Kurz zum Anlass: Die betriebliche Altersvorsorge ist in vielen HR-Abteilungen ein dauerhafter Aufwandstreiber. Rückfragen von Mitarbeitenden, Abstimmung mit der Lohnbuchhaltung, Pflege von Vertragsänderungen. Gleichzeitig steht HR in der Pflicht, das Thema strategisch sauber aufzustellen.

Wir haben einen Leitfaden erstellt, der beides zusammenbringt: die operativen Fallstricke und die strategischen Hebel. Fünf Durchführungswege im Vergleich, Pflichten aus dem BetrAVG, Ausblick auf die Reform 2027.

Darf ich Ihnen den Leitfaden zukommen lassen?$copy$,
$copy${{first_name}}, ein Aspekt, der in der Praxis regelmäßig unterschätzt wird.

Wenn Mitarbeitende über Entgeltumwandlung in die bAV einzahlen, entfallen für {{company_name}} die Sozialabgaben auf diese Beiträge. Aus diesen Ersparnissen lässt sich der gesetzliche Mindestzuschuss von 15 Prozent in vielen Fällen vollständig gegenfinanzieren. Wie weit das im Einzelfall trägt, hängt von Gehaltsstruktur und Beteiligungsquote ab.

Für die Geschäftsführung ist das ein anderes Gespräch als das über einen Kostenblock.

Der Leitfaden enthält die Rechenlogik dazu. Soll ich ihn Ihnen zusenden?$copy$,
$copy${{first_name}}, dies ist meine letzte Nachricht zu dem Thema.

Ist die Digitalisierung der bAV bei {{company_name}} derzeit kein Thema, oder bin ich bei der falschen Ansprechperson gelandet? Im zweiten Fall: wer wäre zuständig?

Im ersten Fall: verständlich. Der Leitfaden steht bereit, falls sich das ändert.$copy$,
$copy${{first_name}}, hatten Sie Gelegenheit, einen Blick hineinzuwerfen?

Falls ja, würde mich eines interessieren: Welcher Abschnitt war für {{company_name}} am relevantesten? Die Antwort zeigt in der Regel gut, wo der eigentliche Bedarf liegt.$copy$,
$copy$Ein letzter Hinweis, {{first_name}}, dann lasse ich das Thema ruhen.

Der Leitfaden erklärt die Systematik. Was er nicht leisten kann: die Rechnung für {{company_name}} mit Ihren Gehaltsstrukturen, Ihren bestehenden Verträgen und Ihren Systemen. Das gehen wir in 30 Minuten durch, ohne Präsentation.

Wenn das derzeit nicht passt, ist das ebenfalls eine Antwort.$copy$
FROM outreach_sequences s WHERE s.campaign_key = 'DEGURA_C'
ON CONFLICT (sequence_id, variant_key) DO UPDATE SET
  connect_note = EXCLUDED.connect_note, first_message = EXCLUDED.first_message,
  second_message = EXCLUDED.second_message, third_message = EXCLUDED.third_message,
  asset_followup_1 = EXCLUDED.asset_followup_1, asset_followup_2 = EXCLUDED.asset_followup_2,
  is_active = TRUE;

INSERT INTO outreach_sequence_variants (
  sequence_id, variant_key, connect_note, first_message, second_message,
  third_message, asset_followup_1, asset_followup_2
)
SELECT s.id, 2,
$copy$Guten Tag {{first_name}}, ich arbeite mit HR-Verantwortlichen an der Digitalisierung der betrieblichen Altersvorsorge. Bei {{company_name}} dürfte das Thema Substanz haben. Ich würde mich gern mit Ihnen vernetzen.$copy$,
$copy$Vielen Dank für die Vernetzung, {{first_name}}.

Eine Beobachtung, die für {{company_name}} relevant sein könnte: Ob ein bAV-Angebot tatsächlich genutzt wird, hängt weniger vom Angebot ab als vom Weg dorthin. Wenn der Einstieg vollständig digital ist, von der Unterschrift bis zur Lohnbuchhaltung, steigt die Beteiligung messbar. Bei einem vergleichbaren Unternehmen von 48 auf 77 Prozent.

Das zahlt direkt auf Mitarbeiterbindung und Arbeitgeberattraktivität ein, ohne zusätzliche Arbeit für Ihr Team.

Ich habe die wichtigsten Punkte in einem Leitfaden zusammengefasst. Darf ich Ihnen diesen zukommen lassen?$copy$,
$copy$Noch ein Punkt, {{first_name}}, dann komme ich nicht mehr darauf zurück.

Der Teil der bAV, der HR-Verantwortlichen erfahrungsgemäß am meisten Unbehagen macht, ist nicht der Aufwand. Es ist die Haftung. Fehlerhafte Meldungen an Versicherer, verpasste Fristen bei Ein- und Austritten, Rechtsfragen von Mitarbeitenden, die HR nicht beantworten darf.

Wir übernehmen diesen Teil vollständig, einschließlich der bestehenden Altverträge und der Anbindung an Ihre Lohnbuchhaltung.

Im Leitfaden steht, worauf es dabei ankommt. Darf ich ihn Ihnen zusenden?$copy$,
$copy${{first_name}}, dies ist meine letzte Nachricht zu dem Thema.

Ist die Digitalisierung der bAV bei {{company_name}} derzeit kein Thema, oder bin ich bei der falschen Ansprechperson gelandet? Im zweiten Fall: wer wäre zuständig?

Im ersten Fall: verständlich. Der Leitfaden steht bereit, falls sich das ändert.$copy$,
$copy${{first_name}}, hatten Sie Gelegenheit, einen Blick hineinzuwerfen?

Falls ja, würde mich eines interessieren: Welcher Abschnitt war für {{company_name}} am relevantesten? Die Antwort zeigt in der Regel gut, wo der eigentliche Bedarf liegt.$copy$,
$copy$Ein letzter Hinweis, {{first_name}}, dann lasse ich das Thema ruhen.

Der Leitfaden erklärt die Systematik. Was er nicht leisten kann: die Rechnung für {{company_name}} mit Ihren Gehaltsstrukturen, Ihren bestehenden Verträgen und Ihren Systemen. Das gehen wir in 30 Minuten durch, ohne Präsentation.

Wenn das derzeit nicht passt, ist das ebenfalls eine Antwort.$copy$
FROM outreach_sequences s WHERE s.campaign_key = 'DEGURA_C'
ON CONFLICT (sequence_id, variant_key) DO UPDATE SET
  connect_note = EXCLUDED.connect_note, first_message = EXCLUDED.first_message,
  second_message = EXCLUDED.second_message, third_message = EXCLUDED.third_message,
  asset_followup_1 = EXCLUDED.asset_followup_1, asset_followup_2 = EXCLUDED.asset_followup_2,
  is_active = TRUE;
