-- Allow authenticated clients to receive only the event visibility state in Realtime.
grant select on public.event_settings to authenticated;
drop policy if exists "Signed in users can read event status" on public.event_settings;
create policy "Signed in users can read event status"
  on public.event_settings for select to authenticated using (true);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'event_settings'
     ) then
    alter publication supabase_realtime add table public.event_settings;
  end if;
end;
$$;
