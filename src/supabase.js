import { getSocialProviders } from './auth-settings.js';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class ApiError extends Error {
  constructor(status, message, code = 'api_error', details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function requireConfig(name) {
  const value = process.env[name];
  if (!value) throw new ApiError(500, `Falta configurar ${name}.`, 'server_not_configured');
  return value;
}

export function getSupabasePublicKey() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || requireConfig('SUPABASE_ANON_KEY');
  let role;
  try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch {}
  if (key.startsWith('sb_secret_') || role === 'service_role' ||
      key === process.env.SUPABASE_SECRET_KEY || key === process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ApiError(500, 'La configuración pública contiene una clave privada.', 'invalid_public_key');
  }
  return key;
}

export async function serviceFetch(url, options = {}) {
  try { return await fetch(url, { signal: AbortSignal.timeout(10000), ...options }); }
  catch (error) {
    throw new ApiError(503, 'No pudimos conectar con el servicio. Inténtalo nuevamente.', 'service_unavailable');
  }
}

async function parseResponse(response) {
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new ApiError(502, 'El servicio entregó una respuesta inválida.', 'invalid_service_response'); }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.message || data?.msg || 'Supabase rechazó la operación.',
      data?.code || 'supabase_error',
      data
    );
  }

  return data;
}

function bearerFromRequest(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, 'Debes iniciar sesión.', 'authentication_required');
  return match[1];
}

export async function authenticateRequest(req) {
  const token = bearerFromRequest(req);
  const url = requireConfig('SUPABASE_URL');
  const anonKey = getSupabasePublicKey();

  const response = await serviceFetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });

  if (response.status >= 500) throw new ApiError(503, 'El acceso no está disponible. Inténtalo nuevamente.', 'service_unavailable');
  if (!response.ok) {
    throw new ApiError(401, 'La sesión venció. Vuelve a iniciar sesión.', 'invalid_session');
  }

  const user = await response.json();
  if (!user?.id || !user.email || user.is_anonymous || !user.email_confirmed_at) {
    throw new ApiError(403, 'Confirma tu correo antes de iniciar sesión.', 'email_not_confirmed');
  }
  // Falla de forma cerrada si se desactiva la confirmación en el proveedor.
  const settings = await getSocialProviders(url, anonKey);
  if (['autoconfirm', 'unavailable'].includes(settings.emailSignupStatus) || settings.socialProvidersStatus !== 'known') {
    throw new ApiError(503, 'El acceso requiere que el administrador active y compruebe la confirmación del correo.', 'email_confirmation_required');
  }
  return { token, user };
}

export async function userDatabaseRequest(token, path, options = {}) {
  const url = requireConfig('SUPABASE_URL');
  const anonKey = getSupabasePublicKey();
  const headers = {
    ...JSON_HEADERS,
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
    ...(options.headers || {})
  };

  const response = await serviceFetch(`${url}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  return parseResponse(response);
}

export async function adminDatabaseRequest(path, options = {}) {
  const url = requireConfig('SUPABASE_URL');
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || requireConfig('SUPABASE_SERVICE_ROLE_KEY');
  const headers = {
    ...JSON_HEADERS,
    apikey: serviceRoleKey,
    ...(!serviceRoleKey.startsWith('sb_secret_') ? { Authorization: `Bearer ${serviceRoleKey}` } : {}),
    ...(options.headers || {})
  };

  const response = await serviceFetch(`${url}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  return parseResponse(response);
}

export async function getUserSubscription(token, userId) {
  const rows = await userDatabaseRequest(
    token,
    `subscriptions?select=plan,status,current_period_end,provider_subscription_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  return rows?.[0] || null;
}

export async function getSubscriptionAsAdmin(userId) {
  const rows = await adminDatabaseRequest(
    `subscriptions?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  return rows?.[0] || null;
}

export async function upsertSubscriptionAsAdmin(subscription) {
  const rows = await adminDatabaseRequest('subscriptions?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: [subscription]
  });
  return rows?.[0] || null;
}

