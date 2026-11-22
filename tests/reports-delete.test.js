import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, asUser, ids } from './helpers/database.js';
process.env.NODE_ENV='test';
process.env.SUPABASE_URL='https://reports.supabase.test';
process.env.SUPABASE_PUBLISHABLE_KEY='sb_publishable_test';
process.env.GEMINI_API_KEY='test-only';
const nativeFetch=globalThis.fetch;
let db,server,base,aliceVehicle,bobVehicle,savedReport,failInsert=false,invalidAi=false;
const vehicle={type:'Auto',brand:'Toyota',model:'Corolla',year:2020,mileage:10000};
const report={estado:'Orientación de prueba',critico:['Revisar frenos','Revisar neumáticos'],mantenimiento:['Consultar manual','Revisar fluidos']};
globalThis.fetch=async(url,options={})=>{
 const target=new URL(url);
 if(target.hostname==='generativelanguage.googleapis.com') return Response.json({candidates:[{content:{role:'model',parts:[{text:invalidAi?'invalid':JSON.stringify(report)}]},finishReason:'STOP'}]});
 if(target.origin!==process.env.SUPABASE_URL)return nativeFetch(url,options);
 const name=(options.headers?.Authorization||'').replace('Bearer ','');
 const id=ids[name];
 if(target.pathname.endsWith('/settings'))return Response.json({external:{email:true},mailer_autoconfirm:false});
 if(target.pathname.endsWith('/user'))return id?Response.json({id,email:name+'@example.test',email_confirmed_at:name==='unverified'?null:'2026-11-01T00:00:00Z'}):Response.json({},{status:401});
 try{
  if(target.pathname.endsWith('/subscriptions'))return Response.json((await asUser(db,id,'select * from public.subscriptions where user_id=$1',[id])).rows);
  if(target.pathname.endsWith('/vehicles')&&options.method==='DELETE'){
   const vehicleId=target.searchParams.get('id').slice(3);
   const owner=target.searchParams.get('user_id').slice(3);
   return Response.json((await asUser(db,id,'delete from public.vehicles where id=$1 and user_id=$2 returning id',[vehicleId,owner])).rows);
  }
  if(target.pathname.endsWith('/ai_reports')){
   if(options.method==='POST'){
    if(failInsert)return Response.json({message:'database failed'},{status:503});
    const v=JSON.parse(options.body)[0];
    const row=await asUser(db,id,'insert into public.ai_reports(user_id,type,brand,model,year,mileage,symptoms,ai_model,report,result) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[v.user_id,v.type,v.brand,v.model,v.year,v.mileage,v.symptoms,v.ai_model,JSON.stringify(v.report),v.result]);
    return Response.json(row.rows);
   }
   const owner=target.searchParams.get('user_id').slice(3);
   const offset=Number(target.searchParams.get('offset'));
   return Response.json((await asUser(db,id,'select * from public.ai_reports where user_id=$1 order by created_at desc,id desc limit 20 offset $2',[owner,offset])).rows);
  }
  return Response.json([]);
 }catch(error){return Response.json({message:error.message,code:error.code},{status:403});}
};
before(async()=>{
 db=await createDatabase();
 for(const name of ['alice','bob']){
  const row=await asUser(db,ids[name],"insert into public.vehicles(user_id,type,brand,model,year,mileage) values($1,'Auto','Toyota','Corolla',2020,10000) returning id",[ids[name]]);
  if(name==='alice')aliceVehicle=row.rows[0].id;else bobVehicle=row.rows[0].id;
 }
 const {app}=await import('../server.js');server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{globalThis.fetch=nativeFetch;await new Promise(r=>server.close(r));await db?.close();});
const api=(route,name='alice',method='GET',body)=>nativeFetch(base+'/api/'+route,{method,headers:{'Content-Type':'application/json',...(name?{Authorization:'Bearer '+name}:{})},body:body===undefined?undefined:JSON.stringify(body)});
const premium=()=>db.query("insert into public.subscriptions(user_id,status,current_period_end) values($1,'active',null) on conflict(user_id) do update set status='active',current_period_end=null",[ids.alice]);

test('reportes y eliminación requieren una sesión',async()=>{
 assert.equal((await api('reports',null)).status,401);
 assert.equal((await api('vehicles/'+aliceVehicle,null,'DELETE')).status,401);
});
test('Free no elimina vehículos propios por API ni por SQL directo',async()=>{
 assert.equal((await api('vehicles/'+aliceVehicle,'alice','DELETE')).status,403);
 assert.equal((await asUser(db,ids.alice,'delete from public.vehicles where id=$1 returning id',[aliceVehicle])).rows.length,0);
});
test('solo Premium inserta reportes y nadie elige otro propietario',async()=>{
 const sql="insert into public.ai_reports(user_id,type,brand,model,year,mileage,ai_model,report,result) values($1,'Auto','Toyota','Corolla',2020,10000,'test',$2,'texto de prueba')";
 await assert.rejects(asUser(db,ids.alice,sql,[ids.alice,JSON.stringify(report)]));
 await premium();
 await assert.rejects(asUser(db,ids.alice,sql,[ids.bob,JSON.stringify(report)]));
});
test('generación por API guarda la salida del servidor y se recupera del historial',async()=>{
 const response=await api('analizar-vehiculo','alice','POST',{...vehicle,customQuery:'Revisión de prueba',user_id:ids.bob,result:'forged'});
 assert.equal(response.status,200);const data=await response.json();assert.equal(data.saved,true);assert.ok(data.reportId);savedReport=data.reportId;
 const history=await(await api('reports')).json();assert.equal(history.reports.length,1);assert.equal(history.reports[0].id,savedReport);assert.match(history.reports[0].result,/Orientación de prueba/);
 assert.equal((await db.query('select user_id from public.ai_reports')).rows[0].user_id,ids.alice);
});
test('otra cuenta y correo no verificado no ven el reporte ni pueden modificarlo',async()=>{
 assert.equal((await(await api('reports','bob')).json()).reports.length,0);
 assert.equal((await api('reports','unverified')).status,403);
 assert.equal((await asUser(db,ids.unverified,'select * from public.ai_reports')).rows.length,0);
 await assert.rejects(asUser(db,ids.alice,"update public.ai_reports set result='altered'"));
 await assert.rejects(asUser(db,ids.alice,'delete from public.ai_reports'));
});
test('Premium no borra un vehículo ajeno y rechaza identificadores manipulados',async()=>{
 assert.equal((await api('vehicles/'+bobVehicle,'alice','DELETE')).status,404);
 assert.equal((await api('vehicles/bad-id','alice','DELETE')).status,400);
 assert.equal((await db.query('select count(*)::integer as n from public.vehicles')).rows[0].n,2);
});
test('Premium elimina su vehículo y el reporte conserva su instantánea',async()=>{
 assert.equal((await api('vehicles/'+aliceVehicle,'alice','DELETE')).status,200);
 assert.equal((await api('vehicles/'+aliceVehicle,'alice','DELETE')).status,404);
 assert.equal((await(await api('reports')).json()).reports[0].id,savedReport);
});
test('Premium vencido pierde el borrado pero conserva lectura de reportes',async()=>{
 await db.query("update public.subscriptions set current_period_end='2020-01-01' where user_id=$1",[ids.alice]);
 assert.equal((await api('vehicles/'+bobVehicle,'alice','DELETE')).status,403);
 assert.equal((await(await api('reports')).json()).reports.length,1);
 assert.equal((await asUser(db,ids.alice,'delete from public.vehicles returning id')).rows.length,0);
});
test('paginación validada y sin acceso a datos por filtros manipulados',async()=>{
 assert.equal((await api('reports?offset=20')).status,200);
 assert.equal((await api('reports?offset=invalid')).status,400);
});
test('fallo de almacenamiento no anuncia reporte guardado',async()=>{
 await premium();failInsert=true;
 const response=await api('analizar-vehiculo','alice','POST',vehicle);
 assert.equal(response.status,503);assert.equal((await response.json()).code,'report_save_failed');failInsert=false;
 assert.equal((await db.query('select count(*)::integer as n from public.ai_reports')).rows[0].n,1);
});
test('respuesta inválida de Gemini no llega al historial',async()=>{
 invalidAi=true;const response=await api('analizar-vehiculo','alice','POST',vehicle);
 assert.equal(response.status,502);invalidAi=false;
 assert.equal((await db.query('select count(*)::integer as n from public.ai_reports')).rows[0].n,1);
});
