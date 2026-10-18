-- Measure storage before uploads; only the trusted worker can inspect totals.
begin;
create function public.stash_audio_storage_bytes(p_object text)
returns bigint language sql security definer set search_path = '' as $$
  select coalesce(sum(coalesce((metadata->>'size')::bigint,0)),0)::bigint
  from storage.objects
  where not (bucket_id='stash-audio' and name=p_object)
$$;
revoke all on function public.stash_audio_storage_bytes(text) from public,anon,authenticated;
grant execute on function public.stash_audio_storage_bytes(text) to service_role;
notify pgrst, 'reload schema';
commit;
