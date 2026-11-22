import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
export const ids = {
  alice: '10000000-0000-4000-8000-000000000001',
  bob: '10000000-0000-4000-8000-000000000002',
  unverified: '10000000-0000-4000-8000-000000000003'
};
export async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `);
  for (const file of ['001_freemium.sql','002_feedback.sql','003_catalog_chile.sql','004_verified_access.sql','005_reports_and_premium_delete.sql']) {
    await db.exec(readFileSync(new URL('../../supabase/migrations/' + file, import.meta.url), 'utf8'));
  }
  for (const [name, id] of Object.entries(ids)) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)',
      [id, name + '@example.test', name === 'unverified' ? null : '2026-11-01T00:00:00Z']);
  }
  return db;
}
export async function asUser(db, id, sql, params = []) {
  return db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [id || '']);
    await tx.exec(id ? 'set local role authenticated' : 'set local role anon');
    return tx.query(sql, params);
  });
}
