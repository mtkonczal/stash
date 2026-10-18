import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const user='10000000-0000-4000-8000-000000000001';
const other='10000000-0000-4000-8000-000000000002';
const token='30000000-0000-4000-8000-000000000001';
const legacy='20000000-0000-4000-8000-000000000001';
const preserved='20000000-0000-4000-8000-000000000002';
const future='20000000-0000-4000-8000-000000000003';
const priorJob='40000000-0000-4000-8000-000000000001';
const legacyUrl='https://example.org/legacy.mp3';
const priorUrl=`storage://stash-audio/${user}/${priorJob}.mp3`;
let checks=0;
async function check(sql,expected) {
  const { rows }=await db.query(sql);
  assert.equal(Object.values(rows[0])[0],expected,sql);
  checks++;
}
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage;
create table auth.users(id uuid primary key);
insert into auth.users values('${user}'),('${other}');
create function auth.uid() returns uuid language sql as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth,public,storage to anon,authenticated,service_role;
create table public.saves(id uuid primary key,user_id uuid references auth.users,title text,
 content text,highlight text,audio_url text,is_archived boolean default false);
grant select,insert,update on public.saves to authenticated;
create table storage.buckets(id text primary key,name text,public boolean);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb default '{}',updated_at timestamptz default now());
create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
`);
for (const migration of ['202610180001_audio_jobs.sql','202610180002_audio_storage_budget.sql']) {
  await db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
}
await db.exec(`
insert into public.saves values
 ('${legacy}','${user}','Legacy',repeat('Legacy article. ',30),null,'${legacyUrl}',false),
 ('${preserved}','${user}','Preserved Sky',repeat('Preserved article. ',30),null,'${priorUrl}',false);
insert into public.audio_jobs(id,save_id,user_id,title,source_content,status)
 values('${priorJob}','${preserved}','${user}','Preserved Sky',repeat('Preserved article. ',30),'ready');
insert into storage.objects(bucket_id,name) values('audio','${legacy}.mp3'),('stash-audio','${user}/${priorJob}.mp3');
`);
await db.exec(await readFile(new URL('../supabase/migrations/202610180003_audio_retention.sql',import.meta.url),'utf8'));
await check('select count(*)::int from public.saves where audio_expires_at is not null',0);
await check(`select count(*)::int from public.collect_stash_audio_expirations('${user}')`,0);
await check(`select audio_url from public.saves where id='${legacy}'`,legacyUrl);
await check(`select audio_url from public.saves where id='${preserved}'`,priorUrl);
await db.exec(`set role authenticated; set request.jwt.claim.sub='${other}'`);
await assert.rejects(db.exec(`select public.collect_stash_audio_expirations('${user}')`)); checks++;
await assert.rejects(db.exec(`select public.ack_stash_audio_deletions('${user}',array[]::uuid[])`)); checks++;
await assert.rejects(db.exec('select * from public.audio_deletions')); checks++;
await db.exec('reset role');
await db.exec(`insert into public.saves values('${future}','${user}','Future',repeat('Future article. ',30),null,null,false)`);
const { rows:[first] }=await db.query(`select * from public.claim_stash_audio('${user}','${token}')`);
const firstKey=`${user}/${first.id}.mp3`;
await check(`select public.finish_stash_audio('${first.id}','${token}','storage://stash-audio/${firstKey}')`,true);
await check(`select audio_expires_at=audio_generated_at+interval '3 months' from public.saves where id='${future}'`,true);
await db.exec(`insert into storage.objects(bucket_id,name) values('stash-audio','${firstKey}')`);
await check(`select count(*)::int from public.collect_stash_audio_expirations('${user}')`,0);
await db.exec(`update public.saves set audio_expires_at=now()-interval '1 second' where id='${future}'`);
const { rows:[deletion] }=await db.query(`select * from public.collect_stash_audio_expirations('${user}')`);
assert.equal(deletion.object_name,firstKey); checks++;
await check(`select audio_url is null from public.saves where id='${future}'`,true);
await check(`select status from public.audio_jobs where save_id='${future}'`,'expired');
await check('select count(*)::int from public.saves',3);
await check(`select count(*)::int from storage.objects where name='${firstKey}'`,1); // SQL only queues API deletion.
await check(`select public.ack_stash_audio_deletions('${user}',array['${deletion.id}']::uuid[])`,0);
await check(`select count(*)::int from public.claim_stash_audio('${user}','${token}')`,0); // No automatic regeneration.
await db.exec(`update public.saves set content=repeat('Revised article. ',30) where id='${future}'`);
await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`);
const { rows:[regenerated] }=await db.query(`select * from public.request_stash_audio('${future}')`);
assert.notEqual(regenerated.id,first.id); checks++;
assert.ok(regenerated.source_content.startsWith('Revised article.')); checks++;
await check(`select id::text from public.request_stash_audio('${future}')`,regenerated.id); // Duplicate request is safe.
await db.exec('reset role');
await db.exec(`select public.claim_stash_audio('${user}','${token}')`);
const newKey=`${user}/${regenerated.id}.mp3`;
await check(`select public.finish_stash_audio('${regenerated.id}','${token}','storage://stash-audio/${newKey}')`,true);
await db.exec(`insert into storage.objects(bucket_id,name) values('stash-audio','${newKey}')`);
const { rows:pending }=await db.query(`select * from public.collect_stash_audio_expirations('${user}')`);
assert.deepEqual(pending.map(d=>d.object_name),[firstKey]); checks++;
// Simulate successful Storage API deletion ONLY in this isolated test database.
await db.exec(`delete from storage.objects where name='${firstKey}'`);
await check(`select public.ack_stash_audio_deletions('${user}',array['${deletion.id}']::uuid[])`,1);
await check(`select count(*)::int from storage.objects where name='${newKey}'`,1);
await check(`select audio_url from public.saves where id='${future}'`,'storage://stash-audio/'+newKey);
await check(`select audio_expires_at>now() from public.saves where id='${future}'`,true);
// A replaced object at a pending deletion path must be skipped, never deleted.
await db.exec(`update public.saves set audio_expires_at=now()-interval '1 second' where id='${future}'`);
const { rows:[secondDeletion] }=await db.query(`select * from public.collect_stash_audio_expirations('${user}')`);
await db.exec(`update storage.objects set updated_at=now()+interval '1 second' where name='${newKey}'`);
await check(`select count(*)::int from public.collect_stash_audio_expirations('${user}')`,0);
await check(`select status from public.audio_deletions where id='${secondDeletion.id}'`,'skipped');
await check(`select audio_url from public.saves where id='${legacy}'`,legacyUrl);
await check(`select audio_url from public.saves where id='${preserved}'`,priorUrl);
await check(`select status from public.audio_jobs where id='${priorJob}'`,'ready');
await db.close();
console.log(`${checks} retention, existing-audio preservation, regeneration, and safe deletion checks passed`);
