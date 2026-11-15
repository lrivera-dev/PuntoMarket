-- During the open event, all signed-in participants can browse every catalog.
drop policy if exists "Owners admins and approved partners can view products" on public.products;
drop policy if exists "Product owner and approved catalog partner can view products" on public.products;
create policy "Owners admins and participants can view products"
  on public.products for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_market_admin() or public.is_event_open());

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
      select 1 from public.products product where product.image_path = object_name
    ));
$$;

revoke all on function public.can_read_product_image(text) from public, anon;
grant execute on function public.can_read_product_image(text) to authenticated;

drop policy if exists "Users read images from their own folder" on storage.objects;
drop policy if exists "Catalog partners can read product images" on storage.objects;
create policy "Catalog partners can read product images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'product-images'
    and public.can_read_product_image(name)
  );

-- Catalog access requests are no longer part of the participant flow.
drop policy if exists "Users can request access while event is open" on public.catalog_requests;
drop policy if exists "Users can request access to another catalog" on public.catalog_requests;
revoke insert on public.catalog_requests from authenticated;
revoke execute on function public.respond_catalog_request(uuid, boolean) from authenticated;

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
  if not public.is_event_open() then raise exception 'Los intercambios están cerrados por el admin.'; end if;
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
