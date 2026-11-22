import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/auth-providers.js';
import { enabledProviders, getSocialProviders } from '../src/auth-settings.js';
const auth = globalThis.GarageAuth;
const origin='http://localhost:3000', supabaseUrl='https://garage.supabase.test';

test('los tres proveedores usan un retorno fijo y Microsoft solicita email',()=>{
  for(const provider of ['google','azure','apple']) {
    const request=auth.requestFor(provider,origin+'/otra?ruta=1');
    assert.equal(request.provider,provider); assert.equal(request.options.redirectTo,origin+'/?auth=callback');
    assert.equal(request.options.skipBrowserRedirect,true);
  }
  assert.equal(auth.requestFor('azure',origin).options.scopes,'email');
  assert.throws(()=>auth.requestFor('__proto__',origin));
  assert.throws(()=>auth.requestFor('microsoft',origin));
});
test('el retorno externo solo permite la URL de autorización del proyecto Supabase',()=>{
  const valid=supabaseUrl+'/auth/v1/authorize?provider=google';
  assert.equal(auth.validateAuthorizeUrl(valid,supabaseUrl,'google'),valid);
  for(const value of ['https://evil.test/auth/v1/authorize?provider=google',supabaseUrl+'/otro?provider=google',supabaseUrl+'/auth/v1/authorize?provider=apple','javascript:alert(1)']) assert.throws(()=>auth.validateAuthorizeUrl(value,supabaseUrl,'google'));
});
test('rechaza un retorno alterado aunque use el mismo proyecto Supabase',async()=>{
  await assert.rejects(()=>auth.start({auth:{signInWithOAuth:async()=>({data:{url:supabaseUrl+'/auth/v1/authorize?provider=google&redirect_to=https://otro.test'}})}},'google',origin,supabaseUrl),/retorno/);
});
test('intercambia el código una vez y limpia parámetros de acceso, conservando otros parámetros',async()=>{
  const callback=auth.readCallback(origin+'/?auth=callback&code=one-use-code&subscription=return#otra');
  assert.equal(callback.cleanUrl,'/?subscription=return#garage');
  let calls=0;
  const session=await auth.complete({auth:{exchangeCodeForSession:async code=>{calls++;assert.equal(code,'one-use-code');return {data:{session:{user:{id:'test-user'}}},error:null};}}},callback);
  assert.equal(calls,1); assert.equal(session.user.id,'test-user');
  assert.equal(await auth.complete({},auth.readCallback(origin+'/#garage')),null);
});
test('cancelación, enlaces vencidos y errores no se anuncian como una sesión iniciada',async()=>{
  const callback=auth.readCallback(origin+'/?auth=callback&error=access_denied&error_description=private-text#garage');
  assert.equal(callback.cleanUrl,'/#garage');
  await assert.rejects(()=>auth.complete({},callback));
  assert.match(auth.errorText(callback.error),/cancelado/);
  assert.ok(!auth.errorText(callback.error).includes('private-text'));
  for(const href of [origin+'/?auth=callback',origin+'/#access_token=test&refresh_token=test']) {
    const data=auth.readCallback(href); assert.equal(data.cleanUrl,'/#garage');
    await assert.rejects(()=>auth.complete({},data));
  }
  await assert.rejects(()=>auth.complete({auth:{exchangeCodeForSession:async()=>({error:{code:'flow_state_expired'}})}},auth.readCallback(origin+'/?code=expired')));
  assert.match(auth.errorText({code:'flow_state_expired'}),/venció/);
});
test('disponibilidad deriva de Supabase, sin habilitar proveedores no declarados',async()=>{
  assert.deepEqual(enabledProviders({external:{google:true,azure:true,apple:false,github:true}}),['google','azure']);
  assert.deepEqual(enabledProviders({external:{google:'true'}}),[]);
  const result=await getSocialProviders(supabaseUrl+'/', 'public-anon',async(url,options)=>{
    assert.equal(url,supabaseUrl+'/auth/v1/settings'); assert.deepEqual(options.headers,{apikey:'public-anon'}); assert.ok(options.signal);
    return Response.json({external:{apple:true,email:true},mailer_autoconfirm:false,unrelatedSecret:'must-not-be-exposed'});
  });
  assert.deepEqual(result,{socialProviders:['apple'],socialProvidersStatus:'known',emailSignupStatus:'confirmation_required'});
  const failed=await getSocialProviders(supabaseUrl,'public-anon',async()=>{throw new Error('offline');});
  assert.deepEqual(failed,{socialProviders:[],socialProvidersStatus:'unavailable',emailSignupStatus:'unavailable'});
});
test('el estado de registro distingue confirmación automática, registro deshabilitado y configuración desconocida', async () => {
  for (const [settings, status] of [
    [{ external: { email: true }, mailer_autoconfirm: true }, 'autoconfirm'],
    [{ external: { email: false }, mailer_autoconfirm: false }, 'disabled'],
    [{ external: { email: true }, mailer_autoconfirm: false, disable_signup: true }, 'disabled'],
    [{ external: { email: true } }, 'unavailable']
  ]) {
    const result = await getSocialProviders(supabaseUrl, 'public-anon', async () => Response.json(settings));
    assert.equal(result.emailSignupStatus, status);
  }
});
test('el registro por correo llama al SDK solo si se exige confirmación y conserva el retorno PKCE', async () => {
  const credentials = { email: 'test@example.com', password: 'test-password' };
  let calls = 0;
  const client = { auth: { signUp: async request => {
    calls++;
    assert.deepEqual(request, { ...credentials, options: { emailRedirectTo: origin + '/?auth=callback' } });
    return { data: { user: { id: 'new-user' }, session: null }, error: null };
  } } };
  for (const status of ['autoconfirm', 'disabled', 'unavailable', undefined]) {
    await assert.rejects(auth.registerEmail(client, credentials, origin, status));
  }
  assert.equal(calls, 0);
  await auth.registerEmail(client, credentials, origin, 'confirmation_required');
  assert.equal(calls, 1);
});
test('el registro propaga fallos de envío y cierra una sesión de alta automática inesperada', async () => {
  const credentials = { email: 'test@example.com', password: 'test-password' };
  const deliveryError = new Error('Error sending confirmation email');
  const client = { auth: { signUp: async () => ({ error: deliveryError }) } };
  await assert.rejects(auth.registerEmail(client, credentials, origin, 'confirmation_required'), error => error === deliveryError);

  const signOutCalls = [];
  client.auth.signUp = async () => ({ data: { session: { user: { id: 'unexpected-user' } } } });
  client.auth.signOut = async options => { signOutCalls.push(options); return { error: null }; };
  await assert.rejects(auth.registerEmail(client, credentials, origin, 'confirmation_required'), /registro por correo está pausado/);
  assert.deepEqual(signOutCalls, [{ scope: 'local' }]);
});
test('el SDK Supabase incluido genera OAuth PKCE para Google, Azure y Apple sin red',async()=>{
  const sandbox={URL,URLSearchParams,Headers,Request,Response,TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:globalThis.crypto,setTimeout,clearTimeout,setInterval,clearInterval,btoa,atob,console:{warn(){},log(){},error(){}}};
  sandbox.fetch=async()=>{throw new Error('La prueba no debe usar red');};
  sandbox.self=sandbox;
  vm.runInNewContext(fs.readFileSync(new URL('../public/assets/supabase.js',import.meta.url),'utf8'),sandbox,{filename:'supabase-bundled.js',displayErrors:false});
  const client=sandbox.supabase.createClient(supabaseUrl,'test-anon-key',{auth:{flowType:'pkce',detectSessionInUrl:false,persistSession:false,autoRefreshToken:false},global:{fetch:async()=>{throw new Error('La prueba no debe usar red');}}});
  for(const provider of ['google','azure','apple']) {
    const target=new URL(await auth.start(client,provider,origin,supabaseUrl));
    assert.equal(target.searchParams.get('provider'),provider);
    assert.equal(target.searchParams.get('redirect_to'),origin+'/?auth=callback');
    assert.equal(target.searchParams.get('code_challenge_method').toLowerCase(),'s256');
    assert.ok(target.searchParams.get('code_challenge').length>=43);
    if(provider==='azure') assert.equal(target.searchParams.get('scopes'),'email');
  }
});
