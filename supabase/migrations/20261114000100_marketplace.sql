create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 40),
  created_at timestamptz not null default now()
);

create function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.create_profile_for_auth_user();

create table public.catalog_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  check (requester_id <> recipient_id)
);
create unique index catalog_requests_one_pending_pair
  on public.catalog_requests(requester_id, recipient_id) where status = 'pending';

create table public.catalog_access (
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  image_path text,
  created_at timestamptz not null default now()
);
create index products_owner_created_idx on public.products(owner_id, created_at desc);

create table public.exchange_proposals (
  id uuid primary key default gen_random_uuid(),
  proposer_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  check (proposer_id <> recipient_id)
);

create table public.exchange_proposal_items (
  proposal_id uuid not null references public.exchange_proposals(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  side text not null check (side in ('offered', 'wanted')),
  primary key (proposal_id, product_id)
);

create table public.exchange_reservations (
  product_id uuid primary key references public.products(id) on delete cascade,
  proposal_id uuid not null references public.exchange_proposals(id) on delete cascade
);

alter table public.profiles enable row level security;
alter table public.catalog_requests enable row level security;
alter table public.catalog_access enable row level security;
alter table public.products enable row level security;
alter table public.exchange_proposals enable row level security;
alter table public.exchange_proposal_items enable row level security;
alter table public.exchange_reservations enable row level security;

create policy "Signed in users can see participant names"
  on public.profiles for select to authenticated using (true);
create policy "Users can edit their own profile"
  on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "Request participants can view requests"
  on public.catalog_requests for select to authenticated
  using (requester_id = (select auth.uid()) or recipient_id = (select auth.uid()));
create policy "Users can request access to another catalog"
  on public.catalog_requests for insert to authenticated
  with check (requester_id = (select auth.uid()) and requester_id <> recipient_id and status = 'pending');

create policy "Users can view catalog links they belong to"
  on public.catalog_access for select to authenticated
  using (user_a = (select auth.uid()) or user_b = (select auth.uid()));

create policy "Product owner and approved catalog partner can view products"
  on public.products for select to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from public.catalog_access access
      where (access.user_a = (select auth.uid()) and access.user_b = owner_id)
         or (access.user_b = (select auth.uid()) and access.user_a = owner_id)
    )
  );
create policy "Users can add products to their own catalog"
  on public.products for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "Users can update their own products"
  on public.products for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Users can remove their own products"
  on public.products for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy "Proposal participants can view proposals"
  on public.exchange_proposals for select to authenticated
  using (proposer_id = (select auth.uid()) or recipient_id = (select auth.uid()));
create policy "Proposal participants can view proposal items"
  on public.exchange_proposal_items for select to authenticated
  using (exists (
    select 1 from public.exchange_proposals proposal
    where proposal.id = proposal_id
      and (proposal.proposer_id = (select auth.uid()) or proposal.recipient_id = (select auth.uid()))
  ));

revoke all on public.exchange_reservations from anon, authenticated;
revoke insert, update, delete on public.catalog_access from anon, authenticated;
revoke update, delete on public.catalog_requests from anon, authenticated;
revoke insert, update, delete on public.exchange_proposals from anon, authenticated;
revoke insert, update, delete on public.exchange_proposal_items from anon, authenticated;
grant select on public.profiles, public.catalog_requests, public.catalog_access, public.products,
  public.exchange_proposals, public.exchange_proposal_items to authenticated;
grant insert on public.catalog_requests, public.products to authenticated;
grant update, delete on public.profiles, public.products to authenticated;

