-- Owner-only listening preferences and per-recording resume points.
begin;
create table public.audio_preferences (
 user_id uuid primary key references auth.users(id) on delete cascade,
 speed double precision not null check(speed in (0.75,1,1.25,1.5,2)),
 changed_at timestamptz not null,
 updated_at timestamptz not null default now()
);
create table public.audio_positions (
 user_id uuid not null references auth.users(id) on delete cascade,
 save_id uuid not null references public.saves(id) on delete cascade,
 audio_url text not null,
 position_seconds double precision not null check(position_seconds>=0 and position_seconds<'Infinity'::double precision),
 duration_seconds double precision not null check(duration_seconds>0 and duration_seconds<'Infinity'::double precision),
 completed boolean not null default false,
 changed_at timestamptz not null,
 updated_at timestamptz not null default now(),
 primary key(user_id,save_id),
 check(position_seconds<=duration_seconds)
);
alter table public.audio_preferences enable row level security;
alter table public.audio_positions enable row level security;
create policy "Read own listening preference" on public.audio_preferences for select to authenticated using(user_id=auth.uid());
create policy "Read own listening positions" on public.audio_positions for select to authenticated using(user_id=auth.uid());
revoke all on public.audio_preferences,public.audio_positions from anon,authenticated;
grant select on public.audio_preferences,public.audio_positions to authenticated;
grant all on public.audio_preferences,public.audio_positions to service_role;

create function public.remember_stash_audio_speed(p_speed double precision,p_changed_at timestamptz)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Sign in to save listening preferences' using errcode='42501'; end if;
 if p_changed_at is null then raise exception 'Missing change timestamp'; end if;
 insert into public.audio_preferences(user_id,speed,changed_at)
 values(auth.uid(),p_speed,least(p_changed_at,clock_timestamp()))
 on conflict(user_id) do update set speed=excluded.speed,changed_at=excluded.changed_at,updated_at=now()
 where excluded.changed_at>=public.audio_preferences.changed_at;
 return found;
end $$;

create function public.remember_stash_audio_position(p_save_id uuid,p_audio_url text,
 p_position double precision,p_duration double precision,p_completed boolean,p_changed_at timestamptz)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Sign in to save listening position' using errcode='42501'; end if;
 if p_changed_at is null then raise exception 'Missing change timestamp'; end if;
 -- Lock the save so archive/delete and this write have a consistent order.
 perform 1 from public.saves where id=p_save_id and user_id=auth.uid()
  and audio_url=p_audio_url and not coalesce(is_archived,false) for share;
 if not found then return false; end if;
 insert into public.audio_positions(user_id,save_id,audio_url,position_seconds,duration_seconds,completed,changed_at)
 values(auth.uid(),p_save_id,p_audio_url,p_position,p_duration,p_completed,least(p_changed_at,clock_timestamp()))
 on conflict(user_id,save_id) do update set audio_url=excluded.audio_url,
  position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,
  completed=excluded.completed,changed_at=excluded.changed_at,updated_at=now()
 where excluded.audio_url<>public.audio_positions.audio_url or excluded.changed_at>=public.audio_positions.changed_at;
 return found;
end $$;
revoke all on function public.remember_stash_audio_speed(double precision,timestamptz) from public,anon;
revoke all on function public.remember_stash_audio_position(uuid,text,double precision,double precision,boolean,timestamptz) from public,anon;
grant execute on function public.remember_stash_audio_speed(double precision,timestamptz) to authenticated;
grant execute on function public.remember_stash_audio_position(uuid,text,double precision,double precision,boolean,timestamptz) to authenticated;
notify pgrst,'reload schema';
commit;
