-- Laura's COP reminders; user approved full-name greetings on 2026-10-07.
-- Source: https://docs.google.com/document/d/1eY5dXotVM1m0YrFJjp0-1mTDKai5DiX0Nds_vt6ROCw/edit
-- Preserve the initial message, subject, cadence, activation and delivery history.
UPDATE outreach_sequences
SET
  second_message = $copy$Hallo {{first_name}} {{last_name}},

ich wollte mich noch einmal kurz bei Ihnen melden, da wir bisher keine Rückmeldung von Ihnen erhalten haben.

Es geht um Ihre betriebliche Altersvorsorge bei Ihrem früheren Arbeitgeber {{company_name}}. Wir möchten gerne klären, ob Sie inzwischen einen neuen Arbeitgeber haben und ob der Vertrag dorthin übertragen werden soll.

Falls Sie aktuell keinen neuen Arbeitgeber haben, ist das natürlich auch in Ordnung. Eine kurze Rückmeldung genügt – gerne direkt hier über LinkedIn.

Viele Grüße
Katharina$copy$,
  third_message = $copy$Hallo {{first_name}} {{last_name}},

ich melde mich heute noch einmal abschließend zu Ihrer betrieblichen Altersvorsorge.

Falls Sie inzwischen einen neuen Arbeitgeber haben und die bAV übertragen werden soll, schicken Sie mir bitte kurz den Unternehmensnamen und – wenn möglich – eine Kontaktperson aus der Personalabteilung oder der Geschäftsführung.

Wenn sich Ihre Situation nicht verändert hat oder Sie aktuell keine Unterstützung benötigen, genügt ebenfalls eine kurze Nachricht.

Sollten wir nichts von Ihnen hören, werden wir Sie hierzu zunächst nicht weiter über LinkedIn kontaktieren. Sie können sich aber jederzeit gerne bei uns melden.

Viele Grüße
Katharina$copy$,
  updated_at = now()
WHERE id = 10
  AND name = 'COP bAV InMail · Katharina · 2026-09-17'
  AND linkedin_account_id = '13f81aad-8a5d-4cad-b94d-15aecef6ee03'
  AND delivery_mode = 'invite_and_inmail';