create function public.respond_catalog_request(p_request_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  access_request public.catalog_requests%rowtype;
  low_id uuid;
  high_id uuid;
begin
  select * into access_request from public.catalog_requests
  where id = p_request_id and recipient_id = (select auth.uid()) and status = 'pending'
  for update;
  if not found then raise exception 'Solicitud no disponible'; end if;

  update public.catalog_requests set status = case when p_accept then 'accepted' else 'declined' end
  where id = p_request_id;

  if p_accept then
    low_id := least(access_request.requester_id, access_request.recipient_id);
    high_id := greatest(access_request.requester_id, access_request.recipient_id);
    insert into public.catalog_access(user_a, user_b) values (low_id, high_id)
    on conflict (user_a, user_b) do nothing;
  end if;
end;
$$;

create function public.create_exchange_proposal(p_recipient_id uuid, p_offered_ids uuid[], p_wanted_ids uuid[])
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
  if coalesce(cardinality(p_offered_ids), 0) < 1 or coalesce(cardinality(p_wanted_ids), 0) < 1 then
    raise exception 'Elige al menos un objeto de cada catálogo';
  end if;
  if not exists (
    select 1 from public.catalog_access
    where user_a = least(proposer, p_recipient_id) and user_b = greatest(proposer, p_recipient_id)
  ) then raise exception 'Pide permiso para ver el catálogo antes de proponer'; end if;

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

create function public.respond_exchange_proposal(p_proposal_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  proposal public.exchange_proposals%rowtype;
  offered_ids uuid[];
  wanted_ids uuid[];
  low_id uuid;
  high_id uuid;
begin
  select * into proposal from public.exchange_proposals
  where id = p_proposal_id and recipient_id = (select auth.uid()) and status = 'pending'
  for update;
  if not found then raise exception 'Propuesta no disponible'; end if;

  if p_accept then
    select array_agg(item.product_id) filter (where item.side = 'offered'),
           array_agg(item.product_id) filter (where item.side = 'wanted')
      into offered_ids, wanted_ids
      from public.exchange_proposal_items item where item.proposal_id = p_proposal_id;
    if coalesce(cardinality(offered_ids), 0) = 0 or coalesce(cardinality(wanted_ids), 0) = 0 then
      raise exception 'La propuesta no tiene objetos';
    end if;
    perform 1 from public.products where id = any(offered_ids || wanted_ids) for update;
    if (select count(*) from public.products where id = any(offered_ids) and owner_id = proposal.proposer_id) <> cardinality(offered_ids)
       or (select count(*) from public.products where id = any(wanted_ids) and owner_id = proposal.recipient_id) <> cardinality(wanted_ids) then
      raise exception 'Uno de los objetos ya no pertenece a este catálogo';
    end if;
    update public.products set owner_id = proposal.recipient_id where id = any(offered_ids);
    update public.products set owner_id = proposal.proposer_id where id = any(wanted_ids);
    low_id := least(proposal.proposer_id, proposal.recipient_id);
    high_id := greatest(proposal.proposer_id, proposal.recipient_id);
    delete from public.catalog_access where user_a = low_id and user_b = high_id;
  end if;

  update public.exchange_proposals set status = case when p_accept then 'accepted' else 'declined' end where id = p_proposal_id;
  delete from public.exchange_reservations reservation where reservation.proposal_id = p_proposal_id;
end;
$$;

revoke execute on function public.respond_catalog_request(uuid, boolean) from public, anon;
revoke execute on function public.create_exchange_proposal(uuid, uuid[], uuid[]) from public, anon;
revoke execute on function public.respond_exchange_proposal(uuid, boolean) from public, anon;
grant execute on function public.respond_catalog_request(uuid, boolean) to authenticated;
grant execute on function public.create_exchange_proposal(uuid, uuid[], uuid[]) to authenticated;
grant execute on function public.respond_exchange_proposal(uuid, boolean) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Users upload images into their own folder"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users read images from their own folder"
  on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (
      select 1 from public.products product
      where product.image_path = name and (
        product.owner_id = (select auth.uid())
        or exists (
          select 1 from public.catalog_access access
          where (access.user_a = (select auth.uid()) and access.user_b = product.owner_id)
             or (access.user_b = (select auth.uid()) and access.user_a = product.owner_id)
        )
      )
    )
  ));
create policy "Users delete their own images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
