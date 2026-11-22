import fs from 'node:fs';
import { ApiError, getUserSubscription } from './supabase.js';
import { accountEntitlements, hasPremiumAccess } from './entitlements.js';
import { listVehicles, insertVehicle, deleteOwnVehicle, insertReport, listReports } from './garage-repository.js';
import { validateVehicle, rules, catalog } from './vehicle-validation.js';
import { generateReport } from './ai.js';

const premium = JSON.parse(fs.readFileSync(new URL('../public/premium-vehicles.json', import.meta.url)));
const key = v => [v.type, v.brand, v.model].join('\0');
const premiumKeys = new Set(premium.map(key));

export async function accountFor(token, userId) {
  const [subscription, vehicles] = await Promise.all([getUserSubscription(token, userId), listVehicles(token, userId)]);
  return accountEntitlements(subscription, vehicles.length);
}

export async function saveVehicle(token, userId, body) {
  const vehicle = validateVehicle(body);
  const subscription = await getUserSubscription(token, userId);
  if (premiumKeys.has(key(vehicle)) && !hasPremiumAccess(subscription)) {
    throw new ApiError(403, 'Ese modelo está disponible únicamente en Premium.', 'premium_vehicle_required');
  }
  try {
    const saved = await insertVehicle(token, userId, vehicle);
    if (!saved?.id) throw new ApiError(502, 'No se pudo confirmar el guardado del vehículo.', 'vehicle_unconfirmed');
    return saved;
  } catch (error) {
    if (error.message?.includes('FREE_VEHICLE_LIMIT')) throw new ApiError(403, 'El plan gratuito permite guardar hasta 2 vehículos.', 'vehicle_limit_reached');
    if (error.message?.includes('PREMIUM_VEHICLE_REQUIRED')) throw new ApiError(403, 'Ese modelo está disponible únicamente en Premium.', 'premium_vehicle_required');
    if (/VEHICLE_NOT_IN_CATALOG|INVALID_VEHICLE_YEAR|INVALID_MILEAGE/.test(error.message)) throw new ApiError(400, 'Revisa el modelo, el año y el kilometraje del vehículo.', 'invalid_vehicle');
    throw error;
  }
}

export async function analyzeVehicle(token, userId, body) {
  const vehicle = validateVehicle(body);
  if (body.customQuery !== undefined && (typeof body.customQuery !== 'string' || body.customQuery.length > 500)) {
    throw new ApiError(400, 'La consulta debe tener hasta 500 caracteres.', 'invalid_query');
  }
  const subscription = await getUserSubscription(token, userId);
  if (!hasPremiumAccess(subscription)) throw new ApiError(403, 'El diagnóstico con IA está disponible únicamente en Premium.', 'premium_required');
  const symptoms = body.customQuery?.trim() || '';
  const generated = await generateReport(vehicle, symptoms, rules.modelInfo(catalog, vehicle.type, vehicle.brand, vehicle.model));
  try {
    const saved = await insertReport(token, userId, vehicle, symptoms, generated);
    if (!saved?.id) throw new Error('Missing report id');
    return { ...generated, reportId: saved.id, saved: true };
  } catch {
    throw new ApiError(503, 'No se pudo guardar el reporte. Revisa la conexión y que la migración 005 esté aplicada antes de volver a generar.', 'report_save_failed');
  }
}

export async function removeVehicle(token, userId, id) {
  if (typeof id !== 'string' || !/^(?:[1-9][0-9]{0,18}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id)) {
    throw new ApiError(400, 'El identificador del vehículo no es válido.', 'invalid_vehicle_id');
  }
  if (!hasPremiumAccess(await getUserSubscription(token, userId))) {
    throw new ApiError(403, 'Solo Premium permite eliminar vehículos.', 'premium_required');
  }
  const rows = await deleteOwnVehicle(token, userId, id);
  if (!rows?.length) throw new ApiError(404, 'El vehículo no existe o no está disponible en tu cuenta.', 'vehicle_not_found');
}

export function reportHistory(token, userId, offset = '0') {
  if (typeof offset !== 'string' || !/^[0-9]{1,7}$/.test(offset)) throw new ApiError(400, 'La página del historial no es válida.', 'invalid_offset');
  return listReports(token, userId, Number(offset));
}
