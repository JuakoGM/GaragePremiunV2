import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyMercadoPagoSignature } from '../src/mercadopago.js';
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://security.supabase.test';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_never_public';
process.env.MERCADOPAGO_WEBHOOK_SECRET = 'test-webhook-secret';
const originalFetch = globalThis.fetch;
let server, base, requests = [], authUser, authStatus, autoConfirm;
const verified = { id: '10000000-0000-4000-8000-000000000001', email: 'test@example.test', email_confirmed_at:'2026-11-01T00:00:00Z' };
const vehicle = {type:'Auto',brand:'Toyota',model:'Corolla',year:2020,mileage:10000};
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith(process.env.SUPABASE_URL)) return originalFetch(url, options);
  requests.push({url:String(url),options});
  if (String(url).endsWith('/auth/v1/user')) return Response.json(authUser,{status:authStatus});
  if (String(url).endsWith('/auth/v1/settings')) return Response.json({external:{email:true},mailer_autoconfirm:autoConfirm});
  if (String(url).includes('/subscriptions?')) return Response.json([]);
  if (String(url).endsWith('/vehicles') && options.method === 'POST') return Response.json([{id:1,...JSON.parse(options.body)[0]}]);
  return Response.json([]);
};
before(async () => {
  authUser = verified; authStatus=200; autoConfirm=false;
  const { app } = await import('../server.js');
  server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  base='http://127.0.0.1:'+server.address().port;
});
after(async () => { globalThis.fetch=originalFetch; await new Promise(r=>server.close(r)); });
const request = (path, options = {}, token = 'valid-jwt') => originalFetch(base+'/api/'+path, {
  ...options, headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}
});
test('todas las rutas privadas rechazan peticiones sin sesión antes de consultar datos', async () => {
  for (const [path,method] of [['session','GET'],['account','GET'],['vehicles','GET'],['vehicles','POST'],['feedback','POST'],['analizar-vehiculo','POST'],['subscription/checkout','POST'],['subscription/sync','POST']]) {
    requests=[];
    assert.equal((await request(path,{method},null)).status,401);
    assert.equal(requests.length,0);
  }
});
test('token falso, correo sin confirmar y usuario anónimo se rechazan en servidor', async () => {
  for (const [user,status,expected] of [[{},401,401],[{...verified,email_confirmed_at:null},200,403],[{...verified,is_anonymous:true},200,403]]) {
    authUser=user; authStatus=status; requests=[];
    assert.equal((await request('vehicles')).status,expected);
    assert.equal(requests.filter(r=>r.url.includes('/rest/')).length,0);
  }
  authUser=verified; authStatus=200;
});
test('activar autoconfirmación en Supabase bloquea incluso un token marcado como confirmado', async () => {
  autoConfirm=true;
  assert.equal((await request('session')).status,503);
  autoConfirm=false;
  assert.equal((await request('session')).status,200);
});
test('el guardado usa la identidad verificada e ignora privilegios enviados por el cliente', async () => {
  requests=[];
  const response=await request('vehicles',{method:'POST',body:JSON.stringify({...vehicle,user_id:'victim',isPremium:true})});
  assert.equal(response.status,201);
  const payload=JSON.parse(requests.find(r=>r.url.endsWith('/vehicles')).options.body)[0];
  assert.deepEqual(payload,{user_id:verified.id,...vehicle});
});
test('la API rechaza inyección SQL, propiedades del prototipo y tipos inválidos antes de escribir', async () => {
  for (const payload of [null,[],{...vehicle,brand:"Toyota' OR 1=1 --"},{...vehicle,model:'__proto__'},{...vehicle,year:1800},{...vehicle,mileage:null},{...vehicle,mileage:'1e3'}]) {
    requests=[];
    const response=await request('vehicles',{method:'POST',body:JSON.stringify(payload)});
    assert.equal(response.status,400);
    assert.equal(requests.filter(r=>r.options.method==='POST').length,0);
  }
});
test('Free no obtiene IA cambiando banderas locales y un webhook falso no activa Premium', async () => {
  assert.equal((await request('analizar-vehiculo',{method:'POST',body:JSON.stringify({...vehicle,isPremium:true})})).status,403);
  assert.equal((await request('webhooks/mercadopago',{method:'POST',body:JSON.stringify({type:'subscription_preapproval',data:{id:'forged'}})})).status,401);
});
test('configuración pública excluye secretos y respuestas de API no se almacenan en caché', async () => {
  const response=await request('public-config');
  const text=await response.text();
  assert.ok(!text.includes(process.env.SUPABASE_SECRET_KEY));
  assert.match(text,/sb_publishable_test/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal((await originalFetch(base+'/.env')).status,404);
});
test('JSON malformado, exceso de tamaño y rutas inexistentes tienen errores controlados', async () => {
  for (const [body,status] of [['{invalid',400],[JSON.stringify({data:'x'.repeat(40000)}),413]]) {
    const response=await request('vehicles',{method:'POST',body});
    assert.equal(response.status,status); assert.equal((await response.json()).error.includes('SyntaxError'),false);
  }
  assert.equal((await request('unknown')).status,404);
});
test('firma de Mercado Pago válida y alteraciones se comprueban con HMAC', () => {
  const ts=String(Date.now()),id='abcdef123',requestId='request-1';
  const digest=crypto.createHmac('sha256',process.env.MERCADOPAGO_WEBHOOK_SECRET).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
  const data={dataId:id,xRequestId:requestId,xSignature:`ts=${ts},v1=${digest}`};
  assert.equal(verifyMercadoPagoSignature(data),true);
  assert.equal(verifyMercadoPagoSignature({...data,dataId:'altered'}),false);
  assert.equal(verifyMercadoPagoSignature({...data,dataId:{id}}),false);
});
