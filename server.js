import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ApiError,
  authenticateRequest,
  getSupabasePublicKey,
  getSubscriptionAsAdmin,
  upsertSubscriptionAsAdmin,
  userDatabaseRequest
} from './src/supabase.js';
import { accountFor, saveVehicle, analyzeVehicle, removeVehicle, reportHistory } from './src/garage.js';
import { listVehicles } from './src/garage-repository.js';
import { getSocialProviders } from './src/auth-settings.js';
import {
  createCheckout,
  getProviderSubscription,
  providerRecord,
  verifyMercadoPagoSignature
} from './src/mercadopago.js';

import { validateFeedback, mapFeedbackError } from './src/feedback.js';

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  let authOrigin = '';
  try { authOrigin = new URL(process.env.SUPABASE_URL).origin; } catch {}
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' " + authOrigin + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/public-config', asyncRoute(async (req, res) => {
  if (!process.env.SUPABASE_URL) throw new ApiError(503, 'Falta configurar Supabase.', 'server_not_configured');
  const publicKey = getSupabasePublicKey();
  const settings = await getSocialProviders(process.env.SUPABASE_URL, publicKey);
  res.json({
    supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: publicKey,
    emailSignupStatus: settings.emailSignupStatus,
    billingConfigured: Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN && process.env.MERCADOPAGO_PLAN_ID && process.env.MERCADOPAGO_WEBHOOK_SECRET && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) && (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL))
  });
}));

app.get('/api/session', asyncRoute(async (req, res) => {
  const { user } = await authenticateRequest(req);
  res.json({ user: { id: user.id, email: user.email, email_confirmed_at: user.email_confirmed_at } });
}));

app.get('/api/account', asyncRoute(async (req, res) => {
  const { token, user } = await authenticateRequest(req);
  res.json(await accountFor(token, user.id));
}));

app.get('/api/vehicles', asyncRoute(async (req, res) => {
  const { token, user } = await authenticateRequest(req);
  const vehicles = await listVehicles(token, user.id);
  res.json({ vehicles });
}));

app.delete('/api/vehicles/:id', asyncRoute(async (req, res) => {
  const { token, user } = await authenticateRequest(req);
  await removeVehicle(token, user.id, req.params.id);
  res.json({ deleted: true });
}));
app.get('/api/reports', asyncRoute(async (req, res) => {
  const { token, user } = await authenticateRequest(req);
  res.json({ reports: await reportHistory(token, user.id, req.query.offset) });
}));

app.post('/api/feedback', asyncRoute(async (req, res) => {
  const { token } = await authenticateRequest(req);
  const payload = validateFeedback(req.body);
  try {
    const id = await userDatabaseRequest(token, 'rpc/submit_feedback', {
      method: 'POST', body: payload
    });
    if (typeof id !== 'string' || !id) {
      throw new ApiError(502, 'No se pudo confirmar el registro del mensaje.', 'feedback_unconfirmed');
    }
    res.status(201).json({ id });
  } catch (error) {
    throw mapFeedbackError(error);
  }
}));

app.post('/api/vehicles', asyncRoute(async (req, res) => {
  const { token, user } = await authenticateRequest(req);
  res.status(201).json({ vehicle: await saveVehicle(token, user.id, req.body) });
}));

// Límite por usuario para controlar el consumo de servicios de pago.
const usage = new Map();
const usageCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of usage) if (entry.expires <= now) usage.delete(key);
}, 60000);
usageCleanup.unref();
function limitUsage(userId, action, max) {
  const key = action + ':' + userId, now = Date.now();
  let entry = usage.get(key);
  if (!entry || entry.expires <= now) { entry = { count: 0, expires: now + 60000 }; usage.set(key, entry); }
  if (++entry.count > max) throw new ApiError(429, 'Espera un minuto antes de volver a intentarlo.', 'rate_limit');
}
app.post('/api/analizar-vehiculo', asyncRoute(async (req, res) => {
  const { token, user } = await authenticateRequest(req);
  limitUsage(user.id, 'ai', 5);
  res.json(await analyzeVehicle(token, user.id, req.body));
}));

app.post('/api/subscription/checkout', asyncRoute(async (req, res) => {
  const { user } = await authenticateRequest(req);
  limitUsage(user.id, 'billing', 5);
  const existing = await getSubscriptionAsAdmin(user.id);

  if (existing?.provider_subscription_id) {
    const providerSubscription = await getProviderSubscription(existing.provider_subscription_id);
    if (providerSubscription.external_reference !== user.id) {
      throw new ApiError(409, 'La suscripción existente no coincide con el usuario.', 'subscription_mismatch');
    }

    await upsertSubscriptionAsAdmin(providerRecord(providerSubscription));
    if (providerSubscription.status === 'authorized') {
      return res.json({ active: true });
    }
    if (providerSubscription.status === 'pending' && providerSubscription.init_point) {
      return res.json({ checkoutUrl: providerSubscription.init_point });
    }
  }

  const providerSubscription = await createCheckout(user);
  await upsertSubscriptionAsAdmin(providerRecord(providerSubscription));
  res.status(201).json({ checkoutUrl: providerSubscription.init_point });
}));

app.post('/api/subscription/sync', asyncRoute(async (req, res) => {
  const { token, user } = await authenticateRequest(req);
  limitUsage(user.id, 'billing', 5);
  const existing = await getSubscriptionAsAdmin(user.id);
  if (!existing?.provider_subscription_id) {
    throw new ApiError(404, 'No hay una suscripción para sincronizar.', 'subscription_not_found');
  }

  const providerSubscription = await getProviderSubscription(existing.provider_subscription_id);
  if (providerSubscription.external_reference !== user.id) {
    throw new ApiError(409, 'La suscripción no coincide con el usuario.', 'subscription_mismatch');
  }

  await upsertSubscriptionAsAdmin(providerRecord(providerSubscription));
  res.json(await accountFor(token, user.id));
}));

app.post('/api/webhooks/mercadopago', asyncRoute(async (req, res) => {
  const dataId = req.query['data.id'] || req.body?.data?.id;
  const valid = verifyMercadoPagoSignature({
    xSignature: req.get('x-signature'),
    xRequestId: req.get('x-request-id'),
    dataId
  });

  if (!valid) {
    throw new ApiError(401, 'Firma de webhook inválida.', 'invalid_webhook_signature');
  }

  const topic = req.query.type || req.query.topic || req.body?.type;
  if (topic === 'subscription_preapproval') {
    const providerSubscription = await getProviderSubscription(String(dataId));
    await upsertSubscriptionAsAdmin(providerRecord(providerSubscription));
  }

  res.sendStatus(200);
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'La ruta solicitada no existe.', code: 'not_found' }));
app.use((error, req, res, next) => {
  if (process.env.NODE_ENV !== 'test') console.error('[API]', error.code || 'internal_error', 'status:', error.status || 500);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const badJson = error.type === 'entity.parse.failed';
  res.status(status).json({
    error: badJson ? 'El contenido enviado no es válido.' : error.type === 'entity.too.large' ? 'El contenido enviado es demasiado grande.' : (error instanceof ApiError && !error.details ? error.message : status >= 500 ? 'No se pudo completar la operación.' : 'Revisa los datos enviados e inténtalo nuevamente.'),
    code: badJson ? 'invalid_json' : error.code || 'internal_error'
  });
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`Servidor Garage Premium disponible en http://localhost:${PORT}`);
  });
}
