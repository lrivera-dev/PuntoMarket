create function public.ensure_my_profile()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  token jsonb := auth.jwt();
  preferred_name text;
  repaired_profile public.profiles%rowtype;
begin
  if current_user_id is null then
    raise exception 'Debes iniciar sesión para recuperar tu perfil.' using errcode = '42501';
  end if;

  preferred_name := left(coalesce(
    nullif(trim(token -> 'user_metadata' ->> 'display_name'), ''),
    nullif(split_part(coalesce(token ->> 'email', ''), '@', 1), ''),
    'Participante'
  ), 40);

  insert into public.profiles (id, display_name)
  values (current_user_id, preferred_name)
  on conflict (id) do nothing;

  select * into repaired_profile
  from public.profiles
  where id = current_user_id;

  return repaired_profile;
end;
$$;

revoke all on function public.ensure_my_profile() from public, anon;
grant execute on function public.ensure_my_profile() to authenticated;
