-- Ejecutar después de 001, 002 y 003. No elimina datos existentes.
begin;

-- No exponer esta función como RPC pública; la identidad no procede de metadata.
create schema if not exists garage_private;
revoke all on schema garage_private from public, anon;
grant usage on schema garage_private to authenticated;
create or replace function garage_private.verified_user()
returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = (select auth.uid()) and u.email_confirmed_at is not null
      and u.email is not null and not coalesce(u.is_anonymous, false)
  );
$$;
revoke all on function garage_private.verified_user() from public, anon;
grant execute on function garage_private.verified_user() to authenticated;

-- Las políticas restrictivas se combinan con AND, incluso con políticas antiguas.
drop policy if exists verified_owner_only on public.vehicles;
create policy verified_owner_only on public.vehicles as restrictive
for all to authenticated
using (user_id = (select auth.uid()) and (select garage_private.verified_user()))
with check (user_id = (select auth.uid()) and (select garage_private.verified_user()));

drop policy if exists verified_subscription_owner on public.subscriptions;
create policy verified_subscription_owner on public.subscriptions as restrictive
for all to authenticated
using (user_id = (select auth.uid()) and (select garage_private.verified_user()))
with check (false);

revoke all on public.vehicles from public, anon;
revoke all on public.subscriptions from public, anon, authenticated;
grant select on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;
revoke all on public.premium_vehicle_models from public, anon, authenticated;
grant select on public.premium_vehicle_models to authenticated;
grant all on public.premium_vehicle_models to service_role;
-- Necesario en una base nueva con columnas identity.
do $$
declare sequence_name text := pg_get_serial_sequence('public.vehicles', 'id');
begin
  if sequence_name is not null then
    execute format('grant usage, select on sequence %s to authenticated', sequence_name);
  end if;
end $$;
create index if not exists vehicles_user_created_idx on public.vehicles(user_id, created_at desc);

-- submit_feedback es SECURITY DEFINER y necesita comprobar también la verificación.
create or replace function garage_private.guard_feedback()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not garage_private.verified_user() or new.user_id is distinct from auth.uid() then
    raise exception 'EMAIL_NOT_CONFIRMED' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function garage_private.guard_feedback() from public, anon, authenticated;
drop trigger if exists feedback_verified_guard on public.feedback;
create trigger feedback_verified_guard before insert on public.feedback
for each row execute function garage_private.guard_feedback();

notify pgrst, 'reload schema';
commit;
