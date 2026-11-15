alter table public.exchange_proposals
  add column if not exists accepted_at timestamptz;

-- Existing accepted exchanges have no acceptance timestamp; proposal creation is the best historical approximation.
update public.exchange_proposals
set accepted_at = created_at
where status = 'accepted' and accepted_at is null;

create function public.stamp_exchange_acceptance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    new.accepted_at := now();
  end if;
  return new;
end;
$$;

create trigger stamp_exchange_acceptance
  before update of status on public.exchange_proposals
  for each row execute function public.stamp_exchange_acceptance();

create function public.get_admin_participant_exchanges(p_profile_id uuid)
returns table (
  proposal_id uuid,
  counterparty_id uuid,
  counterparty_name text,
  accepted_at timestamptz,
  given_items text[],
  received_items text[]
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_market_admin() then
    raise exception 'Solo el admin puede consultar el historial de intercambios.' using errcode = '42501';
  end if;

  return query
  select proposal.id,
         partner.id,
         partner.display_name,
         coalesce(proposal.accepted_at, proposal.created_at),
         array(
           select product.name
           from public.exchange_proposal_items item
           join public.products product on product.id = item.product_id
           where item.proposal_id = proposal.id
             and item.side = case when proposal.proposer_id = p_profile_id then 'offered' else 'wanted' end
           order by product.name
         ),
         array(
           select product.name
           from public.exchange_proposal_items item
           join public.products product on product.id = item.product_id
           where item.proposal_id = proposal.id
             and item.side = case when proposal.proposer_id = p_profile_id then 'wanted' else 'offered' end
           order by product.name
         )
  from public.exchange_proposals proposal
  join public.profiles partner
    on partner.id = case when proposal.proposer_id = p_profile_id then proposal.recipient_id else proposal.proposer_id end
  where proposal.status = 'accepted'
    and (proposal.proposer_id = p_profile_id or proposal.recipient_id = p_profile_id)
  order by coalesce(proposal.accepted_at, proposal.created_at) desc;
end;
$$;

revoke all on function public.stamp_exchange_acceptance() from public, anon, authenticated;
revoke all on function public.get_admin_participant_exchanges(uuid) from public, anon;
grant execute on function public.get_admin_participant_exchanges(uuid) to authenticated;
