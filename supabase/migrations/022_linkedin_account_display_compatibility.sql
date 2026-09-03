-- Keep the current worker/UI display-name contract compatible with earlier account rows.

ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'linkedin_accounts'
      AND column_name = 'sender_display_name'
  ) THEN
    EXECUTE $sql$
      UPDATE linkedin_accounts
      SET display_name = sender_display_name
      WHERE display_name = '' AND sender_display_name <> ''
    $sql$;
  END IF;
END $$;
