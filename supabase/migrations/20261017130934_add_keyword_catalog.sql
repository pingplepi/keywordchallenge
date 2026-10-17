-- Catalog administration is separate from private influencer profiles.
create table public.keychallenge_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.keychallenge_admins enable row level security;
alter table public.keychallenge_admins force row level security;
revoke all on public.keychallenge_admins from anon, authenticated;
grant select on public.keychallenge_admins to authenticated;
create policy "Read own catalog role" on public.keychallenge_admins
  for select to authenticated using (user_id = (select auth.uid()));

create function public.keychallenge_is_admin() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists(select 1 from public.keychallenge_admins where user_id = (select auth.uid()));
$$;
revoke all on function public.keychallenge_is_admin() from public, anon;
grant execute on function public.keychallenge_is_admin() to authenticated;

-- Uploads are snapshots. Readers see a new snapshot only after publication.
create table public.keychallenge_catalogs (
  id uuid primary key default gen_random_uuid(),
  source_label text not null check (length(source_label) between 1 and 160),
  coverage text not null check (coverage in ('partial', 'all')),
  collected_at timestamptz not null,
  expected_count integer not null check (expected_count between 1 and 200000),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index keychallenge_catalogs_creator_idx on public.keychallenge_catalogs(created_by);

create table public.keychallenge_catalog_items (
  catalog_id uuid not null references public.keychallenge_catalogs(id) on delete cascade,
  keyword_id text not null check (length(keyword_id) between 1 and 100),
  name text not null check (length(name) between 1 and 200),
  field text not null check (length(field) between 1 and 100),
  field_group text check (length(field_group) <= 100),
  category_id text check (length(category_id) <= 100),
  participant_count integer check (participant_count >= 0),
  primary key (catalog_id, keyword_id)
);
create index keychallenge_catalog_items_field_idx
  on public.keychallenge_catalog_items(catalog_id, field, name, keyword_id);
create index keychallenge_catalog_items_participants_idx
  on public.keychallenge_catalog_items(catalog_id, participant_count, keyword_id);

create table public.keychallenge_catalog_publication (
  singleton boolean primary key default true check (singleton),
  catalog_id uuid not null references public.keychallenge_catalogs(id),
  published_at timestamptz not null default now()
);
create index keychallenge_catalog_publication_catalog_idx on public.keychallenge_catalog_publication(catalog_id);

alter table public.keychallenge_catalogs enable row level security;
alter table public.keychallenge_catalogs force row level security;
alter table public.keychallenge_catalog_items enable row level security;
alter table public.keychallenge_catalog_items force row level security;
alter table public.keychallenge_catalog_publication enable row level security;
alter table public.keychallenge_catalog_publication force row level security;

revoke all on public.keychallenge_catalogs, public.keychallenge_catalog_items,
  public.keychallenge_catalog_publication from anon, authenticated;
grant select on public.keychallenge_catalogs, public.keychallenge_catalog_items,
  public.keychallenge_catalog_publication to anon, authenticated;
grant insert on public.keychallenge_catalogs, public.keychallenge_catalog_items to authenticated;
grant insert, update on public.keychallenge_catalog_publication to authenticated;

create policy "Public catalog publication" on public.keychallenge_catalog_publication
  for select to anon, authenticated using (true);
create policy "Admin initial publication" on public.keychallenge_catalog_publication
  for insert to authenticated with check ((select public.keychallenge_is_admin()));
create policy "Admin switch publication" on public.keychallenge_catalog_publication
  for update to authenticated using ((select public.keychallenge_is_admin()))
  with check ((select public.keychallenge_is_admin()));

create policy "Public published catalogs" on public.keychallenge_catalogs
  for select to anon using (id = (select catalog_id from public.keychallenge_catalog_publication));
create policy "Member visible catalogs" on public.keychallenge_catalogs
  for select to authenticated using (
    id = (select catalog_id from public.keychallenge_catalog_publication)
    or (select public.keychallenge_is_admin())
  );
create policy "Admin upload catalogs" on public.keychallenge_catalogs
  for insert to authenticated with check (
    (select public.keychallenge_is_admin()) and created_by = (select auth.uid())
  );
create policy "Public published keywords" on public.keychallenge_catalog_items
  for select to anon using (catalog_id = (select catalog_id from public.keychallenge_catalog_publication));
create policy "Member visible keywords" on public.keychallenge_catalog_items
  for select to authenticated using (
    catalog_id = (select catalog_id from public.keychallenge_catalog_publication)
    or (select public.keychallenge_is_admin())
  );
create policy "Admin upload keywords" on public.keychallenge_catalog_items
  for insert to authenticated with check (
    (select public.keychallenge_is_admin())
    and catalog_id <> coalesce((select catalog_id from public.keychallenge_catalog_publication), '00000000-0000-0000-0000-000000000000'::uuid)
  );

create function public.keychallenge_publish_catalog(p_catalog_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare expected integer; actual integer;
begin
  if not public.keychallenge_is_admin() then raise exception '관리자 권한이 필요합니다.'; end if;
  select expected_count into expected from public.keychallenge_catalogs where id = p_catalog_id;
  select count(*) into actual from public.keychallenge_catalog_items where catalog_id = p_catalog_id;
  if expected is null or actual <> expected then raise exception '전체 업로드가 완료되지 않았습니다.'; end if;
  insert into public.keychallenge_catalog_publication(singleton, catalog_id, published_at)
  values(true, p_catalog_id, now()) on conflict(singleton)
  do update set catalog_id = excluded.catalog_id, published_at = excluded.published_at;
end;
$$;
revoke all on function public.keychallenge_publish_catalog(uuid) from public, anon;
grant execute on function public.keychallenge_publish_catalog(uuid) to authenticated;

create function public.keychallenge_catalog_info() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'catalog', (select jsonb_build_object('id', c.id, 'source_label', c.source_label,
      'coverage', c.coverage, 'collected_at', c.collected_at, 'total', c.expected_count)
      from public.keychallenge_catalogs c join public.keychallenge_catalog_publication p on c.id = p.catalog_id),
    'fields', coalesce((select jsonb_agg(to_jsonb(f) order by f.field) from (
      select field, count(*) as count from public.keychallenge_catalog_items
      where catalog_id = (select catalog_id from public.keychallenge_catalog_publication)
      group by field) f), '[]'::jsonb)
  );
$$;
revoke all on function public.keychallenge_catalog_info() from public;
grant execute on function public.keychallenge_catalog_info() to anon, authenticated;

create function public.keychallenge_search_catalog(
  p_query text default '', p_field text default '', p_participation text default 'all',
  p_influencer_id text default '', p_sort text default 'participants_desc', p_page integer default 1
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_catalog uuid;
  v_profile jsonb;
  v_joined jsonb := '{}'::jsonb;
  v_complete boolean := false;
  v_result jsonb;
begin
  if length(coalesce(p_query,'')) > 100 or length(coalesce(p_field,'')) > 100
     or p_page is null or p_page < 1 or p_page > 4000
     or p_participation not in ('all','joined','unjoined')
     or p_sort not in ('participants_desc','participants_asc','name') then
    raise exception '검색 조건을 확인해 주세요.';
  end if;
  select catalog_id into v_catalog from public.keychallenge_catalog_publication;
  -- Anonymous catalog searches never query private profiles.
  if auth.uid() is not null and coalesce(p_influencer_id,'') <> '' then
    select payload into v_profile from public.keychallenge_profiles
      where user_id = (select auth.uid()) and influencer_id = p_influencer_id;
    if v_profile is not null then
      select coalesce(jsonb_object_agg(item->>'id', jsonb_build_object('rank',item->'rank')), '{}'::jsonb)
        into v_joined from jsonb_array_elements(v_profile->'items') item where item->>'id' is not null;
      if jsonb_typeof(v_profile->'total') = 'number' then
        v_complete := jsonb_array_length(v_profile->'items') >= (v_profile->>'total')::numeric;
      end if;
    end if;
  end if;
  if p_participation <> 'all' and v_profile is null then
    raise exception '내 참여 데이터를 먼저 수집해 주세요.';
  end if;
  with filtered as materialized (
    select k.keyword_id, k.name, k.field, k.participant_count,
      case when v_profile is null then null else v_joined ? k.keyword_id end as joined,
      v_joined->k.keyword_id->'rank' as rank
    from public.keychallenge_catalog_items k
    where k.catalog_id = v_catalog
      and (coalesce(p_field,'') = '' or k.field = p_field)
      and (coalesce(p_query,'') = '' or strpos(lower(k.name),lower(trim(p_query))) > 0)
      and (p_participation = 'all' or (p_participation = 'joined' and v_joined ? k.keyword_id)
        or (p_participation = 'unjoined' and not v_joined ? k.keyword_id))
  ), page_rows as (
    select * from filtered order by
      case when p_sort = 'participants_desc' then participant_count end desc nulls last,
      case when p_sort = 'participants_asc' then participant_count end asc nulls last,
      name, keyword_id limit 50 offset ((p_page - 1) * 50)
  )
  select jsonb_build_object('total', (select count(*) from filtered),
    'items', coalesce((select jsonb_agg(to_jsonb(page_rows)) from page_rows),'[]'::jsonb),
    'has_profile', v_profile is not null, 'profile_complete', v_complete,
    'profile_collected_at', v_profile->>'collectedAt') into v_result;
  return v_result;
end;
$$;
revoke all on function public.keychallenge_search_catalog(text,text,text,text,text,integer) from public;
grant execute on function public.keychallenge_search_catalog(text,text,text,text,text,integer) to anon, authenticated;
