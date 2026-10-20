-- 02_rls_harden.sql
-- Locks the database down to an explicit staff allow-list.
-- RUN ONLY AFTER you have run 01_rls_audit.sql and looked at the result.
--
-- STEP 0: put the e-mail of every person who should have access in the list below
--         (first one becomes admin, the rest staff). If you skip this the script
--         stops itself before changing anything, so you cannot lock yourself out.
--
-- The whole script is one transaction: if anything errors, nothing is changed.

begin;

-- ---------- 0. staff allow-list ----------
create table if not exists public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role    text not null default 'staff' check (role in ('admin','staff')),
  name    text
);
alter table public.staff enable row level security;

-- >>> EDIT THESE E-MAILS <<<  (admins first line, staff second line)
insert into public.staff (user_id, role, name)
select u.id, 'admin', coalesce(u.raw_user_meta_data->>'name', split_part(u.email,'@',1))
from auth.users u where lower(u.email) in (lower('REPLACE_ADMIN@EXAMPLE.COM'))
on conflict (user_id) do update set role = 'admin';

insert into public.staff (user_id, role, name)
select u.id, 'staff', coalesce(u.raw_user_meta_data->>'name', split_part(u.email,'@',1))
from auth.users u where lower(u.email) in (lower('REPLACE_STAFF1@EXAMPLE.COM'), lower('REPLACE_STAFF2@EXAMPLE.COM'))
on conflict (user_id) do nothing;

do $$ begin
  if not exists (select 1 from public.staff where role='admin') then
    raise exception 'No admin matched. Edit the e-mail addresses in STEP 0 (they must already exist under Authentication > Users). Nothing was changed.';
  end if;
end $$;

-- ---------- 1. helper functions ----------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.staff where user_id = auth.uid()) $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.staff where user_id = auth.uid() and role='admin') $$;

revoke all on function public.is_staff(), public.is_admin() from public, anon;
grant execute on function public.is_staff(), public.is_admin() to authenticated, service_role;

drop policy if exists staff_self on public.staff;
create policy staff_self on public.staff for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- ---------- 2. drop every existing policy on the app tables, then recreate ----------
do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname='public' and tablename in ('lots','settings','activity') loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.lots     enable row level security;
alter table public.settings enable row level security;
alter table public.activity enable row level security;

-- lots / settings: staff read + write. (Delete must stay allowed: the app deletes a row when a lot is cleared.
-- lots_history below keeps a copy of every deleted/overwritten row.)
create policy staff_all on public.lots     for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.settings for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- activity log: append-only for staff
create policy staff_read   on public.activity for select to authenticated using (public.is_staff());
create policy staff_insert on public.activity for insert to authenticated with check (public.is_staff());

-- ---------- 3. take direct table access away from anon ----------
-- Skipped automatically if a public view runs with security_invoker (that would need anon table access).
do $$ declare inv boolean; begin
  select coalesce(bool_or(c.reloptions::text ilike '%security_invoker=true%'), false) into inv
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='v' and c.relname in ('public_lots','public_config');
  if inv then
    raise notice 'public_lots/public_config use security_invoker: NOT revoking anon table grants. Re-check after reading the audit.';
  else
    revoke all on public.lots, public.settings, public.activity from anon;
  end if;
end $$;

-- ---------- 4. private documents bucket ----------
update storage.buckets set public = false where id = 'documents';

do $$ declare r record; begin
  for r in select policyname from pg_policies
           where schemaname='storage' and tablename='objects'
             and (coalesce(qual,'') ilike '%documents%' or coalesce(with_check,'') ilike '%documents%') loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

create policy documents_staff_read   on storage.objects for select to authenticated using (bucket_id='documents' and public.is_staff());
create policy documents_staff_insert on storage.objects for insert to authenticated with check (bucket_id='documents' and public.is_staff());
create policy documents_staff_delete on storage.objects for delete to authenticated using (bucket_id='documents' and public.is_staff());

-- ---------- 5. safety net: keep a copy of every overwritten / deleted lot ----------
create table if not exists public.lots_history (
  id         bigserial primary key,
  key        text not null,
  op         text not null,
  old_data   jsonb,
  new_data   jsonb,
  changed_by text,
  changed_at timestamptz not null default now()
);
create index if not exists lots_history_key_idx on public.lots_history (key, changed_at desc);
alter table public.lots_history enable row level security;
drop policy if exists staff_read on public.lots_history;
create policy staff_read on public.lots_history for select to authenticated using (public.is_staff());

create or replace function public.log_lot_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into public.lots_history(key, op, old_data, changed_by) values (old.key, 'DELETE', old.data, old.updated_by);
  elsif old.data is distinct from new.data then
    insert into public.lots_history(key, op, old_data, new_data, changed_by) values (new.key, 'UPDATE', old.data, new.data, new.updated_by);
  end if;
  return null;
end $$;

drop trigger if exists lots_history_t on public.lots;
create trigger lots_history_t after update or delete on public.lots for each row execute function public.log_lot_change();

commit;

-- ---------- Manual steps (cannot be done in SQL) ----------
-- Dashboard > Authentication > Sign In / Providers > Email:
--   turn OFF "Allow new users to sign up". Add staff yourself under Authentication > Users > Add user.
-- Dashboard > Authentication > Attack Protection: leave rate limits on; consider a minimum password length of 10+.
-- To add a person later: create the user, then
--   insert into public.staff(user_id, role, name) select id,'staff','Their Name' from auth.users where email='them@example.com';
-- To remove access:  delete from public.staff where user_id = (select id from auth.users where email='them@example.com');
