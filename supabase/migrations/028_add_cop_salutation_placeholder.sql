-- Address COP contacts with a verified Frau/Herr honorific before the surname.
UPDATE outreach_sequences
SET
  first_message = replace(first_message, 'Guten Tag {{first_name}} {{last_name}},', 'Guten Tag {{salutation}} {{last_name}},'),
  second_message = replace(second_message, 'Noch ein Punkt, {{first_name}},', 'Noch ein Punkt, {{salutation}} {{last_name}},'),
  third_message = replace(third_message, '{{first_name}}, dies ist meine letzte Nachricht', '{{salutation}} {{last_name}}, dies ist meine letzte Nachricht'),
  updated_at = now()
WHERE id = 10
  AND name = 'COP bAV InMail · Katharina · 2026-09-17'
  AND delivery_mode = 'invite_and_inmail';
