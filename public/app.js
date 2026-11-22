/* Interfaz de Garage Premium. El servidor y Supabase deciden los permisos. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const catalog = window.vehicleDB;
  const rules = window.GarageVehicleRules, auth = window.GarageAuth;
  const emptyAccount = () => ({ isPremium: false, canUseAi: false, canDeleteVehicle: false, canAddVehicle: false, vehicleCount: 0 });
  let client, user = null, account = emptyAccount(), config = {}, authMode = 'login';
  let premiumKeys = new Set(), sessionVersion = 0, analysisVersion = 0;
  let reportsOffset = 0, reportsVersion = 0;
  let analyzing = false, saving = false, authBusy = false, checkoutBusy = false, toastTimer;
  const vehicleKey = (type, brand, model) => [type, brand, model].join('\u0000');
  const vehicleType = () => document.querySelector('input[name="vehicleType"]:checked')?.value || '';
  const message = (id, text = '', error = false) => {
    const el = $(id); el.textContent = text; el.hidden = !text;
    el.classList.toggle('error', error); el.classList.toggle('success', Boolean(text) && !error);
  };
  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
  }
  function errorText(error) {
    if (error.code === 'email_confirmation_required') return 'El administrador debe activar la confirmación del correo en Supabase. Después recarga esta página.';
    if (error.code === 'email_not_confirmed') return 'Confirma tu correo antes de iniciar sesión.';
    if (error.code === 'server_not_configured') return 'El servicio aún no está configurado. Revisa el archivo .env del servidor.';
    if (error.code === 'PGRST205') return 'Falta preparar la base de datos. Ejecuta la migración 001_freemium.sql en Supabase.';
    if (/Invalid login credentials/i.test(error.message)) return 'El correo o la contraseña no coinciden.';
    if (/Email not confirmed/i.test(error.message)) return 'Confirma tu correo antes de iniciar sesión.';
    if (/fetch|network|Failed to fetch/i.test(error.message)) return 'No pudimos conectar. Revisa tu conexión y que el servidor esté iniciado.';
    return error.message || 'No se pudo completar la operación. Inténtalo de nuevo.';
  }
  async function api(path, options = {}) {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (!data.session) throw new Error('Inicia sesión para continuar.');
    const response = await fetch('/api/' + path, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const dataResponse = await response.json();
    if (!response.ok) {
      if (response.status === 401 || dataResponse.code === 'email_not_confirmed') await syncSession(null);
      throw Object.assign(new Error(dataResponse.error), { code: dataResponse.code });
    }
    return dataResponse;
  }
  function setAuthMode(mode) {
    if (authBusy) return;
    authMode = mode === 'signup' ? 'signup' : 'login';
    const signup = authMode === 'signup';
    $('login-tab').classList.toggle('active', !signup); $('signup-tab').classList.toggle('active', signup);
    $('login-tab').setAttribute('aria-pressed', String(!signup)); $('signup-tab').setAttribute('aria-pressed', String(signup));
    $('auth-title').textContent = signup ? 'Todo comienza con tu cuenta.' : 'Qué bueno verte de nuevo.';
    $('auth-description').textContent = signup ? 'Tu primer garage es gratis. Sin tarjeta.' : 'Tu garage te está esperando.';
    $('auth-submit').textContent = signup ? 'Crear mi cuenta ↗' : 'Entrar a mi garage ↗';
    $('password').autocomplete = signup ? 'new-password' : 'current-password';
    $('password').minLength = signup ? 8 : 1;
    $('password-help').hidden = !signup; message('auth-message');
  }
  async function authenticate(event) {
    event.preventDefault(); if (authBusy || !client) return;
    authBusy = true; $('auth-submit').disabled = true; $('auth-submit').textContent = 'Un momento…'; message('auth-message');
    try {
      const credentials = { email: $('email').value.trim(), password: $('password').value };
      if (authMode === 'signup') {
        await auth.registerEmail(client, credentials, location.origin, config.emailSignupStatus);
        $('password').value = '';
        message('auth-message', 'Revisa tu correo y confirma la cuenta desde este navegador. Después podrás iniciar sesión.');
      } else {
        const { data, error } = await client.auth.signInWithPassword(credentials);
        if (error) throw error;
        $('password').value = '';
        await syncSession(data.session);
        if (user) toast('Bienvenido a tu garage.');
      }
    } catch (error) { message('auth-message', errorText(error), true); }
    finally { authBusy = false; $('auth-submit').disabled = !client; $('auth-submit').textContent = authMode === 'signup' ? 'Crear mi cuenta ↗' : 'Entrar a mi garage ↗'; }
  }
  function updateButtons() {
    $('save-button').disabled = !user || !account.canAddVehicle || analyzing || saving;
    $('save-button').textContent = saving ? 'Guardando…' : 'Guardar vehículo ↗';
    $('ai-button').disabled = !user || analyzing;
    $('ai-button').textContent = analyzing ? 'Preparando tu orientación…' : account.canUseAi ? 'Generar orientación con IA ✦' : 'Conocer la IA de Premium ✦';
  }
  function renderAccount() {
    $('plan-badge').textContent = account.isPremium ? 'Premium activo' : 'Plan gratuito';
    $('plan-description').textContent = account.isPremium ? 'Tu colección completa, modelos exclusivos y orientación con IA.' : 'Hasta 2 vehículos. Amplía tu garage y accede a la IA con Premium.';
    $('vehicle-usage').textContent = account.isPremium ? `${account.vehicleCount} ${account.vehicleCount === 1 ? 'vehículo' : 'vehículos'} · Sin límite de cantidad` : `${account.vehicleCount} de 2 vehículos utilizados`;
    $('upgrade-button').hidden = account.isPremium;
    updateButtons(); updateModels(true);
  }
  async function refreshGarage(version = sessionVersion) {
    try {
      const [nextAccount, data] = await Promise.all([api('account'), api('vehicles')]);
      if (version !== sessionVersion || !user) return;
      account = nextAccount; renderAccount(); renderVehicles(data.vehicles); message('account-message');
    } catch (error) {
      if (version !== sessionVersion) return;
      account = emptyAccount(); updateButtons();
      $('vehicle-usage').textContent = 'No fue posible cargar tu colección.';
      message('account-message', errorText(error), true);
    }
  }
  async function syncSession(session) {
    if (user && session?.user?.id === user.id) return;
    const version = ++sessionVersion;
    let nextUser = null, authError = null;
    if (session?.access_token) {
      try {
        const response = await fetch('/api/session', { headers: { Authorization: 'Bearer ' + session.access_token } });
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data.error), { code: data.code });
        nextUser = data.user;
      } catch (error) { authError = error; }
    }
    if (version !== sessionVersion) return;
    user = nextUser; account = emptyAccount(); invalidateReport();
    $('vehicle-form').reset(); resetSelect('brand', 'Selecciona tipo…'); resetSelect('model', 'Selecciona marca…'); resetSelect('year', 'Selecciona modelo…');
    $('vehicle-list').replaceChildren(); $('reports-list').replaceChildren(); ++reportsVersion; reportsOffset = 0; $('reports-more').hidden = true; message('reports-status'); message('account-message'); message('save-message');
    $('login-section').hidden = Boolean(user); $('app-section').hidden = !user;
    $('nav-account').textContent = user ? 'Mi garage ↗' : 'Entrar ↗';
    $('garage-intro').textContent = user ? 'Tus vehículos, tus próximos kilómetros.' : 'Crea una cuenta o vuelve a la tuya para empezar.';
    $('feedback-account').textContent = user ? `Enviarás desde ${user.email || 'tu cuenta'}.` : 'Inicia sesión para enviar. Conservaremos lo que escribas mientras ingresas.';
    updateButtons();
    if (authError) message('auth-message', errorText(authError), true);
    if (user) {
      $('plan-badge').textContent = 'Cargando cuenta…'; $('plan-description').textContent = ''; $('vehicle-usage').textContent = 'Consultando tu colección…';
      await refreshGarage(version);
      await refreshReports(false);
      if (version !== sessionVersion) return;
      if (new URL(location.href).searchParams.get('subscription') === 'return') {
        try { await api('subscription/sync', { method: 'POST' }); await refreshGarage(version); toast('Estado de la suscripción actualizado.'); }
        catch (error) { message('account-message', errorText(error), true); }
        const url = new URL(location.href); url.searchParams.delete('subscription'); history.replaceState({}, '', url);
      }
    }
  }
  function resetSelect(id, placeholder) {
    $(id).replaceChildren(new Option(placeholder, '')); $(id).disabled = true;
  }
  function updateBrands() {
    resetSelect('brand', 'Selecciona marca…'); resetSelect('model', 'Selecciona marca…'); resetSelect('year', 'Selecciona modelo…');
    Object.keys(catalog[vehicleType()] || {}).sort().forEach(brand => $('brand').add(new Option(brand, brand)));
    $('brand').disabled = !vehicleType(); invalidateReport();
  }
  function updateModels(preserve = false) {
    const previous = preserve ? $('model').value : '';
    resetSelect('model', 'Selecciona modelo…');
    const models = catalog[vehicleType()]?.[$('brand').value] || {};
    Object.keys(models).sort().forEach(model => {
      const special = premiumKeys.has(vehicleKey(vehicleType(), $('brand').value, model));
      const option = new Option(model + (special ? ' · Premium' : ''), model);
      option.disabled = special && !account.isPremium; $('model').add(option);
    });
    $('model').disabled = !$('brand').value;
    if (previous && [...$('model').options].some(o => o.value === previous && !o.disabled)) $('model').value = previous;
    else { resetSelect('year', 'Selecciona modelo…'); invalidateReport(); }
  }
  function updateYears() {
    resetSelect('year', 'Selecciona año…');
    const model = catalog[vehicleType()]?.[$('brand').value]?.[$('model').value];
    if (model) { rules.yearsFor(model).forEach(year => $('year').add(new Option(year, year))); $('year').disabled = false; }
    invalidateReport();
  }
  function invalidateReport() {
    ++analysisVersion; analyzing = false;
    $('ai-response').replaceChildren(); $('ai-response').removeAttribute('aria-busy'); $('ai-response-container').hidden = true; $('report-empty').hidden = false;
    message('save-message'); updateButtons();
  }
  function readVehicle() {
    if (!vehicleType() || !$('brand').value || !$('model').value || !$('year').value) throw new Error('Selecciona tipo, marca, modelo y año del vehículo.');
    if (!$('vehicle-form').reportValidity()) return null;
    const mileage = rules.parseMileage($('mileage').value);
    if (!Number.isInteger(mileage) || mileage < 0 || mileage > 999999) throw new Error('Ingresa un kilometraje entre 0 y 999.999.');
    return { type: vehicleType(), brand: $('brand').value, model: $('model').value, year: Number($('year').value), mileage, customQuery: $('customQuery').value.trim() };
  }
  function renderReport(text) {
    const labels = { ESTADO: ['Estado general', ''], CRITICO: ['Puntos críticos', 'critical'], MANTENIMIENTO: ['Mantenimiento', 'maintenance'] };
    const pieces = [...String(text || '').matchAll(/\[(ESTADO|CRITICO|MANTENIMIENTO)\]([\s\S]*?)(?=\[(?:ESTADO|CRITICO|MANTENIMIENTO)\]|$)/g)];
    $('ai-response').replaceChildren();
    const append = (title, content, variant) => {
      const card = document.createElement('article'); card.className = 'report-card ' + variant;
      const heading = document.createElement('h4'); heading.textContent = title;
      const paragraph = document.createElement('p'); paragraph.textContent = content.trim();
      card.append(heading, paragraph); $('ai-response').append(card);
    };
    if (pieces.length) pieces.forEach(([, key, content]) => append(labels[key][0], content, labels[key][1]));
    else append('Orientación con IA', text || 'No se recibió contenido. Vuelve a intentarlo.', '');
    const note = document.createElement('p'); note.className = 'micro'; note.textContent = 'Orientación generada con IA. Puede contener errores y no sustituye una inspección mecánica.'; $('ai-response').append(note);
  }
  async function analyze(event) {
    event.preventDefault(); if (analyzing || !user) return;
    if (!account.canUseAi) { toast('La orientación con IA está incluida en Premium.'); $('planes').scrollIntoView(); return; }
    let vehicle; try { vehicle = readVehicle(); } catch (error) { message('save-message', errorText(error), true); return; }
    if (!vehicle) return;
    const version = ++analysisVersion, identity = sessionVersion;
    analyzing = true; updateButtons(); message('save-message');
    $('report-empty').hidden = true; $('ai-response-container').hidden = false;
    $('ai-response').textContent = 'Preparando una orientación para tu vehículo…'; $('ai-response').setAttribute('aria-busy', 'true');
    try {
      const data = await api('analizar-vehiculo', { method: 'POST', body: vehicle });
      if (identity === sessionVersion) {
        if (version === analysisVersion) { renderReport(data.result); message('save-message', 'Reporte guardado en tu historial privado.'); }
        await refreshReports(false);
      }
    } catch (error) {
      if (version === analysisVersion && identity === sessionVersion) { $('ai-response').textContent = errorText(error); }
    } finally { if (version === analysisVersion) { analyzing = false; updateButtons(); $('ai-response').removeAttribute('aria-busy'); } }
  }
  async function saveVehicle() {
    if (!user || saving || analyzing || !account.canAddVehicle) return;
    const identity = sessionVersion;
    try {
      const vehicle = readVehicle(); if (!vehicle) return;
      saving = true; updateButtons(); message('save-message');
      await api('vehicles', { method: 'POST', body: vehicle });
      if (identity !== sessionVersion) return;
      await refreshGarage(identity);
      message('save-message', 'Vehículo guardado en tu colección.'); toast('Tu vehículo ya está en el garage.');
    } catch (error) { if (identity === sessionVersion) message('save-message', errorText(error), true); }
    finally { saving = false; updateButtons(); }
  }
  function renderVehicles(vehicles) {
    $('vehicle-list').replaceChildren();
    if (!vehicles.length) {
      const item = document.createElement('li'); item.className = 'empty-collection'; item.textContent = 'Tu colección empieza con el primer vehículo. Completa los datos y guárdalo.'; $('vehicle-list').append(item); return;
    }
    vehicles.forEach(vehicle => {
      const item = document.createElement('li'); const details = document.createElement('div');
      const brand = document.createElement('span'); brand.className = 'vehicle-brand'; brand.textContent = vehicle.brand;
      const name = document.createElement('strong'); name.className = 'vehicle-name'; name.textContent = vehicle.model;
      const meta = document.createElement('span'); meta.className = 'vehicle-meta'; meta.textContent = `${vehicle.year} · ${vehicle.type === 'Moto' ? 'Motocicleta' : 'Automóvil'}`;
      const km = document.createElement('span'); km.className = 'vehicle-km'; km.textContent = Number(vehicle.mileage).toLocaleString('es-CL') + ' KM';
      details.append(brand, name, meta); item.append(details, km);
      if (account.canDeleteVehicle) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-outline'; button.textContent = 'Eliminar';
        button.setAttribute('aria-label', 'Eliminar ' + vehicle.brand + ' ' + vehicle.model);
        button.addEventListener('click', async () => {
          if (!confirm('¿Eliminar ' + vehicle.brand + ' ' + vehicle.model + ' de tu colección? Los reportes anteriores se conservan.')) return;
          const identity = sessionVersion; button.disabled = true;
          try {
            await api('vehicles/' + encodeURIComponent(vehicle.id), { method: 'DELETE' });
            if (identity !== sessionVersion) return;
            await refreshGarage(identity); toast('Vehículo eliminado.');
          } catch (error) { if (identity === sessionVersion) message('account-message', errorText(error), true); }
          finally { button.disabled = false; }
        });
        item.append(button);
      }
      $('vehicle-list').append(item);
    });
  }
  async function refreshReports(append = false) {
    if (!user) return;
    const identity = sessionVersion, version = ++reportsVersion;
    const offset = append ? reportsOffset : 0;
    $('reports-more').disabled = true;
    if (!append) { $('reports-list').replaceChildren(); reportsOffset = 0; $('reports-more').hidden = true; }
    message('reports-status', 'Consultando tus reportes…');
    try {
      const data = await api('reports?offset=' + offset);
      if (identity !== sessionVersion || version !== reportsVersion) return;
      for (const report of data.reports) {
        const details = document.createElement('details'); details.className = 'report-card';
        const summary = document.createElement('summary');
        summary.textContent = report.brand + ' ' + report.model + ' (' + report.year + ') · ' + new Date(report.created_at).toLocaleString('es-CL');
        const metadata = document.createElement('p'); metadata.textContent = report.type + ' · ' + Number(report.mileage).toLocaleString('es-CL') + ' km · Modelo IA: ' + report.ai_model;
        const content = document.createElement('p'); content.className = 'saved-report-text'; content.textContent = report.result;
        const note = document.createElement('p'); note.className = 'micro'; note.textContent = 'Orientación generada con IA. No sustituye una inspección mecánica.';
        details.append(summary, metadata, content, note); $('reports-list').append(details);
      }
      reportsOffset = offset + data.reports.length;
      $('reports-more').hidden = data.reports.length < 20;
      message('reports-status', reportsOffset ? '' : 'Todavía no tienes reportes guardados. Al generar uno con Premium aparecerá aquí.');
    } catch (error) {
      if (identity === sessionVersion && version === reportsVersion) message('reports-status', errorText(error), true);
    } finally { if (identity === sessionVersion && version === reportsVersion) $('reports-more').disabled = false; }
  }
  async function upgrade() {
    if (checkoutBusy) return;
    if (!user) { setAuthMode('login'); $('garage').scrollIntoView(); toast('Primero inicia sesión o crea tu cuenta gratuita.'); return; }
    if (account.isPremium) { $('garage').scrollIntoView(); toast('Tu cuenta ya tiene Premium activo.'); return; }
    if (!config.billingConfigured) { toast('Las suscripciones todavía no están habilitadas. Puedes consultar al equipo desde Hablemos.'); return; }
    const identity = sessionVersion;
    checkoutBusy = true; $('upgrade-button').disabled = true; $('premium-cta').disabled = true;
    try {
      const data = await api('subscription/checkout', { method: 'POST' });
      if (identity !== sessionVersion) return;
      if (data.active) { await refreshGarage(); toast('Premium está activo en tu cuenta.'); }
      else { const url = new URL(data.checkoutUrl); if (url.protocol !== 'https:') throw new Error('El enlace de pago no es válido.'); location.assign(url.href); }
    } catch (error) { toast(errorText(error)); }
    finally { checkoutBusy = false; $('upgrade-button').disabled = false; $('premium-cta').disabled = false; }
  }
  async function sendFeedback(event) {
    event.preventDefault();
    if (!user) { message('feedback-status', 'Inicia sesión para enviar tu mensaje. Tu borrador sigue aquí.', true); setAuthMode('login'); $('garage').scrollIntoView(); return; }
    if ($('feedback-submit').disabled) return;
    const identity = sessionVersion;
    $('feedback-submit').disabled = true; $('feedback-submit').textContent = 'Enviando…'; message('feedback-status');
    try {
      const data = await api('feedback', { method: 'POST', body: { type: $('feedback-type').value, subject: $('feedback-subject').value.trim(), message: $('feedback-message').value.trim(), consent: $('feedback-consent').checked } });
      if (identity !== sessionVersion) return;
      $('feedback-form').reset(); $('feedback-counter').textContent = '0 / 2000';
      message('feedback-status', `Recibimos tu mensaje. Referencia: ${data.id}. Gracias por ayudarnos a mejorar.`);
    } catch (error) { if (identity === sessionVersion) message('feedback-status', errorText(error), true); }
    finally { $('feedback-submit').disabled = false; $('feedback-submit').textContent = 'Enviar mensaje ↗'; }
  }
  // Navegación y controles accesibles, disponibles incluso sin configurar la cuenta.
  $('menu-toggle').addEventListener('click', () => { const open = $('site-nav').classList.toggle('open'); $('menu-toggle').setAttribute('aria-expanded', String(open)); });
  $('site-nav').addEventListener('click', event => { if (event.target.closest('a')) { $('site-nav').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('site-nav').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded', 'false'); } });
  document.querySelectorAll('[data-auth-mode]').forEach(link => link.addEventListener('click', () => setAuthMode(link.dataset.authMode)));
  $('login-tab').addEventListener('click', () => setAuthMode('login')); $('signup-tab').addEventListener('click', () => setAuthMode('signup'));
  $('password-toggle').addEventListener('click', () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; $('password-toggle').textContent = show ? 'Ocultar' : 'Mostrar'; $('password-toggle').setAttribute('aria-pressed', String(show)); $('password-toggle').setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña'); });
  $('reports-more').addEventListener('click', () => refreshReports(true));
  $('auth-form').addEventListener('submit', authenticate);
  $('signout-button').addEventListener('click', async () => {
    $('signout-button').disabled = true;
    try { const { error } = await client.auth.signOut(); if (error) throw error; await syncSession(null); toast('Sesión cerrada.'); }
    catch (error) { message('account-message', errorText(error), true); }
    finally { $('signout-button').disabled = false; }
  });
  document.querySelectorAll('input[name="vehicleType"]').forEach(radio => radio.addEventListener('change', updateBrands));
  $('brand').addEventListener('change', () => updateModels()); $('model').addEventListener('change', updateYears);
  $('year').addEventListener('change', invalidateReport); $('customQuery').addEventListener('input', invalidateReport);
  $('mileage').addEventListener('input', () => { const formatted = rules.editMileage($('mileage').value); if (formatted !== null) $('mileage').value = formatted; invalidateReport(); });
  $('vehicle-form').addEventListener('submit', analyze); $('save-button').addEventListener('click', saveVehicle);
  $('upgrade-button').addEventListener('click', upgrade); $('premium-cta').addEventListener('click', upgrade);
  $('feedback-form').addEventListener('submit', sendFeedback); $('feedback-message').addEventListener('input', () => { $('feedback-counter').textContent = `${$('feedback-message').value.length} / 2000`; });
  $('privacy-open').addEventListener('click', () => $('privacy-dialog').showModal()); $('privacy-close').addEventListener('click', () => $('privacy-dialog').close());
  $('copyright-year').textContent = new Date().getFullYear();
  const examples = { estado: ['01', 'Una visión general.', 'Un resumen orientativo basado en la edad del vehículo, el kilometraje y los síntomas que ingreses.'], critico: ['02', 'Qué conviene revisar.', 'Posibles puntos de atención para conversar con un mecánico. Son hipótesis que requieren una revisión presencial, no averías confirmadas.'], mantenimiento: ['03', 'Prepara el siguiente paso.', 'Sugerencias de comprobaciones, fluidos y componentes que podrían necesitar atención, según los datos que compartes.'] };
  const tabs = [...document.querySelectorAll('[data-example]')];
  function selectExample(tab) {
    tabs.forEach(item => { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; });
    const example = examples[tab.dataset.example]; $('example-icon').textContent = example[0]; $('example-title').textContent = example[1]; $('example-text').textContent = example[2]; $('example-panel').setAttribute('aria-labelledby', tab.id);
  }
  tabs.forEach((tab, index) => { tab.addEventListener('click', () => selectExample(tab)); tab.addEventListener('keydown', event => { let next; if (event.key === 'ArrowRight') next = (index + 1) % tabs.length; if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length; if (event.key === 'Home') next = 0; if (event.key === 'End') next = tabs.length - 1; if (next !== undefined) { event.preventDefault(); selectExample(tabs[next]); tabs[next].focus(); } }); });
  async function init() {
    try {
      const [configResponse, catalogResponse] = await Promise.all([fetch('/api/public-config'), fetch('/premium-vehicles.json')]);
      config = await configResponse.json();
      if (!configResponse.ok) throw Object.assign(new Error(config.error), { code: config.code });
      if (!catalogResponse.ok) throw new Error('No se pudo cargar el catálogo. Recarga la página.');
      premiumKeys = new Set((await catalogResponse.json()).map(v => vehicleKey(v.type, v.brand, v.model)));
      if (!window.supabase) throw new Error('No se pudo cargar el acceso. Comprueba el archivo assets/supabase.js.');
      client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { flowType: 'pkce', detectSessionInUrl: false } });
      const callback = auth.readCallback(location.href);
      if (callback.active) {
        history.replaceState({}, '', callback.cleanUrl);
        try { await auth.complete(client, callback); }
        catch (error) { message('auth-message', auth.errorText(error), true); }
      }
      $('auth-submit').disabled = false;
      if (auth.emailSignupIssue(config.emailSignupStatus)) message('config-message', auth.emailSignupIssue(config.emailSignupStatus), true);
      if (!config.billingConfigured) $('billing-note').textContent = 'Las suscripciones online aún no están habilitadas. Consulta al equipo desde Hablemos.';
      // Se difiere el trabajo asíncrono fuera del callback de Supabase Auth.
      client.auth.onAuthStateChange((_event, session) => { setTimeout(() => { syncSession(session).catch(error => message('account-message', errorText(error), true)); }, 0); });
      const { data, error } = await client.auth.getSession(); if (error) throw error;
      await syncSession(data.session);
    } catch (error) { message('config-message', errorText(error), true); }
  }
  init();
})();
