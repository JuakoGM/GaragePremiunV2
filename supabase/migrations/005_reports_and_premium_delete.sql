-- Ejecutar después de 004. Conserva vehículos y suscripciones existentes.
begin;
create or replace function garage_private.premium_user()
returns boolean language sql stable security definer set search_path='' as $$
 select garage_private.verified_user() and public.has_premium_access(auth.uid());
$$;
revoke all on function garage_private.premium_user() from public, anon;
grant execute on function garage_private.premium_user() to authenticated;
-- AND con cualquier política antigua. Un usuario Free no puede borrar por REST.
drop policy if exists premium_vehicle_delete on public.vehicles;
create policy premium_vehicle_delete on public.vehicles as restrictive
for delete to authenticated using ((select garage_private.premium_user()));

create table if not exists public.ai_reports (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 type text not null check(type in ('Auto','Moto')),
 brand text not null, model text not null,
 year integer not null, mileage integer not null check(mileage between 0 and 999999),
 symptoms text not null default '' check(char_length(symptoms)<=500),
 ai_model text not null check(char_length(ai_model) between 1 and 120),
 report jsonb not null check(jsonb_typeof(report)='object' and report ?& array['estado','critico','mantenimiento']),
 result text not null check(char_length(result) between 1 and 15000),
 created_at timestamptz not null default now()
);
create index if not exists ai_reports_user_date on public.ai_reports(user_id,created_at desc,id);
alter table public.ai_reports enable row level security;
revoke all on public.ai_reports from public,anon,authenticated;
grant select,insert on public.ai_reports to authenticated;
grant all on public.ai_reports to service_role;
drop policy if exists reports_owner_guard on public.ai_reports;
create policy reports_owner_guard on public.ai_reports as restrictive for all to authenticated
 using(user_id=(select auth.uid()) and (select garage_private.verified_user()))
 with check(user_id=(select auth.uid()) and (select garage_private.verified_user()));
drop policy if exists read_own_reports on public.ai_reports;
create policy read_own_reports on public.ai_reports for select to authenticated
 using(user_id=(select auth.uid()));
drop policy if exists premium_insert_reports on public.ai_reports;
create policy premium_insert_reports on public.ai_reports for insert to authenticated
 with check(user_id=(select auth.uid()) and (select garage_private.premium_user()));
-- Una instantánea independiente conserva el reporte al borrar un vehículo.
drop trigger if exists report_catalog_guard on public.ai_reports;
create trigger report_catalog_guard before insert on public.ai_reports
 for each row execute function public.validate_catalog_vehicle();
notify pgrst,'reload schema';
commit;
