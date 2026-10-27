import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const module = {exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('./analyticsLive.ts', import.meta.url),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText,
  {module,exports:module.exports,setTimeout,clearTimeout,AbortController});
const {createRefreshQueue}=module.exports;
const wait=()=>new Promise(resolve=>setTimeout(resolve,25));
test('bursts coalesce and hidden tabs do not query',async()=>{
 let visible=true,reads=0; const applied=[];
 const queue=createRefreshQueue({delay:2,visible:()=>visible,read:async()=>++reads,apply:value=>applied.push(value),state:()=>{}});
 queue.request();queue.request();queue.request();await wait();
 assert.equal(reads,1);assert.deepEqual(applied,[1]);
 visible=false;queue.request();await wait();assert.equal(reads,1);
 visible=true;queue.request();await wait();assert.equal(reads,2);queue.stop();
});
test('a change during a slow read schedules another read without overlapping',async()=>{
 let release,reads=0;const applied=[];
 const queue=createRefreshQueue({delay:2,visible:()=>true,read:async()=>{reads++;return reads===1?new Promise(resolve=>release=resolve):2},apply:value=>applied.push(value),state:()=>{}});
 queue.request();await wait();queue.request();queue.request();await wait();assert.equal(reads,1);
 release(1);await wait();assert.equal(reads,2);assert.deepEqual(applied,[1,2]);queue.stop();
});
test('errors retain prior data, a later request recovers, unchanged data does not re-render',async()=>{
 let fail=true,unchanged=false;const states=[],applied=[];
 const queue=createRefreshQueue({delay:2,visible:()=>true,read:async()=>{if(fail)throw Error('offline');return unchanged?null:3},apply:value=>applied.push(value),state:value=>states.push(value)});
 queue.request();await wait();assert.deepEqual(applied,[]);assert.equal(states.at(-1),'error');
 fail=false;queue.request();await wait();assert.deepEqual(applied,[3]);assert.equal(states.at(-1),'current');
 unchanged=true;queue.request();await wait();assert.deepEqual(applied,[3]);queue.stop();
});
test('stop cancels timers and ignores late results',async()=>{
 let release,signal;const applied=[];
 const queue=createRefreshQueue({delay:2,visible:()=>true,read:s=>{signal=s;return new Promise(resolve=>release=resolve)},apply:value=>applied.push(value),state:()=>{}});
 queue.request();await wait();queue.stop();assert.equal(signal.aborted,true);release(4);await wait();assert.deepEqual(applied,[]);
});

function loadModule(path, imports, extra={}) {
  const m={exports:{}};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText,
    {module:m,exports:m.exports,require:name=>{assert.ok(name in imports,`Unexpected import ${name}`);return imports[name]},Date,console,...extra});
  return m.exports;
}
test('snapshot access requires a verified allowlisted user, including on repeated reads',async()=>{
  let user=null,error=null,verified=0;
  const server=loadModule('./analyticsLiveServer.ts',{
    'server-only':{},'next/headers':{cookies:()=>{}},
    '@supabase/auth-helpers-nextjs':{createServerComponentClient:()=>({auth:{getUser:async()=>{verified++;return {data:{user},error}}}})},
    './allowlist':{isAllowed:email=>email==='operator@example.test'},
    './authConfig':{isSupabaseAuthConfigured:()=>true},'./supabaseAdmin':{},'./campaignAnalyticsServer':{},'../app/actions':{},'./analyticsFunnel':{},
  });
  assert.equal(await server.analyticsAccess(),false);
  user={email:'outsider@example.test'};assert.equal(await server.analyticsAccess(),false);
  user={email:'operator@example.test'};assert.equal(await server.analyticsAccess(),true);
  error={message:'expired'};assert.equal(await server.analyticsAccess(),false);assert.equal(verified,4);
});
test('live endpoint rejects invalid scopes and dates, verifies access before 304, and hides backend errors',async()=>{
  let access=false,reads=0,fail=false;
  class NextResponse extends Response { static json(data,options){return new NextResponse(JSON.stringify(data),options)} }
  const route=loadModule('../app/api/analytics/live/route.ts',{
    'next/server':{NextResponse},
    '../../../../lib/analyticsLiveServer':{
      analyticsAccess:async()=>access,
      analyticsRevision:async(scope,privateDetails)=>{if(fail)throw Error('secret database connection');return privateDetails?'private:2':'public:2'},
      analyticsSnapshot:async(scope,days,privateDetails,revision)=>{reads++;return {scope,days,privateDetails,revision}},
    },
  },{Response});
  const req=query=>({nextUrl:new URL('http://test/api/analytics/live?'+query)});
  assert.equal((await route.GET(req('scope=bad'))).status,400);
  assert.equal((await route.GET(req('days=8'))).status,400);
  const publicResponse=await route.GET(req('scope=regular&days=7&privateDetails=true'));
  assert.equal((await publicResponse.json()).privateDetails,false);
  assert.match(publicResponse.headers.get('Cache-Control'),/no-store/);
  assert.equal((await route.GET(req('revision=public:2'))).status,304);assert.equal(reads,1);
  access=true;
  assert.equal((await route.GET(req('revision=public:2'))).status,200);assert.equal(reads,2);
  fail=true;const unavailable=await route.GET(req(''));assert.equal(unavailable.status,503);
  assert.ok(!(await unavailable.text()).includes('secret'));
});
