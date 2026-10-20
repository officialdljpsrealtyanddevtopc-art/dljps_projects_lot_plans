-- 01_rls_audit.sql  --  READ-ONLY. Safe to run. Changes nothing.
-- Supabase Dashboard -> SQL Editor -> paste all -> Run.
-- It returns ONE table. Copy the whole result (or export CSV) back to Claude.
-- Rows with a value in the "flag" column are the ones to look at first.

select * from (

-- 1) Is Row Level Security switched on for every table?
select 1 as o, 'rls' as section, n.nspname||'.'||c.relname as item,
       'rls='||c.relrowsecurity||'  force='||c.relforcerowsecurity as detail,
       case when not c.relrowsecurity then 'FIX: RLS OFF - table is open to anyone holding the anon key' end as flag
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind in ('r','p') and n.nspname in ('public','storage')
  and (n.nspname='public' or c.relname in ('objects','buckets'))

union all
-- 2) Every policy, and whether it lets anon / everyone in
select 2, 'policy', p.schemaname||'.'||p.tablename||' :: '||p.policyname,
       p.cmd||'  roles='||array_to_string(p.roles,',')||'  using='||coalesce(p.qual,'-')||'  check='||coalesce(p.with_check,'-'),
       case
         when p.roles && array['anon','public']::name[] and p.cmd in ('ALL','SELECT','INSERT','UPDATE','DELETE')
              and p.tablename not in ('buckets')
           then 'REVIEW: reachable WITHOUT signing in'
         when coalesce(p.qual,'')='true' or coalesce(p.with_check,'')='true'
           then 'REVIEW: any signed-in account passes (sign-ups on = anyone can become staff)'
       end
from pg_policies p
where p.schemaname in ('public','storage')

union all
-- 3) Views (the live buyer link reads public_lots / public_config)
select 3, 'view', n.nspname||'.'||c.relname,
       'options='||coalesce(array_to_string(c.reloptions,','),'(none: runs as owner, bypasses RLS)')||
       '  def='||left(regexp_replace(pg_get_viewdef(c.oid),'\s+',' ','g'),400),
       case when n.nspname='public' and (c.reloptions is null or not c.reloptions::text ilike '%security_invoker=true%')
            then 'CHECK: bypasses RLS by design - confirm it exposes ONLY availability, never names/contacts' end
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind='v' and n.nspname='public'

union all
-- 4) What anon can do directly on tables (grants are normal in Supabase; RLS is what protects)
select 4, 'anon_grant', table_schema||'.'||table_name, string_agg(privilege_type,','), null
from information_schema.role_table_grants
where grantee='anon' and table_schema='public'
group by table_schema, table_name

union all
-- 5) Storage buckets (client documents / ID photos live here)
select 5, 'bucket', b.id, 'public='||b.public||'  size_limit='||coalesce(b.file_size_limit::text,'none'),
       case when b.public then 'FIX: bucket is PUBLIC - anyone with a file URL can open client documents' end
from storage.buckets b

union all
-- 6) Who can sign in right now
select 6, 'auth_user', coalesce(u.email,u.id::text),
       'created='||to_char(u.created_at,'YYYY-MM-DD')||'  last_sign_in='||coalesce(to_char(u.last_sign_in_at,'YYYY-MM-DD'),'never')||
       '  confirmed='||(u.email_confirmed_at is not null)||'  name='||coalesce(u.raw_user_meta_data->>'name','-'),
       null
from auth.users u

union all
-- 7) Columns of the tables the app uses (the sync function relies on these)
select 7, 'column', table_name||'.'||column_name, data_type||'  default='||coalesce(column_default,'-'), null
from information_schema.columns
where table_schema='public' and table_name in ('lots','settings','activity')

union all
-- 8) Triggers already on those tables
select 8, 'trigger', event_object_table||' :: '||trigger_name, event_manipulation||' '||action_timing, null
from information_schema.triggers
where trigger_schema='public'

union all
-- 9) Extensions needed for scheduled sync
select 9, 'extension', name, coalesce(installed_version,'NOT INSTALLED'), null
from pg_available_extensions where name in ('pg_cron','pg_net','supabase_vault')

) t order by o, item;
