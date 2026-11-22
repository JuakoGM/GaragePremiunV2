const PROVIDERS = ['google', 'azure', 'apple'];
export function enabledProviders(settings) {
  return PROVIDERS.filter(provider => settings?.external?.[provider] === true);
}
function emailSignupStatus(settings) {
  if (settings?.mailer_autoconfirm === true) return 'autoconfirm';
  if (settings?.external?.email === false || settings?.disable_signup === true) return 'disabled';
  if (settings?.external?.email === true && settings.mailer_autoconfirm === false) return 'confirmation_required';
  return 'unavailable';
}
export async function getSocialProviders(url, anonKey, request = fetch) {
  const unavailable = { socialProviders: [], socialProvidersStatus: 'unavailable', emailSignupStatus: 'unavailable' };
  try {
    const response = await request(url.replace(/\/$/, '') + '/auth/v1/settings', {
      headers: { apikey: anonKey }, signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) return unavailable;
    const settings = await response.json();
    return {
      socialProviders: enabledProviders(settings),
      socialProvidersStatus: 'known',
      emailSignupStatus: emailSignupStatus(settings)
    };
  } catch {
    // El fallo de descubrimiento no bloquea el acceso existente con correo.
    return unavailable;
  }
}
