import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
// Disposable database only. Broadcast transport is replaced at its external SQL edge.
const container = `analytics-regression-${process.pid}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
const sql = source => execFileSync('docker', ['exec','-i',container,'psql','-U','postgres','-d','analytics_regression','-v','ON_ERROR_STOP=1','-At'], { input: source, encoding: 'utf8' });
try {
  docker('run','-d','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=analytics_regression','postgres:16-alpine');
  let ready=false;
  for (let i=0;i<40;i++) { try { sql('select 1'); ready=true;break; } catch { await new Promise(r=>setTimeout(r,250)); } }
  assert.ok(ready,'Target database must accept a query');
  sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA realtime;
    CREATE TABLE realtime.sent(payload jsonb, event text, topic text, private boolean);
    CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN IF current_setting('test.broadcast_down',true)='yes' THEN RAISE EXCEPTION 'offline'; END IF;
      INSERT INTO realtime.sent VALUES(payload,event,topic,private); END; $$;
    CREATE TABLE public.leads(id uuid PRIMARY KEY,batch_id bigint,sequence_id bigint,status text);
    CREATE TABLE public.followups(id uuid PRIMARY KEY,lead_id uuid REFERENCES leads ON DELETE CASCADE,status text,sent_text text);
    CREATE TABLE public.outreach_events(id bigint PRIMARY KEY,lead_id uuid REFERENCES leads ON DELETE CASCADE,metadata jsonb);
  `);
  sql(readFileSync(new URL('../../supabase/migrations/034_live_analytics_revisions.sql',import.meta.url),'utf8'));
  sql(`INSERT INTO leads VALUES('00000000-0000-0000-0000-000000000001',30,7,'NEW');
       INSERT INTO followups VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','SENT','Exact body');
       INSERT INTO outreach_events VALUES(1,'00000000-0000-0000-0000-000000000001','{"sent_text":"Private body"}');`);
  assert.equal(sql("select revision from analytics_revisions where scope='regular'").trim(),'3');
  assert.equal(sql("select revision from analytics_revisions where scope='sales-navigator'").trim(),'0');
  const notices=JSON.parse(sql('select json_agg(row_to_json(s)) from realtime.sent s').trim());
  assert.equal(notices.length,6);
  for(const notice of notices) { assert.deepEqual(Object.keys(notice.payload),['revision']);assert.equal(notice.private,false);assert.equal(notice.event,'changed'); }
  sql("BEGIN; UPDATE leads SET status='ROLLBACK'; ROLLBACK;");
  assert.equal(sql("select revision from analytics_revisions where scope='regular'").trim(),'3');
  sql("UPDATE leads SET batch_id=33,sequence_id=10;");
  assert.equal(sql("select revision from analytics_revisions where scope='regular'").trim(),'4');
  assert.equal(sql("select revision from analytics_revisions where scope='sales-navigator'").trim(),'1');
  sql("SET test.broadcast_down='yes'; UPDATE followups SET status='FAILED';");
  assert.equal(sql("select revision from analytics_revisions where scope='sales-navigator'").trim(),'2');
  sql("INSERT INTO leads VALUES('00000000-0000-0000-0000-000000000003',99,99,'NEW');");
  assert.equal(sql("select revision from analytics_revisions where scope='sales-navigator'").trim(),'2');
  for(const role of ['anon','authenticated']) {
    assert.throws(()=>sql(`SET ROLE ${role}; SELECT * FROM analytics_revisions;`),/permission denied/);
    assert.throws(()=>sql(`SET ROLE ${role}; UPDATE analytics_revisions SET revision=999;`),/permission denied/);
  }
  sql('DELETE FROM leads;');
  console.log('PASS: lead/followup/event changes; scope moves; cascade deletes; rollback; broadcast failure; payload privacy; anonymous write/read denial.');
} finally { docker('rm','-f',container); }
