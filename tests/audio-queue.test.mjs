// Run with PGLITE_MODULE pointing to the installed @electric-sql/pglite entry.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const user = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const save = '20000000-0000-4000-8000-000000000001';
const token = '30000000-0000-4000-8000-000000000001';
const token2 = '30000000-0000-4000-8000-000000000002';
let checks = 0;
async function check(sql, expected) {
  const { rows } = await db.query(sql);
  assert.equal(Object.values(rows[0])[0], expected, sql);
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
create table public.saves(id uuid primary key, user_id uuid references auth.users, title text,
 content text, highlight text, audio_url text, is_archived boolean default false);
create table storage.buckets(id text primary key,name text,public boolean);
create table storage.objects(bucket_id text,name text,metadata jsonb default '{}');
create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
alter table storage.objects enable row level security;
grant select on storage.objects to authenticated;
alter table public.saves enable row level security;
create policy own_saves on public.saves to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
grant select,insert,update,delete on public.saves to authenticated;
insert into public.saves values('${save}','${user}','Existing article',repeat('word ',100),null,null,false);
`);
await db.exec(await readFile(new URL('../supabase/migrations/202610180001_audio_jobs.sql', import.meta.url), 'utf8'));
await db.exec(await readFile(new URL('../supabase/migrations/202610180002_audio_storage_budget.sql', import.meta.url), 'utf8'));
await check('select count(*)::int from public.audio_jobs', 0); // no backlog
await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`);
await db.exec(`select public.request_stash_audio('${save}')`);
await db.exec(`select public.request_stash_audio('${save}')`);
await check('select count(*)::int from public.audio_jobs', 1); // idempotency
await db.exec(`set request.jwt.claim.sub='${other}'`);
await check('select count(*)::int from public.audio_jobs', 0); // RLS
await assert.rejects(db.exec(`select public.request_stash_audio('${save}')`)); checks++;
await assert.rejects(db.exec(`select public.claim_stash_audio('${other}','${token}')`)); checks++;
await assert.rejects(db.exec(`update public.audio_jobs set status='ready'`)); checks++;
await db.exec('reset role');
const { rows: [job] } = await db.query(`select * from public.claim_stash_audio('${user}','${token}')`);
assert.equal(job.status,'generating'); checks++;
await check(`select count(*)::int from public.claim_stash_audio('${user}','${token2}')`,0);
await check(`select public.renew_stash_audio('${job.id}','${token2}',1,2)`,false);
await check(`select public.renew_stash_audio('${job.id}','${token}',1,2)`,true);
await db.exec(`update public.audio_jobs set lease_until=now()-interval '1 minute' where id='${job.id}'`);
await check(`select public.finish_stash_audio('${job.id}','${token}','wrong')`,false);
await check(`select count(*)::int from public.claim_stash_audio('${user}','${token2}')`,1);
await check(`select public.renew_stash_audio('${job.id}','${token}',1,2)`,false);
await check(`select public.fail_stash_audio('${job.id}','${token2}','Upload interrupted')`,true);
await check(`select status from public.audio_jobs where id='${job.id}'`,'queued');
await check(`select count(*)::int from public.claim_stash_audio('${user}','${token}')`,0); // backoff
await db.exec(`update public.audio_jobs set available_at=now()-interval '1 minute' where id='${job.id}'`);
await db.exec(`select public.claim_stash_audio('${user}','${token}')`);
await check(`select public.fail_stash_audio('${job.id}','${token}','Third failure')`,true);
await check(`select status from public.audio_jobs where id='${job.id}'`,'failed');
await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`);
await db.exec(`select public.request_stash_audio('${save}')`);
await check(`select attempts from public.audio_jobs where id='${job.id}'`,0);
await db.exec('reset role');
await db.exec(`select public.claim_stash_audio('${user}','${token}')`);
await assert.rejects(db.exec(`select public.finish_stash_audio('${job.id}','${token}','storage://stash-audio/another-user/file.mp3')`)); checks++;
const url = `storage://stash-audio/${user}/${job.id}.mp3`;
await check(`select public.finish_stash_audio('${job.id}','${token}','${url}')`,true);
await check(`select audio_url from public.saves where id='${save}'`,url);
await check(`select status from public.audio_jobs where id='${job.id}'`,'ready');
await check(`select count(*)::int from public.claim_stash_audio('${user}','${token2}')`,0);
await db.exec(`insert into public.saves values
 ('20000000-0000-4000-8000-000000000002','${user}','New article',repeat('word ',100),null,null,false),
 ('20000000-0000-4000-8000-000000000003','${user}','Highlight',repeat('word ',100),'a highlight',null,false),
 ('20000000-0000-4000-8000-000000000004','${user}','Existing audio',repeat('word ',100),null,'https://example.org/old.mp3',false)`);
await check('select count(*)::int from public.audio_jobs',2);
await db.exec(`insert into storage.objects values('stash-audio','${user}/a.mp3'),('stash-audio','${other}/b.mp3')`);
await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`);
await check('select count(*)::int from storage.objects',1);
await db.exec('reset role');
await check("select public.stash_audio_storage_bytes('not-an-object')",0);
await db.exec(`update storage.objects set metadata='{"size":100}'::jsonb`);
await check("select public.stash_audio_storage_bytes('not-an-object')",200);
await check(`select public.stash_audio_storage_bytes('${user}/a.mp3')`,100);
await db.close();
console.log(`${checks} queue, permission, storage, idempotency, retry, and stale-worker checks passed`);
