\set ON_ERROR_STOP on

DO $$
DECLARE
  family_count integer;
  variant_count integer;
BEGIN
  IF to_regclass('public.linkedin_accounts') IS NULL THEN
    RAISE EXCEPTION 'linkedin_accounts missing';
  END IF;
  IF to_regclass('public.outreach_sequence_variants') IS NULL THEN
    RAISE EXCEPTION 'outreach_sequence_variants missing';
  END IF;
  IF to_regclass('public.outbound_suppressions') IS NULL THEN
    RAISE EXCEPTION 'outbound_suppressions missing';
  END IF;
  IF to_regclass('public.outreach_events') IS NULL THEN
    RAISE EXCEPTION 'outreach_events missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'linkedin_account_id'
  ) THEN
    RAISE EXCEPTION 'leads.linkedin_account_id missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'source_last_activity_at'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'outreach_sequences' AND column_name = 'guide_url'
  ) THEN
    RAISE EXCEPTION 'mixed DEGURA import source columns missing';
  END IF;
  IF to_regprocedure('public.import_degura_campaign_batches(text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'mixed DEGURA import function missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'leads'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%linkedin_url%'
  ) THEN
    RAISE EXCEPTION 'global linkedin_url uniqueness missing';
  END IF;
  IF EXISTS (
    SELECT linkedin_url FROM leads GROUP BY linkedin_url HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate linkedin_url rows found';
  END IF;
  IF EXISTS (SELECT 1 FROM leads WHERE linkedin_account_id IS NULL) THEN
    RAISE EXCEPTION 'lead without account ownership found';
  END IF;

  SELECT count(*) INTO family_count
  FROM outreach_sequences
  WHERE campaign_key IN ('DEGURA_A', 'DEGURA_B', 'DEGURA_C');

  IF to_regclass('public.outreach_sequence_variants') IS NOT NULL THEN
    SELECT count(*) INTO variant_count
    FROM outreach_sequence_variants v
    JOIN outreach_sequences s ON s.id = v.sequence_id
    WHERE s.campaign_key LIKE 'DEGURA_%';
  ELSE
    variant_count := 0;
  END IF;

  IF family_count <> 3 THEN
    RAISE EXCEPTION 'expected 3 managed families, got %', family_count;
  END IF;
  IF variant_count <> 6 THEN
    RAISE EXCEPTION 'expected 6 managed variants, got %', variant_count;
  END IF;
  IF EXISTS (SELECT 1 FROM outreach_sequence_variants WHERE length(connect_note) > 300) THEN
    RAISE EXCEPTION 'invite note exceeds LinkedIn 300 character limit';
  END IF;
END $$;

DO $$
DECLARE
  account_one uuid;
  account_two uuid;
  sequence_a bigint;
  sequence_b bigint;
  sequence_c bigint;
  variant_a bigint;
  variant_b bigint;
  variant_c bigint;
  imported integer;
  returned_batches integer;
BEGIN
  SELECT id INTO account_one FROM linkedin_accounts WHERE browser_slot = 1;
  INSERT INTO linkedin_accounts(label, email, browser_slot, credentials, sender_display_name)
  VALUES ('Secondary', 'secondary@example.test', 2, '{}'::jsonb, 'Secondary')
  ON CONFLICT (browser_slot) DO UPDATE SET is_active = true
  RETURNING id INTO account_two;
  UPDATE linkedin_accounts SET is_active = true WHERE id IN (account_one, account_two);
  SELECT id INTO sequence_a FROM outreach_sequences WHERE campaign_key = 'DEGURA_A';
  SELECT id INTO sequence_b FROM outreach_sequences WHERE campaign_key = 'DEGURA_B';
  SELECT id INTO sequence_c FROM outreach_sequences WHERE campaign_key = 'DEGURA_C';
  SELECT id INTO variant_a FROM outreach_sequence_variants WHERE sequence_id = sequence_a AND variant_key = 1;
  SELECT id INTO variant_b FROM outreach_sequence_variants WHERE sequence_id = sequence_b AND variant_key = 1;
  SELECT id INTO variant_c FROM outreach_sequence_variants WHERE sequence_id = sequence_c AND variant_key = 1;

  SELECT count(*), sum(result.inserted_count)
  INTO returned_batches, imported
  FROM import_degura_campaign_batches(
    'mixed fixture', 'db-contract-test',
    jsonb_build_array(
      jsonb_build_object('linkedin_url','https://www.linkedin.com/in/mixed-a-fixture','first_name','A','company_name','Company A','source_contact_id','contact-a','source_company_id','company-a','source_sequence_id','837149883','source_last_activity_at','2026-08-31 17:18','linkedin_account_id',account_one,'sequence_id',sequence_a,'sequence_variant_id',variant_a),
      jsonb_build_object('linkedin_url','https://www.linkedin.com/in/mixed-b-fixture','first_name','B','company_name','Company B','source_contact_id','contact-b','source_company_id','company-b','source_sequence_id','836545727','source_last_activity_at','2026-08-30 17:18','linkedin_account_id',account_two,'sequence_id',sequence_b,'sequence_variant_id',variant_b),
      jsonb_build_object('linkedin_url','https://www.linkedin.com/in/mixed-c-fixture','first_name','C','company_name','Company C','source_contact_id','contact-c','source_company_id','company-c','source_sequence_id','837149889','source_last_activity_at','','linkedin_account_id',account_one,'sequence_id',sequence_c,'sequence_variant_id',variant_c)
    )
  ) result;

  IF returned_batches <> 3 OR imported <> 3 THEN
    RAISE EXCEPTION 'mixed import expected 3 batches and 3 rows, got % and %', returned_batches, imported;
  END IF;
  IF (SELECT company_name FROM leads WHERE linkedin_url = 'https://www.linkedin.com/in/mixed-b-fixture') <> 'Company B'
     OR (SELECT source_sequence_id FROM leads WHERE linkedin_url = 'https://www.linkedin.com/in/mixed-b-fixture') <> '836545727'
     OR (SELECT source_last_activity_at FROM leads WHERE linkedin_url = 'https://www.linkedin.com/in/mixed-a-fixture') IS NULL
     OR (SELECT campaign_paused FROM leads WHERE linkedin_url = 'https://www.linkedin.com/in/mixed-a-fixture') IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'mixed import did not preserve source metadata';
  END IF;
END $$;

DO $$
DECLARE
  account_one uuid;
  account_two uuid;
  sequence_a bigint;
  variant_one bigint;
  variant_two bigint;
  imported integer;
  imported_batch bigint;
  test_lead uuid;
  ownership_blocked boolean := false;
BEGIN
  SELECT id INTO account_one FROM linkedin_accounts WHERE browser_slot = 1;
  INSERT INTO linkedin_accounts(label, email, browser_slot, credentials, sender_display_name)
  VALUES ('Secondary', 'secondary@example.test', 2, '{}'::jsonb, 'Secondary')
  ON CONFLICT (browser_slot) DO UPDATE SET is_active = true
  RETURNING id INTO account_two;
  UPDATE linkedin_accounts SET is_active = true WHERE id IN (account_one, account_two);

  SELECT id INTO sequence_a FROM outreach_sequences WHERE campaign_key = 'DEGURA_A';
  SELECT id INTO variant_one FROM outreach_sequence_variants WHERE sequence_id = sequence_a AND variant_key = 1;
  SELECT id INTO variant_two FROM outreach_sequence_variants WHERE sequence_id = sequence_a AND variant_key = 2;

  SELECT batch_id, inserted_count INTO imported_batch, imported
  FROM import_degura_batch(
    'fixture import', sequence_a, 'connect_message', 'db-contract-test',
    jsonb_build_array(
      jsonb_build_object('linkedin_url','https://www.linkedin.com/in/a-fixture','linkedin_account_id',account_one,'sequence_variant_id',variant_one),
      jsonb_build_object('linkedin_url','https://www.linkedin.com/in/b-fixture','linkedin_account_id',account_two,'sequence_variant_id',variant_one),
      jsonb_build_object('linkedin_url','https://www.linkedin.com/in/c-fixture','linkedin_account_id',account_one,'sequence_variant_id',variant_two),
      jsonb_build_object('linkedin_url','https://www.linkedin.com/in/d-fixture','linkedin_account_id',account_two,'sequence_variant_id',variant_two)
    )
  );
  IF imported <> 4 OR imported_batch IS NULL THEN
    RAISE EXCEPTION 'atomic import expected 4 rows, got %', imported;
  END IF;
  IF (SELECT count(DISTINCT linkedin_account_id) FROM leads WHERE batch_id = imported_batch) <> 2
     OR (SELECT count(DISTINCT sequence_variant_id) FROM leads WHERE batch_id = imported_batch) <> 2 THEN
    RAISE EXCEPTION 'atomic import did not preserve 2x2 ownership';
  END IF;

  SELECT id INTO test_lead FROM leads WHERE batch_id = imported_batch ORDER BY linkedin_url LIMIT 1;
  INSERT INTO outreach_events(linkedin_account_id, lead_id, sequence_id, sequence_variant_id, event_type, touch_number)
  SELECT linkedin_account_id, id, sequence_id, sequence_variant_id, 'invite_sent', 1 FROM leads WHERE id = test_lead;
  BEGIN
    UPDATE leads SET linkedin_account_id = account_two WHERE id = test_lead;
  EXCEPTION WHEN OTHERS THEN
    ownership_blocked := true;
  END;
  IF NOT ownership_blocked THEN
    RAISE EXCEPTION 'lead ownership reassignment was not blocked after outreach';
  END IF;
END $$;

SELECT 'two-account-degura-db-contract-ok' AS result;
