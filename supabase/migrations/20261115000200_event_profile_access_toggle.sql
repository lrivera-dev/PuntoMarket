create table public.event_settings (
  singleton boolean primary key default true check (singleton),
  profiles_open boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.event_settings (singleton, profiles_open) values (true, false)
on conflict (singleton) do nothing;

alter table public.event_settings enable row level security;
revoke all on public.event_settings from anon, authenticated;
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

create function public.is_event_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select profiles_open from public.event_settings where singleton), false);
$$;

create function public.is_market_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admin_users where user_id = (select auth.uid()));
$$;

create function public.get_event_status()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_event_open();
$$;

create function public.set_event_profiles_open(p_open boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_market_admin() then
    raise exception 'Solo el admin puede cambiar el acceso a los perfiles.' using errcode = '42501';
  end if;
  update public.event_settings
  set profiles_open = p_open, updated_at = now()
  where singleton;
  return p_open;
end;
$$;

revoke all on function public.is_event_open() from public, anon;
revoke all on function public.is_market_admin() from public, anon;
revoke all on function public.get_event_status() from public, anon;
revoke all on function public.set_event_profiles_open(boolean) from public, anon;
grant execute on function public.is_event_open() to authenticated;
grant execute on function public.is_market_admin() to authenticated;
grant execute on function public.get_event_status() to authenticated;
grant execute on function public.set_event_profiles_open(boolean) to authenticated;

drop policy if exists "Signed in users can see participant names" on public.profiles;
create policy "Participants and admins can see profiles when allowed"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.is_market_admin() or public.is_event_open());

drop policy if exists "Users can request access to another catalog" on public.catalog_requests;
create policy "Users can request access while event is open"
  on public.catalog_requests for insert to authenticated
  with check (
    public.is_event_open()
    and requester_id = (select auth.uid())
    and requester_id <> recipient_id
    and status = 'pending'
  );

drop policy if exists "Product owner and approved catalog partner can view products" on public.products;
create policy "Owners admins and approved partners can view products"
  on public.products for select to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_market_admin()
    or (public.is_event_open() and exists (
      select 1 from public.catalog_access access
      where (access.user_a = (select auth.uid()) and access.user_b = owner_id)
         or (access.user_b = (select auth.uid()) and access.user_a = owner_id)
    ))
  );

create or replace function public.can_read_product_image(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (storage.foldername(object_name))[1] = (select auth.uid())::text
    or (public.is_market_admin() and exists (
      select 1 from public.products product where product.image_path = object_name
    ))
    or (public.is_event_open() and exists (
      select 1
      from public.products product
      where product.image_path = object_name
        and (
          product.owner_id = (select auth.uid())
          or exists (
            select 1 from public.catalog_access access
            where (access.user_a = (select auth.uid()) and access.user_b = product.owner_id)
               or (access.user_b = (select auth.uid()) and access.user_a = product.owner_id)
          )
        )
    ));
$$;

revoke all on function public.can_read_product_image(text) from public, anon;
grant execute on function public.can_read_product_image(text) to authenticated;

create function public.block_trade_actions_while_closed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_event_open() then
    raise exception 'Los perfiles y los intercambios están cerrados por el admin.';
  end if;
  return new;
end;
$$;

revoke all on function public.block_trade_actions_while_closed() from public, anon, authenticated;

create trigger catalog_access_requires_open_event
  before insert on public.catalog_access
  for each row execute function public.block_trade_actions_while_closed();

create trigger exchange_proposals_require_open_event
  before insert on public.exchange_proposals
  for each row execute function public.block_trade_actions_while_closed();

create trigger accepted_exchanges_require_open_event
  before update of status on public.exchange_proposals
  for each row when (new.status = 'accepted') execute function public.block_trade_actions_while_closed();
