import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, asUser, ids } from './helpers/database.js';
let db;
before(async () => { db = await createDatabase(); });
after(async () => { await db?.close(); });
const insert = (user, owner = user, model = 'Corolla') => asUser(db, user,
  "insert into public.vehicles(user_id,type,brand,model,year,mileage) values($1,'Auto','Toyota',$2,2020,10000) returning id", [owner, model]);

test('SQL real: visitantes y correos sin verificar no pueden escribir ni usar feedback', async () => {
  for (const id of [null, ids.unverified]) {
    await assert.rejects(insert(id, ids.unverified));
    await assert.rejects(asUser(db,id,"select public.submit_feedback('other','Asunto válido','Mensaje válido de prueba',true)"));
  }
});
test('SQL real: cada usuario lee su colección y no puede elegir otro propietario', async () => {
  await insert(ids.alice); await insert(ids.bob);
  const rows = (await asUser(db,ids.alice,'select user_id from public.vehicles')).rows;
  assert.equal(rows.length,1); assert.equal(rows[0].user_id,ids.alice);
  await assert.rejects(insert(ids.bob,ids.alice));
  assert.equal((await asUser(db,ids.bob,'update public.vehicles set mileage=55 where user_id=$1 returning id',[ids.alice])).rows.length,0);
  assert.equal((await asUser(db,ids.bob,'delete from public.vehicles where user_id=$1 returning id',[ids.alice])).rows.length,0);
});
test('SQL real: límites Free, modelos Premium y estado de pago no dependen del navegador', async () => {
  await insert(ids.alice);
  await assert.rejects(insert(ids.alice), /FREE_VEHICLE_LIMIT/);
  await assert.rejects(insert(ids.bob,ids.bob,'Land Cruiser'), /PREMIUM_VEHICLE_REQUIRED/);
  await assert.rejects(asUser(db,ids.bob,"insert into public.subscriptions(user_id,status) values($1,'authorized')",[ids.bob]));
  await db.query("insert into public.subscriptions(user_id,status) values($1,'authorized')",[ids.bob]);
  await insert(ids.bob,ids.bob,'Land Cruiser');
});
test('SQL real: catálogo y consultas maliciosas se validan también en accesos directos', async () => {
  await assert.rejects(insert(ids.bob,ids.bob,"Corolla'); drop table public.vehicles; --"), /VEHICLE_NOT_IN_CATALOG/);
  await assert.rejects(asUser(db,ids.bob,"insert into public.vehicles(user_id,type,brand,model,year,mileage) values($1,'Auto','Toyota','Corolla',1800,0)",[ids.bob]), /INVALID_VEHICLE_YEAR/);
  assert.equal((await db.query('select count(*)::integer as n from public.vehicles')).rows[0].n,4);
});
test('SQL real: texto con SQL se guarda como texto; el feedback no permite leer datos ajenos', async () => {
  const text="Texto de prueba '); DROP TABLE public.vehicles; --";
  await asUser(db,ids.alice,"select public.submit_feedback('other','Prueba SQL',$1,true)",[text]);
  assert.equal((await db.query('select message from public.feedback')).rows[0].message,text);
  await assert.rejects(asUser(db,ids.alice,'select * from public.feedback'));
  assert.equal((await db.query('select count(*)::integer as n from public.vehicles')).rows[0].n,4);
});
test('SQL real: una política antigua permisiva no anula la protección de propietario y correo', async () => {
  await db.exec('create policy legacy_open on public.vehicles for all to authenticated using(true) with check(true)');
  assert.equal((await asUser(db,ids.unverified,'select * from public.vehicles')).rows.length,0);
  assert.equal((await asUser(db,ids.bob,'select * from public.vehicles where user_id=$1',[ids.alice])).rows.length,0);
  await assert.rejects(insert(ids.unverified));
});
