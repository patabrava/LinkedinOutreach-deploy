DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        WHERE t.typname = 'lead_status' AND e.enumlabel = 'MESSAGE_ONLY_READY'
    ) THEN
        ALTER TYPE lead_status ADD VALUE 'MESSAGE_ONLY_READY';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        WHERE t.typname = 'lead_status' AND e.enumlabel = 'MESSAGE_ONLY_APPROVED'
    ) THEN
        ALTER TYPE lead_status ADD VALUE 'MESSAGE_ONLY_APPROVED';
    END IF;
END$$;
