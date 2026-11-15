-- A traded product keeps its original Storage path; let its current owner read it too.
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
      select 1
      from public.products product
      where product.image_path = object_name
        and (
          product.owner_id = (select auth.uid())
          or public.is_market_admin()
          or public.is_event_open()
        )
    );
$$;

revoke all on function public.can_read_product_image(text) from public, anon;
grant execute on function public.can_read_product_image(text) to authenticated;
