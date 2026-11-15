-- Track who originally uploaded an item, even after ownership changes in a trade.
alter table public.products
  add column added_by uuid references public.profiles(id) on delete cascade;

update public.products
set added_by = owner_id
where added_by is null;

alter table public.products
  alter column added_by set default auth.uid(),
  alter column added_by set not null;

create function public.enforce_uploaded_product_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uploader uuid := auth.uid();
  uploaded_count integer;
begin
  if tg_op = 'UPDATE' then
    if new.added_by is distinct from old.added_by then
      raise exception 'The original uploader cannot be changed.';
    end if;
    return new;
  end if;

  if uploader is null then
    raise exception 'Authentication is required to add an item.';
  end if;

  -- Serialize simultaneous uploads by the same participant.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uploader::text, 0));
  select count(*)::integer into uploaded_count
  from public.products
  where added_by = uploader;

  if uploaded_count >= 5 then
    raise exception 'Límite alcanzado: puedes subir hasta 5 objetos. Los objetos recibidos por intercambio no cuentan.';
  end if;

  new.added_by := uploader;
  return new;
end;
$$;

create trigger enforce_uploaded_product_limit
  before insert or update of added_by on public.products
  for each row execute function public.enforce_uploaded_product_limit();

revoke all on function public.enforce_uploaded_product_limit() from public, anon, authenticated;

create function public.get_my_uploaded_product_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.products
  where added_by = (select auth.uid());
$$;

revoke all on function public.get_my_uploaded_product_count() from public, anon;
grant execute on function public.get_my_uploaded_product_count() to authenticated;
