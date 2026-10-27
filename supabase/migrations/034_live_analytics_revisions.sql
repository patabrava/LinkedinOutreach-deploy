-- Only anonymous scope revisions travel over Realtime; records stay behind server guards.
CREATE TABLE IF NOT EXISTS public.analytics_revisions (
  scope text PRIMARY KEY CHECK (scope IN ('all', 'regular', 'sales-navigator')),
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.analytics_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analytics_revisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.analytics_revisions TO service_role;
INSERT INTO public.analytics_revisions(scope) VALUES ('all'), ('regular'), ('sales-navigator') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.notify_analytics_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  record_data jsonb;
  scopes text[] := ARRAY['all'];
  campaign_scope text;
  batch bigint;
  sequence bigint;
  current_scope text;
  next_revision bigint;
BEGIN
  -- OLD and NEW cover deletes and moves across campaign boundaries.
  FOR record_data IN SELECT value FROM jsonb_array_elements(
    CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
         WHEN TG_OP = 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
         ELSE jsonb_build_array(to_jsonb(OLD), to_jsonb(NEW)) END
  ) LOOP
    IF TG_TABLE_NAME = 'leads' THEN
      batch := (record_data->>'batch_id')::bigint;
      sequence := (record_data->>'sequence_id')::bigint;
    ELSE
      SELECT l.batch_id, l.sequence_id INTO batch, sequence FROM public.leads l
      WHERE l.id = (record_data->>'lead_id')::uuid;
    END IF;
    campaign_scope := CASE WHEN (batch, sequence) IN ((30,7),(31,8),(32,9)) THEN 'regular'
                           WHEN (batch, sequence) = (33,10) THEN 'sales-navigator' END;
    IF campaign_scope IS NOT NULL AND NOT campaign_scope = ANY(scopes) THEN
      scopes := array_append(scopes, campaign_scope);
    END IF;
  END LOOP;
  -- Canonical lock order prevents cross-campaign transactions from deadlocking.
  FOR current_scope IN SELECT unnest(scopes) ORDER BY 1 LOOP
    UPDATE public.analytics_revisions SET revision = revision + 1, updated_at = clock_timestamp()
    WHERE scope = current_scope RETURNING revision INTO next_revision;
    BEGIN
      PERFORM realtime.send(jsonb_build_object('revision', next_revision::text), 'changed', 'analytics:' || current_scope, false);
    EXCEPTION WHEN OTHERS THEN
      -- Durable revision remains available to fallback checks; never retry an outbound send.
      RAISE WARNING 'Analytics broadcast unavailable for %', current_scope;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_analytics_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS analytics_leads_changed ON public.leads;
CREATE TRIGGER analytics_leads_changed AFTER INSERT OR UPDATE OR DELETE ON public.leads
FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_change();
DROP TRIGGER IF EXISTS analytics_followups_changed ON public.followups;
CREATE TRIGGER analytics_followups_changed AFTER INSERT OR UPDATE OR DELETE ON public.followups
FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_change();
DROP TRIGGER IF EXISTS analytics_events_changed ON public.outreach_events;
CREATE TRIGGER analytics_events_changed AFTER INSERT OR UPDATE OR DELETE ON public.outreach_events
FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_change();
