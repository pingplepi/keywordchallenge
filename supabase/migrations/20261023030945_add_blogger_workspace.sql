-- Display preference only: membership mode never grants administrator privileges.
create table public.keychallenge_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null check(mode in ('blogger','influencer')),
  blog_id text check(blog_id ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
  interest text not null default '' check(length(interest)<=100),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(mode<>'blogger' or blog_id is not null)
);
insert into public.keychallenge_members(user_id,mode)
select distinct user_id,'influencer' from public.keychallenge_profiles on conflict do nothing;

create table public.keychallenge_blog_keywords (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  keyword text not null check(length(trim(keyword)) between 1 and 100),
  keyword_key text generated always as (public.keychallenge_keyword_key(keyword)) stored,
  folder text not null default '' check(length(folder)<=60),
  notes text not null default '' check(length(notes)<=2000),
  archived boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,keyword_key), unique(id,user_id)
);
create index keychallenge_blog_keywords_user_date_idx on public.keychallenge_blog_keywords(user_id,archived,created_at desc);
create table public.keychallenge_blog_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  keyword_id uuid not null,
  title text not null check(length(trim(title)) between 1 and 200),
  notes text not null default '' check(length(notes)<=5000),
  status text not null default 'planned' check(status in ('planned','drafting','published')),
  planned_date date, published_date date,
  post_url text check(length(post_url)<=2000 and post_url ~ '^https://(m[.])?blog[.]naver[.]com/'),
  archived boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(keyword_id,user_id) references public.keychallenge_blog_keywords(id,user_id),
  check(status<>'published' or (published_date is not null and post_url is not null))
);
create index keychallenge_blog_plans_user_date_idx on public.keychallenge_blog_plans(user_id,archived,planned_date);
create index keychallenge_blog_plans_keyword_idx on public.keychallenge_blog_plans(keyword_id,user_id);

