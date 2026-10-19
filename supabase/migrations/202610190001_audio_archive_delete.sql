-- Archive/delete audio lifecycle, including legacy files. Storage API performs deletion.
begin;
alter table public.audio_jobs drop constraint audio_jobs_status_check;
alter table public.audio_jobs add constraint audio_jobs_status_check check(status in ('queued','generating','ready','failed','expired','cancelled'));
alter table public.audio_deletions add column bucket_name text not null default 'stash-audio' check(bucket_name in ('audio','stash-audio'));
alter table public.audio_deletions drop constraint audio_deletions_object_name_key;
alter table public.audio_deletions add constraint audio_deletions_object_name_key unique(bucket_name,object_name);

-- Recognize only this project's canonical private and legacy public references.
create function public.stash_audio_reference(p_ref text)
returns table(bucket_name text,object_name text) language sql immutable set search_path='' as $$
 select 'stash-audio'::text,substring(p_ref from '^storage://stash-audio/([0-9a-f-]{36}/[0-9a-f-]{36}\.mp3)$')
 where p_ref ~ '^storage://stash-audio/[0-9a-f-]{36}/[0-9a-f-]{36}\.mp3$'
 union all
 select 'audio'::text,substring(p_ref from '^https://fvydjrhqaeemkdakqnfk\.supabase\.co/storage/v1/object/public/audio/([0-9a-f-]{36}\.mp3)$')
 where p_ref ~ '^https://fvydjrhqaeemkdakqnfk\.supabase\.co/storage/v1/object/public/audio/[0-9a-f-]{36}\.mp3$'
$$;
revoke all on function public.stash_audio_reference(text) from public,anon,authenticated;

