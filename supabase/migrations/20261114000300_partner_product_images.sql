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
          or exists (
            select 1
            from public.catalog_access access
            where (access.user_a = (select auth.uid()) and access.user_b = product.owner_id)
               or (access.user_b = (select auth.uid()) and access.user_a = product.owner_id)
          )
        )
    );
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