create function public.keychallenge_touch_updated_at() returns trigger language plpgsql security invoker set search_path='' as $$
begin new.updated_at=now(); return new; end $$;
revoke all on function public.keychallenge_touch_updated_at() from public,anon,authenticated;
do $$ declare t text; begin
  foreach t in array array['keychallenge_members','keychallenge_blog_keywords','keychallenge_blog_plans'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select,insert,update on public.%I to authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    execute format('create policy "Read own workspace data" on public.%I for select to authenticated using(user_id=(select auth.uid()))',t);
    execute format('create policy "Insert own workspace data" on public.%I for insert to authenticated with check(user_id=(select auth.uid()))',t);
    execute format('create policy "Update own workspace data" on public.%I for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()))',t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.keychallenge_touch_updated_at()',t);
  end loop;
end $$;

create function public.keychallenge_save_blog_keyword(p_keyword text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result public.keychallenge_blog_keywords;
begin
  if auth.uid() is null or length(trim(p_keyword)) not between 1 and 100 then raise exception '키워드를 확인해 주세요.'; end if;
  insert into public.keychallenge_blog_keywords(user_id,keyword) values(auth.uid(),trim(p_keyword))
  on conflict(user_id,keyword_key) do update set archived=false returning * into result;
  return to_jsonb(result);
end $$;
revoke all on function public.keychallenge_save_blog_keyword(text) from public,anon;
grant execute on function public.keychallenge_save_blog_keyword(text) to authenticated;

create function public.keychallenge_blogger_summary(p_month date) returns jsonb
language sql stable security invoker set search_path='' as $$
 with bounds as(select (now() at time zone 'Asia/Seoul')::date today,date_trunc('month',p_month)::date month_start),
 plans as materialized(select p.*,k.keyword,coalesce(p.published_date,p.planned_date) event_date from public.keychallenge_blog_plans p
   join public.keychallenge_blog_keywords k on k.id=p.keyword_id and k.user_id=p.user_id where p.user_id=(select auth.uid()) and not p.archived),
 upcoming as(select * from plans where status<>'published' and planned_date is not null order by planned_date,title limit 6),
 saved as(select k.*,v.volume_min,v.volume_max from public.keychallenge_blog_keywords k left join public.keychallenge_search_volumes v on v.keyword_key=k.keyword_key and v.available
   where k.user_id=(select auth.uid()) and not k.archived order by k.created_at desc limit 6),
 days as(select event_date as day,count(*) total,count(*) filter(where status='published') published from plans,bounds
   where event_date>=month_start and event_date<(month_start+interval '1 month') group by event_date)
 select jsonb_build_object('saved',(select count(*) from public.keychallenge_blog_keywords where user_id=(select auth.uid()) and not archived),
   'drafting',(select count(*) from plans where status='drafting'),
   'published',(select count(*) from plans,bounds where status='published' and published_date>=date_trunc('month',today) and published_date<date_trunc('month',today)+interval '1 month'),
   'upcoming_count',(select count(*) from plans,bounds where status<>'published' and planned_date between today and today+6),
   'upcoming',coalesce((select jsonb_agg(to_jsonb(upcoming)) from upcoming),'[]'),
   'recent',coalesce((select jsonb_agg(to_jsonb(saved)) from saved),'[]'),
   'days',coalesce((select jsonb_agg(to_jsonb(days)) from days),'[]'));
$$;
revoke all on function public.keychallenge_blogger_summary(date) from public,anon;
grant execute on function public.keychallenge_blogger_summary(date) to authenticated;

create function public.keychallenge_blogger_saved(p_query text default '',p_folder text default '',p_archived boolean default false,p_page integer default 1) returns jsonb
language sql stable security invoker set search_path='' as $$
 with matches as materialized(select k.*,v.volume_min,v.volume_max,v.collected_at volume_collected_at,
   (select count(*) from public.keychallenge_blog_plans p where p.keyword_id=k.id and p.user_id=(select auth.uid()) and not p.archived) plan_count
   from public.keychallenge_blog_keywords k left join public.keychallenge_search_volumes v on v.keyword_key=k.keyword_key and v.available
   where k.user_id=(select auth.uid()) and k.archived=p_archived and (p_folder='' or k.folder=p_folder)
     and (p_query='' or strpos(lower(k.keyword),lower(left(p_query,100)))>0)),
 rows as(select * from matches order by created_at desc,id limit 24 offset (least(greatest(p_page,1),10000)-1)*24)
 select jsonb_build_object('total',(select count(*) from matches),'items',coalesce((select jsonb_agg(to_jsonb(rows)) from rows),'[]'),
   'folders',coalesce((select jsonb_agg(folder order by folder) from (select distinct folder from public.keychallenge_blog_keywords where user_id=(select auth.uid()) and folder<>'') f),'[]'));
$$;
revoke all on function public.keychallenge_blogger_saved(text,text,boolean,integer) from public,anon;
grant execute on function public.keychallenge_blogger_saved(text,text,boolean,integer) to authenticated;

create function public.keychallenge_blogger_plans(p_month date default null,p_day date default null,p_status text default '',p_archived boolean default false,p_page integer default 1) returns jsonb
language sql stable security invoker set search_path='' as $$
 with matches as materialized(select p.*,k.keyword,coalesce(p.published_date,p.planned_date) event_date
   from public.keychallenge_blog_plans p join public.keychallenge_blog_keywords k on k.id=p.keyword_id and k.user_id=p.user_id
   where p.user_id=(select auth.uid()) and p.archived=p_archived and (p_status='' or p.status=p_status)
     and (p_month is null or (coalesce(p.published_date,p.planned_date)>=date_trunc('month',p_month) and coalesce(p.published_date,p.planned_date)<date_trunc('month',p_month)+interval '1 month'))
     and (p_day is null or coalesce(p.published_date,p.planned_date)=p_day)),
 rows as(select * from matches order by case when status='published' then 1 else 0 end,event_date nulls last,created_at desc,id limit 30 offset (least(greatest(p_page,1),10000)-1)*30)
 select jsonb_build_object('total',(select count(*) from matches),'items',coalesce((select jsonb_agg(to_jsonb(rows)) from rows),'[]'));
$$;
revoke all on function public.keychallenge_blogger_plans(date,date,text,boolean,integer) from public,anon;
grant execute on function public.keychallenge_blogger_plans(date,date,text,boolean,integer) to authenticated;

-- Server-only shared search cache and bounded upstream usage. API keys stay in Vault.
create table public.keychallenge_keyword_lookup_cache (
 keyword_key text primary key, items jsonb not null check(jsonb_typeof(items)='array' and jsonb_array_length(items)<=200),
 collected_at timestamptz not null default now()
);
create table public.keychallenge_keyword_lookup_usage (
 user_id uuid primary key references auth.users(id) on delete cascade,
 usage_day date not null, day_count integer not null default 0,
 minute_start timestamptz not null, minute_count integer not null default 0
);
alter table public.keychallenge_keyword_lookup_cache enable row level security;
alter table public.keychallenge_keyword_lookup_usage enable row level security;
revoke all on public.keychallenge_keyword_lookup_cache,public.keychallenge_keyword_lookup_usage from public,anon,authenticated;
grant all on public.keychallenge_keyword_lookup_cache,public.keychallenge_keyword_lookup_usage to service_role;
create function public.keychallenge_claim_keyword_lookup(p_user_id uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare u public.keychallenge_keyword_lookup_usage; today date:=(now() at time zone 'Asia/Seoul')::date; minute_bucket timestamptz:=date_trunc('minute',now());
begin
 insert into public.keychallenge_keyword_lookup_usage(user_id,usage_day,minute_start) values(p_user_id,today,minute_bucket) on conflict do nothing;
 select * into u from public.keychallenge_keyword_lookup_usage where user_id=p_user_id for update;
 if u.usage_day<>today then u.day_count:=0; end if;
 if u.minute_start<>minute_bucket then u.minute_count:=0; end if;
 if u.day_count>=100 or u.minute_count>=10 then return false; end if;
 update public.keychallenge_keyword_lookup_usage set usage_day=today,day_count=u.day_count+1,minute_start=minute_bucket,minute_count=u.minute_count+1 where user_id=p_user_id;
 return true;
end $$;
revoke all on function public.keychallenge_claim_keyword_lookup(uuid) from public,anon,authenticated;
grant execute on function public.keychallenge_claim_keyword_lookup(uuid) to service_role;
