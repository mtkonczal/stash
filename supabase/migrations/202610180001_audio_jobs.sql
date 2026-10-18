-- Sky audio queue. Existing saves/audio are preserved; no automatic backlog.
begin;

create table public.audio_jobs (
  id uuid primary key default gen_random_uuid(),
  save_id uuid not null unique references public.saves(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  source_content text not null,
  voice text not null default 'af_sky' check (voice = 'af_sky'),
  status text not null default 'queued' check (status in ('queued','generating','ready','failed')),
  attempts integer not null default 0,
  completed_chunks integer not null default 0,
  total_chunks integer not null default 0,
  last_error text,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index audio_jobs_pending_idx on public.audio_jobs(user_id, available_at, created_at)
  where status in ('queued','generating');
create table public.audio_workers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen timestamptz not null default now()
);
alter table public.audio_jobs enable row level security;
alter table public.audio_workers enable row level security;
create policy "Read own audio jobs" on public.audio_jobs for select to authenticated
  using (user_id = auth.uid());
create policy "Read own audio worker" on public.audio_workers for select to authenticated
  using (user_id = auth.uid());
revoke all on public.audio_jobs, public.audio_workers from anon, authenticated;
grant select on public.audio_jobs, public.audio_workers to authenticated;
grant all on public.audio_jobs, public.audio_workers to service_role;

-- All enqueueing, including Retry, is idempotent and checks save ownership.
-- The private helper is shared by the authenticated RPC and the save trigger.
create function public.enqueue_stash_audio(p_save_id uuid, p_user_id uuid)
returns public.audio_jobs language plpgsql security definer set search_path = '' as $$
declare s public.saves; j public.audio_jobs;
begin
  select * into s from public.saves where id = p_save_id and user_id = p_user_id for update;
  if not found then raise exception 'Article not found' using errcode = '42501'; end if;
  if s.audio_url is not null then return null; end if;
  if s.highlight is not null or length(trim(coalesce(s.content,''))) < 100 then
    raise exception 'This save does not contain enough article text';
  end if;
  insert into public.audio_jobs(save_id,user_id,title,source_content)
    values(s.id,s.user_id,coalesce(s.title,'Article'),s.content)
    on conflict (save_id) do nothing;
  -- Explicit Retry starts a fresh retry budget but keeps the same job/cache.
  update public.audio_jobs set status='queued', attempts=0, last_error=null,
    available_at=now(), updated_at=now(), lease_token=null, lease_until=null
    where save_id=s.id and status='failed';
  select * into j from public.audio_jobs where save_id=s.id;
  return j;
end $$;
revoke all on function public.enqueue_stash_audio(uuid,uuid) from public, anon, authenticated;

create function public.request_stash_audio(p_save_id uuid)
returns public.audio_jobs language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to generate audio' using errcode='42501'; end if;
  return public.enqueue_stash_audio(p_save_id,auth.uid());
end $$;
revoke all on function public.request_stash_audio(uuid) from public, anon;
grant execute on function public.request_stash_audio(uuid) to authenticated;

create function public.queue_new_stash_audio()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.audio_url is null and new.highlight is null and not coalesce(new.is_archived,false)
     and length(trim(coalesce(new.content,''))) >= 100
     and not exists(select 1 from public.audio_jobs where save_id=new.id) then
    perform public.enqueue_stash_audio(new.id,new.user_id);
  end if;
  return new;
end $$;
revoke all on function public.queue_new_stash_audio() from public, anon, authenticated;
create trigger queue_new_stash_audio after insert or update of content on public.saves
  for each row execute function public.queue_new_stash_audio();

-- A claim is atomic. A second worker cannot claim an unexpired job.
create function public.claim_stash_audio(p_user_id uuid, p_token uuid)
returns setof public.audio_jobs language plpgsql security definer set search_path = '' as $$
declare job_id uuid;
begin
  update public.audio_jobs set status='failed',last_error='Audio generation was interrupted repeatedly. Retry this article.',
    lease_token=null,lease_until=null,updated_at=now()
    where user_id=p_user_id and status='generating' and lease_until < now() and attempts >= 3;
  select id into job_id from public.audio_jobs
    where user_id=p_user_id and attempts < 3 and
      ((status='queued' and available_at <= now()) or (status='generating' and lease_until < now()))
    order by created_at for update skip locked limit 1;
  if job_id is null then return; end if;
  return query update public.audio_jobs set status='generating',attempts=attempts+1,
    lease_token=p_token,lease_until=now()+interval '10 minutes',updated_at=now()
    where id=job_id returning *;
end $$;

create function public.renew_stash_audio(p_job_id uuid, p_token uuid, p_completed integer, p_total integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.audio_jobs set lease_until=now()+interval '10 minutes',updated_at=now(),
    completed_chunks=p_completed,total_chunks=p_total
    where id=p_job_id and status='generating' and lease_token=p_token and lease_until > now();
  return found;
end $$;

-- Commit the URL and completion together, and reject a worker whose lease expired.
create function public.finish_stash_audio(p_job_id uuid, p_token uuid, p_audio_url text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare j public.audio_jobs;
begin
  select * into j from public.audio_jobs where id=p_job_id and status='generating'
    and lease_token=p_token and lease_until > now() for update;
  if not found then return false; end if;
  if p_audio_url <> 'storage://stash-audio/' || j.user_id::text || '/' || j.id::text || '.mp3' then
    raise exception 'Unexpected audio object path';
  end if;
  -- Respect audio that may have been attached independently while this job ran.
  update public.saves set audio_url=p_audio_url where id=j.save_id and user_id=j.user_id and audio_url is null;
  update public.audio_jobs set status='ready',completed_chunks=total_chunks,last_error=null,
    lease_token=null,lease_until=null,updated_at=now() where id=j.id;
  return true;
end $$;

create function public.fail_stash_audio(p_job_id uuid, p_token uuid, p_error text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.audio_jobs set status=case when attempts >= 3 then 'failed' else 'queued' end,
    last_error=left(p_error,500),available_at=now()+interval '1 minute' * power(2,attempts),
    lease_token=null,lease_until=null,updated_at=now()
    where id=p_job_id and status='generating' and lease_token=p_token and lease_until > now();
  return found;
end $$;

revoke all on function public.claim_stash_audio(uuid,uuid) from public, anon, authenticated;
revoke all on function public.renew_stash_audio(uuid,uuid,integer,integer) from public, anon, authenticated;
revoke all on function public.finish_stash_audio(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.fail_stash_audio(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_stash_audio(uuid,uuid) to service_role;
grant execute on function public.renew_stash_audio(uuid,uuid,integer,integer) to service_role;
grant execute on function public.finish_stash_audio(uuid,uuid,text) to service_role;
grant execute on function public.fail_stash_audio(uuid,uuid,text) to service_role;

-- New recordings are private; legacy public MP3s and their bucket are untouched.
insert into storage.buckets(id,name,public) values('stash-audio','stash-audio',false)
  on conflict(id) do nothing;
create policy "Read own Sky recordings" on storage.objects for select to authenticated
  using (bucket_id='stash-audio' and (storage.foldername(name))[1]=auth.uid()::text);

notify pgrst, 'reload schema';
commit;
