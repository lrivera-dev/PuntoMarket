create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;
grant select on public.admin_users to authenticated;

create policy "Admins can check their own access"
  on public.admin_users for select to authenticated
  using (user_id = (select auth.uid()));

create function public.get_admin_exchange_stats()
returns table (
  profile_id uuid,
  display_name text,
  completed_exchanges bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.admin_users admin_user
    where admin_user.user_id = (select auth.uid())
  ) then
    raise exception 'No tienes permiso para consultar estas estadísticas.' using errcode = '42501';
  end if;

  return query
    with completed_profiles as (
      select proposal.proposer_id as user_id
      from public.exchange_proposals proposal
      where proposal.status = 'accepted'
      union all
      select proposal.recipient_id as user_id
      from public.exchange_proposals proposal
      where proposal.status = 'accepted'
    )
    select participant.id,
           participant.display_name,
           count(completed_profiles.user_id)::bigint
    from public.profiles participant
    left join completed_profiles on completed_profiles.user_id = participant.id
    group by participant.id, participant.display_name
    order by count(completed_profiles.user_id) desc, participant.display_name asc;
end;
$$;

revoke all on function public.get_admin_exchange_stats() from public, anon;
grant execute on function public.get_admin_exchange_stats() to authenticated;
