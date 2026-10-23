-- Preserve existing API owners; additional admins default to operational access.
alter table public.keychallenge_admins
  add column can_manage_api boolean not null default false;
update public.keychallenge_admins set can_manage_api = true;
comment on column public.keychallenge_admins.can_manage_api is
  'Allows API credential and connection changes. Operational admins may read usage only.';

-- Role assignment is server-only. Clients may only read their own role under RLS.
revoke all on public.keychallenge_admins from anon, authenticated;
grant select on public.keychallenge_admins to authenticated;
