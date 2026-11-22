import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { accountEntitlements } from '../src/entitlements.js';

// Servicios externos simulados: nunca usa credenciales ni envía mensajes reales.
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://supabase.test.invalid';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
const nativeFetch = globalThis.fetch;
let calls = [], upstream = null, server, base;
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith(process.env.SUPABASE_URL)) return nativeFetch(url, options);
  calls.push({ url, options });
  if (String(url).endsWith('/auth/v1/settings')) return Response.json({ external: { email: true }, mailer_autoconfirm: false });
  if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: 'trusted-user', email: 'trusted@example.test', email_confirmed_at: '2026-11-01T00:00:00Z' });
  return upstream ? upstream() : Response.json('cd7628f8-aeaa-4a42-82ac-e2c4997cbf50');
};
before(async () => {
  const { app } = await import('../server.js');
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { globalThis.fetch = nativeFetch; await new Promise(resolve => server.close(resolve)); });
const valid = { type: 'suggestion', subject: 'Mejorar el garage', message: 'Me gustaría incluir más modelos de motocicletas.', consent: true };
const post = (body, token = 'test-jwt') => nativeFetch(base + '/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });

test('feedback rechaza visitantes antes de consultar Supabase', async () => {
  calls = []; const response = await post(valid, null);
  assert.equal(response.status, 401); assert.equal(calls.length, 0);
});
test('feedback valida contenido y consentimiento antes de insertar', async () => {
  for (const body of [{ ...valid, consent: false }, { ...valid, subject: '  ' }, { ...valid, message: 'corto' }, { ...valid, type: 'admin' }]) {
    calls = []; const response = await post(body); assert.equal(response.status, 400);
    assert.equal(calls.filter(c => c.url.includes('/rest/')).length, 0);
  }
});
test('feedback no permite elegir usuario, correo o estado y confirma id persistido', async () => {
  calls = []; upstream = null;
  const response = await post({ ...valid, user_id: 'victim', contact_email: 'victim@example.test', status: 'closed' });
  assert.equal(response.status, 201); assert.equal((await response.json()).id, 'cd7628f8-aeaa-4a42-82ac-e2c4997cbf50');
  const request = calls.find(c => c.url.endsWith('rpc/submit_feedback'));
  assert.equal(request.options.headers.Authorization, 'Bearer test-jwt');
  assert.deepEqual(JSON.parse(request.options.body), { p_type: valid.type, p_subject: valid.subject, p_message: valid.message, p_consent: true });
});
test('el fallo de almacenamiento no se anuncia como mensaje enviado', async () => {
  upstream = () => Response.json({ message: 'database unavailable', code: 'XX000' }, { status: 503 });
  const response = await post(valid); assert.equal(response.status, 503); assert.equal((await response.json()).id, undefined);
});
test('falta de migración da una instrucción concreta', async () => {
  upstream = () => Response.json({ message: 'Missing function', code: 'PGRST202' }, { status: 404 });
  const response = await post(valid); assert.equal(response.status, 503); assert.match((await response.json()).error, /002_feedback.sql/);
});
test('el límite persistente se transforma en HTTP 429', async () => {
  upstream = () => Response.json({ message: 'FEEDBACK_RATE_LIMIT', code: 'P0001' }, { status: 400 });
  const response = await post(valid); assert.equal(response.status, 429); assert.equal((await response.json()).code, 'feedback_rate_limit');
});
test('una respuesta sin id no confirma un envío', async () => {
  upstream = () => Response.json(null); const response = await post(valid); assert.equal(response.status, 502);
});
test('Free conserva el límite y Premium requiere vigencia', () => {
  assert.equal(accountEntitlements(null, 2).canAddVehicle, false);
  assert.equal(accountEntitlements(null, 1).canUseAi, false);
  assert.equal(accountEntitlements({ plan: 'premium', status: 'active' }, 20).canAddVehicle, true);
  assert.equal(accountEntitlements({ plan: 'premium', status: 'active', current_period_end: '2020-01-01' }, 2).canUseAi, false);
});
