create table public.participant_access (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.participant_access enable row level security;
revoke all on public.participant_access from anon, authenticated;
grant select on public.participant_access to authenticated;

create policy "Participants see own access and admins see all access"
  on public.participant_access for select to authenticated
  using (user_id = (select auth.uid()) or public.is_market_admin());

create function public.is_participant_enabled(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.participant_access access
    where access.user_id = p_user_id and access.enabled
  );
$$;

create function public.get_my_participant_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_participant_enabled((select auth.uid()));
$$;

create function public.set_participant_access(p_user_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_market_admin() then
    raise exception 'Solo el admin puede habilitar participantes.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'No se encontró el perfil del participante.';
  end if;
  insert into public.participant_access (user_id, enabled, updated_at)
  values (p_user_id, p_enabled, now())
  on conflict (user_id) do update
    set enabled = excluded.enabled, updated_at = now();
  return p_enabled;
end;
$$;

revoke all on function public.is_participant_enabled(uuid) from public, anon;
revoke all on function public.get_my_participant_access() from public, anon;
revoke all on function public.set_participant_access(uuid, boolean) from public, anon;
grant execute on function public.is_participant_enabled(uuid) to authenticated;
grant execute on function public.get_my_participant_access() to authenticated;
grant execute on function public.set_participant_access(uuid, boolean) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'participant_access'
     ) then
    alter publication supabase_realtime add table public.participant_access;
  end if;
end;
$$;

drop policy if exists "Participants and admins can see profiles when allowed" on public.profiles;
drop policy if exists "Signed in users can see participant names" on public.profiles;
create policy "Enabled participants can see each other"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or public.is_market_admin()
    or (
      public.is_participant_enabled((select auth.uid()))
      and public.is_participant_enabled(id)
    )
  );

drop policy if exists "Owners admins and participants can view products" on public.products;
drop policy if exists "Owners admins and approved partners can view products" on public.products;
drop policy if exists "Product owner and approved catalog partner can view products" on public.products;
create policy "Enabled participants can view approved catalogs"
  on public.products for select to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_market_admin()
    or (
      public.is_participant_enabled((select auth.uid()))
      and public.is_participant_enabled(owner_id)
    )
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
    or exists (
      select 1 from public.products product
      where product.image_path = object_name
        and (
          product.owner_id = (select auth.uid())
          or public.is_market_admin()
          or (
            public.is_participant_enabled((select auth.uid()))
            and public.is_participant_enabled(product.owner_id)
          )
        )
    );
$$;

revoke all on function public.can_read_product_image(text) from public, anon;
grant execute on function public.can_read_product_image(text) to authenticated;

create or replace function public.create_exchange_proposal(p_recipient_id uuid, p_offered_ids uuid[], p_wanted_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  proposer uuid := (select auth.uid());
  proposal_id uuid;
  offered_count integer;
  wanted_count integer;
begin
  if proposer is null or p_recipient_id = proposer then raise exception 'Intercambio no válido'; end if;
  if not public.is_participant_enabled(proposer) or not public.is_participant_enabled(p_recipient_id) then
    raise exception 'El admin debe habilitar a ambos participantes para intercambiar.';
  end if;
  if coalesce(cardinality(p_offered_ids), 0) < 1 or coalesce(cardinality(p_wanted_ids), 0) < 1 then
    raise exception 'Elige al menos un objeto de cada catálogo';
  end if;

  select count(*) into offered_count from public.products where id = any(p_offered_ids) and owner_id = proposer;
  select count(*) into wanted_count from public.products where id = any(p_wanted_ids) and owner_id = p_recipient_id;
  if offered_count <> cardinality(p_offered_ids) or wanted_count <> cardinality(p_wanted_ids) then
    raise exception 'Uno de los objetos ya no está disponible';
  end if;

  insert into public.exchange_proposals(proposer_id, recipient_id) values (proposer, p_recipient_id) returning id into proposal_id;
  insert into public.exchange_proposal_items(proposal_id, product_id, side)
    select proposal_id, item_id, 'offered' from unnest(p_offered_ids) as item_id;
  insert into public.exchange_proposal_items(proposal_id, product_id, side)
    select proposal_id, item_id, 'wanted' from unnest(p_wanted_ids) as item_id;
  insert into public.exchange_reservations(product_id, proposal_id)
    select item_id, proposal_id from unnest(p_offered_ids || p_wanted_ids) as item_id;
  return proposal_id;
end;
$$;

revoke execute on function public.create_exchange_proposal(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.create_exchange_proposal(uuid, uuid[], uuid[]) to authenticated;

drop trigger if exists catalog_access_requires_open_event on public.catalog_access;
drop trigger if exists exchange_proposals_require_open_event on public.exchange_proposals;
drop trigger if exists accepted_exchanges_require_open_event on public.exchange_proposals;

create function public.block_exchange_until_both_participants_enabled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_participant_enabled(new.proposer_id)
     or not public.is_participant_enabled(new.recipient_id) then
    raise exception 'El admin debe habilitar a ambos participantes para intercambiar.';
  end if;
  return new;
end;
$$;

revoke all on function public.block_exchange_until_both_participants_enabled() from public, anon, authenticated;

create trigger exchange_proposals_require_enabled_participants
  before insert on public.exchange_proposals
  for each row execute function public.block_exchange_until_both_participants_enabled();

create trigger accepted_exchanges_require_enabled_participants
  before update of status on public.exchange_proposals
  for each row when (new.status = 'accepted') execute function public.block_exchange_until_both_participants_enabled();
