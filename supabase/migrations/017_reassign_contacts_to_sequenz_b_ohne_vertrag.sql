-- Reassign the imported contacts from the wrong sequence to the requested one.
-- This updates the batch first-class relationship and every lead attached to it.
-- Idempotent: rerunning the migration keeps the same target assignment.

do $$
declare
  target_sequence_id bigint;
  source_sequence_id bigint;
begin
  select id into target_sequence_id
    from outreach_sequences
   where lower(name) = lower('SEQUENZ b ohne Vertrag')
   limit 1;

  if target_sequence_id is null then
    raise exception 'Target sequence % not found', 'SEQUENZ b ohne Vertrag';
  end if;

  select id into source_sequence_id
    from outreach_sequences
   where lower(name) = lower('Inactive no bAV')
   limit 1;

  if source_sequence_id is null then
    raise exception 'Source sequence % not found', 'Inactive no bAV';
  end if;

  update leads
     set sequence_id = target_sequence_id
   where sequence_id = source_sequence_id
      or batch_id in (
        select id
          from lead_batches
         where sequence_id = source_sequence_id
      );

  update lead_batches
     set sequence_id = target_sequence_id
   where sequence_id = source_sequence_id;
end
$$;
