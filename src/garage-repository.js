import { userDatabaseRequest } from './supabase.js';

export function listVehicles(token, userId) {
  return userDatabaseRequest(token,
    `vehicles?select=id,type,brand,model,year,mileage,created_at&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`);
}

export async function insertVehicle(token, userId, vehicle) {
  const rows = await userDatabaseRequest(token, 'vehicles', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: [{ user_id: userId, ...vehicle }]
  });
  return rows?.[0];
}

export async function deleteOwnVehicle(token, userId, id) {
  return userDatabaseRequest(token,
    `vehicles?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'DELETE', headers: { Prefer: 'return=representation' }
    });
}

export async function insertReport(token, userId, vehicle, symptoms, generated) {
  const rows = await userDatabaseRequest(token, 'ai_reports', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: [{ user_id: userId, ...vehicle, symptoms, ai_model: generated.model,
      report: generated.report, result: generated.result }]
  });
  return rows?.[0];
}

export function listReports(token, userId, offset) {
  return userDatabaseRequest(token,
    `ai_reports?select=id,type,brand,model,year,mileage,ai_model,result,created_at&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc,id.desc&limit=20&offset=${offset}`);
}
