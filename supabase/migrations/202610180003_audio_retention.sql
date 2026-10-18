-- Future recordings expire after three calendar months. Existing files are
-- grandfathered: this migration deliberately leaves their expires_at NULL.
begin;
alter table public.saves add column audio_generated_at timestamptz;
alter table public.saves add column audio_expires_at timestamptz;
alter table public.audio_jobs drop constraint audio_jobs_status_check;
alter table public.audio_jobs add constraint audio_jobs_status_check
  check(status in ('queued','generating','ready','failed','expired'));

-- A durable outbox separates removing a playback reference from deleting the
-- object via the Storage API. Never delete storage.objects rows directly.
create table public.audio_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  object_name text not null unique,
  expected_object_id uuid not null,
  expected_updated_at timestamptz,
  status text not null default 'pending' check(status in ('pending','done','skipped')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.audio_deletions enable row level security;
revoke all on public.audio_deletions from anon,authenticated;
grant all on public.audio_deletions to service_role;

create or replace function public.enqueue_stash_audio(p_save_id uuid, p_user_id uuid)
returns public.audio_jobs language plpgsql security definer set search_path = '' as $$
declare s public.saves; j public.audio_jobs;
begin
  select * into s from public.saves where id=p_save_id and user_id=p_user_id for update;
  if not found then raise exception 'Article not found' using errcode='42501'; end if;
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
    where save_id=s.id and status='expired';
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
  perform 1 from public.saves where id=target_save for update;
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

create function public.collect_stash_audio_expirations(p_user_id uuid)
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
    where d.user_id=p_user_id and d.status='pending' and not exists(
      select 1 from storage.objects o where o.bucket_id='stash-audio' and o.name=d.object_name);
  -- Fail closed if a path was replaced unexpectedly or referenced again.
  update public.audio_deletions d set status='skipped',completed_at=now()
    where d.user_id=p_user_id and d.status='pending' and (
      exists(select 1 from storage.objects o where o.bucket_id='stash-audio'
        and o.name=d.object_name and (o.id<>d.expected_object_id or o.updated_at is distinct from d.expected_updated_at))
      or exists(select 1 from public.saves x where x.audio_url='storage://stash-audio/'||d.object_name));
  return query select d.id,d.object_name from public.audio_deletions d
    where d.user_id=p_user_id and d.status='pending' order by d.created_at limit 100;
end $$;

create function public.ack_stash_audio_deletions(p_user_id uuid,p_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  -- Verify disappearance in storage metadata; a successful-looking HTTP
  -- response alone is not enough to declare a file removed.
  update public.audio_deletions d set status='done',completed_at=now()
    where d.user_id=p_user_id and d.id=any(p_ids) and d.status='pending'
    and not exists(select 1 from storage.objects o where o.bucket_id='stash-audio' and o.name=d.object_name);
  get diagnostics n=row_count;
  return n;
end $$;

revoke all on function public.collect_stash_audio_expirations(uuid) from public,anon,authenticated;
revoke all on function public.ack_stash_audio_deletions(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.collect_stash_audio_expirations(uuid) to service_role;
grant execute on function public.ack_stash_audio_deletions(uuid,uuid[]) to service_role;
notify pgrst, 'reload schema';
commit;