create or replace function public.queue_stash_audio_deletion(p_user uuid,p_bucket text,p_name text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_bucket not in ('audio','stash-audio') then raise exception 'Unexpected bucket'; end if;
 if p_bucket='stash-audio' and p_name !~ ('^'||p_user::text||'/[0-9a-f-]{36}\.mp3$') then
  raise exception 'Unexpected private audio path'; end if;
 if p_bucket='audio' and p_name !~ '^[0-9a-f-]{36}\.mp3$' then raise exception 'Unexpected legacy audio path'; end if;
 insert into public.audio_deletions(user_id,bucket_name,object_name,expected_object_id,expected_updated_at)
 select p_user,p_bucket,p_name,o.id,o.updated_at from storage.objects o
 where o.bucket_id=p_bucket and o.name=p_name
 on conflict on constraint audio_deletions_object_name_key do update
 set expected_object_id=excluded.expected_object_id,
     expected_updated_at=excluded.expected_updated_at,status='pending',completed_at=null
 where public.audio_deletions.status='done' and (
  public.audio_deletions.expected_object_id<>excluded.expected_object_id
  or public.audio_deletions.expected_updated_at is distinct from excluded.expected_updated_at);
end $$;
revoke all on function public.queue_stash_audio_deletion(uuid,text,text) from public,anon,authenticated;

create function public.remove_stash_save_audio()
returns trigger language plpgsql security definer set search_path='' as $$
declare r record;
begin
 if tg_op='DELETE' or coalesce(new.is_archived,false) then
  for r in select * from public.stash_audio_reference(old.audio_url) loop
   perform public.queue_stash_audio_deletion(old.user_id,r.bucket_name,r.object_name);
  end loop;
  -- Fence in-flight renders and uploads before clearing the reference.
  update public.audio_jobs set status='cancelled',lease_token=null,lease_until=null,
   updated_at=now(),last_error=null where save_id=old.id;
  if tg_op='UPDATE' then
   new.audio_url:=null; new.audio_generated_at:=null; new.audio_expires_at:=null;
  end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.remove_stash_save_audio() from public,anon,authenticated;
create trigger remove_stash_save_audio before update of is_archived or delete on public.saves
 for each row execute function public.remove_stash_save_audio();
create or replace function public.enqueue_stash_audio(p_save_id uuid, p_user_id uuid)
returns public.audio_jobs language plpgsql security definer set search_path = '' as $$
declare s public.saves; j public.audio_jobs;
begin
  select * into s from public.saves where id=p_save_id and user_id=p_user_id for update;
  if not found then raise exception 'Article not found' using errcode='42501'; end if;
  if coalesce(s.is_archived,false) then raise exception 'Unarchive this article before generating audio'; end if;
  if s.audio_url is not null then return null; end if;
  if s.highlight is not null or length(trim(coalesce(s.content,''))) < 100 then
    raise exception 'This save does not contain enough article text';
  end if;
  insert into public.audio_jobs(save_id,user_id,title,source_content)
    values(s.id,s.user_id,coalesce(s.title,'Article'),s.content)
    on conflict(save_id) do nothing;
  -- A new UUID means regeneration writes a new object. Retrying deletion of
  -- the expired UUID can therefore never delete its replacement recording.
  update public.audio_jobs set id=gen_random_uuid(),status='queued',attempts=0,
    title=coalesce(s.title,'Article'),source_content=s.content,
    completed_chunks=0,total_chunks=0,last_error=null,available_at=now(),
    created_at=now(),updated_at=now(),lease_token=null,lease_until=null
    where save_id=s.id and status in ('expired','cancelled');
  update public.audio_jobs set status='queued',attempts=0,last_error=null,
    available_at=now(),updated_at=now(),lease_token=null,lease_until=null
    where save_id=s.id and status='failed';
  select * into j from public.audio_jobs where save_id=s.id;
  return j;
end $$;

create or replace function public.finish_stash_audio(p_job_id uuid, p_token uuid, p_audio_url text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare j public.audio_jobs; target_save uuid;
begin
  select save_id into target_save from public.audio_jobs where id=p_job_id;
  if target_save is null then return false; end if;
  -- All enqueue/expire/finish paths lock the save before its job.
  perform 1 from public.saves where id=target_save and not coalesce(is_archived,false) for update;
  if not found then return false; end if;
  select * into j from public.audio_jobs where id=p_job_id and status='generating'
    and lease_token=p_token and lease_until > now() for update;
  if not found then return false; end if;
  if p_audio_url <> 'storage://stash-audio/' || j.user_id::text || '/' || j.id::text || '.mp3' then
    raise exception 'Unexpected audio object path';
  end if;
  update public.saves set audio_url=p_audio_url,audio_generated_at=now(),
    audio_expires_at=now()+interval '3 months'
    where id=j.save_id and user_id=j.user_id and audio_url is null;
  update public.audio_jobs set status='ready',completed_chunks=total_chunks,last_error=null,
    lease_token=null,lease_until=null,updated_at=now() where id=j.id;
  return true;
end $$;


create or replace function public.collect_stash_audio_expirations(p_user_id uuid)
returns table(id uuid,object_name text) language plpgsql security definer set search_path = '' as $$
declare s public.saves; j public.audio_jobs; object_id uuid; object_updated_at timestamptz; object_key text;
begin
  for s in select * from public.saves where user_id=p_user_id
    and audio_url is not null and audio_expires_at <= now()
    order by audio_expires_at for update skip locked limit 100
  loop
    select * into j from public.audio_jobs where save_id=s.id and user_id=p_user_id and status='ready' for update;
    if not found then continue; end if;
    object_key := p_user_id::text || '/' || j.id::text || '.mp3';
    if s.audio_url <> 'storage://stash-audio/' || object_key then continue; end if;
    select o.id,o.updated_at into object_id,object_updated_at from storage.objects o
      where o.bucket_id='stash-audio' and o.name=object_key;
    if object_id is not null then
      insert into public.audio_deletions(user_id,object_name,expected_object_id,expected_updated_at)
        values(p_user_id,object_key,object_id,object_updated_at)
        on conflict on constraint audio_deletions_object_name_key do nothing;
    end if;
    update public.saves set audio_url=null where public.saves.id=s.id;
    update public.audio_jobs set status='expired',updated_at=now(),last_error=null,
      lease_token=null,lease_until=null where public.audio_jobs.id=j.id;
  end loop;

  -- A crash after the Storage API succeeded needs only an acknowledgement.
  update public.audio_deletions d set status='done',completed_at=now()
    where d.user_id=p_user_id and d.bucket_name='stash-audio' and d.status='pending' and not exists(
      select 1 from storage.objects o where o.bucket_id='stash-audio' and o.name=d.object_name);
  -- Fail closed if a path was replaced unexpectedly or referenced again.
  update public.audio_deletions d set status='skipped',completed_at=now()
    where d.user_id=p_user_id and d.bucket_name='stash-audio' and d.status='pending' and (
      exists(select 1 from storage.objects o where o.bucket_id='stash-audio'
        and o.name=d.object_name and (o.id<>d.expected_object_id or o.updated_at is distinct from d.expected_updated_at))
      or exists(select 1 from public.saves x where x.audio_url='storage://stash-audio/'||d.object_name));
  return query select d.id,d.object_name from public.audio_deletions d
    where d.user_id=p_user_id and d.bucket_name='stash-audio' and d.status='pending' order by d.created_at limit 100;
end $$;


-- Existing expiry RPC remains compatible with its original fixed-bucket client.
-- General cleanup first expires due recordings, then sweeps late uploads/orphans.
create function public.collect_stash_audio_cleanup(p_user_id uuid)
returns table(id uuid,bucket_name text,object_name text) language plpgsql security definer set search_path='' as $$
declare o record;
begin
 perform public.collect_stash_audio_expirations(p_user_id);
 for o in select x.bucket_id,x.name from storage.objects x
 where (
  (x.bucket_id='stash-audio' and x.name ~ ('^'||p_user_id::text||'/[0-9a-f-]{36}\.mp3$'))
  or (x.bucket_id='audio' and x.name ~ '^[0-9a-f-]{36}\.mp3$'
      -- Legacy objects have no user directory. Sweep unknown legacy orphans
      -- only for this single-account project; never guess in a multi-user DB.
      and (select count(*) from auth.users)=1 and exists(select 1 from auth.users where auth.users.id=p_user_id))
 )
 and not exists(select 1 from public.saves s cross join lateral public.stash_audio_reference(s.audio_url) r
  where r.bucket_name=x.bucket_id and r.object_name=x.name)
 and not exists(select 1 from public.audio_jobs j where j.user_id=p_user_id
  and j.status in ('queued','generating') and x.bucket_id='stash-audio'
  and x.name=p_user_id::text||'/'||j.id::text||'.mp3')
 limit 200
 loop perform public.queue_stash_audio_deletion(p_user_id,o.bucket_id,o.name); end loop;
 update public.audio_deletions d set status='done',completed_at=now()
 where d.user_id=p_user_id and d.status='pending' and not exists(
  select 1 from storage.objects x where x.bucket_id=d.bucket_name and x.name=d.object_name);
 update public.audio_deletions d set status='skipped',completed_at=now()
 where d.user_id=p_user_id and d.status='pending' and (
  exists(select 1 from storage.objects x where x.bucket_id=d.bucket_name and x.name=d.object_name
   and (x.id<>d.expected_object_id or x.updated_at is distinct from d.expected_updated_at))
  or exists(select 1 from public.saves s cross join lateral public.stash_audio_reference(s.audio_url) r
   where r.bucket_name=d.bucket_name and r.object_name=d.object_name));
 return query select d.id,d.bucket_name,d.object_name from public.audio_deletions d
 where d.user_id=p_user_id and d.status='pending' order by d.created_at limit 200;
end $$;
revoke all on function public.collect_stash_audio_cleanup(uuid) from public,anon,authenticated;
grant execute on function public.collect_stash_audio_cleanup(uuid) to service_role;

create or replace function public.ack_stash_audio_deletions(p_user_id uuid,p_ids uuid[])
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 update public.audio_deletions d set status='done',completed_at=now()
 where d.user_id=p_user_id and d.id=any(p_ids) and d.status='pending'
 and not exists(select 1 from storage.objects x where x.bucket_id=d.bucket_name and x.name=d.object_name);
 get diagnostics n=row_count; return n;
end $$;
-- Backfill only archived articles. Active legacy audio retains its no-expiry policy.
update public.saves set is_archived=true where is_archived=true;
notify pgrst,'reload schema';
commit;
