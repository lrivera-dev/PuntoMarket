import './style.css';
import { isSupabaseConfigured, supabase } from './supabase.js';

const app = document.querySelector('#app');
let session = null;
let profile = null;
let profiles = [];
let isAdmin = false;
let eventProfilesOpen = false;
let activeView = 'people';
let selectedProfile = null;
let visibleProducts = [];
let selectedWanted = [];
let selectedOffered = [];
let catalogOpen = false;
let searchText = '';
let toastTimer;
let noticeChannel = null;
let noticePollTimer = null;
let lastNoticeCount = null;
let liveDataPollTimer = null;
let liveDataSyncBusy = false;
let adminRefreshTimer = null;

const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initials = (name = '?') => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

function toast(message) {
  clearTimeout(toastTimer);
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    Object.assign(node.style, { position: 'fixed', left: '50%', bottom: '22px', transform: 'translateX(-50%)', zIndex: '30', background: '#07143d', color: 'white', padding: '12px 16px', borderRadius: '10px', fontSize: '13px' });
    document.body.append(node);
  }
  node.textContent = message;
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 2800);
}

function showError(container, error) {
  const rawMessage = typeof error === 'string' ? error : error?.message || '';
  const signupDisabled = error?.code === 'signup_disabled' || /signups? (are )?disabled|signup_disabled/i.test(rawMessage);
  const message = signupDisabled
    ? 'El registro de cuentas está apagado en Supabase. Activa “Allow new users to sign up” en Authentication → Settings.'
    : rawMessage || 'Ocurrió un error. Intenta de nuevo.';
  let node = container.querySelector('.error');
  if (!node) {
    node = document.createElement('div');
    node.className = 'error';
    container.append(node);
  }
  node.textContent = message;
}

function showModal(html) {
  const wrap = document.querySelector('#modalBack');
  wrap.innerHTML = `<div class="modal">${html}</div>`;
  wrap.classList.add('show');
  wrap.onclick = (event) => { if (event.target === wrap) closeModal(); };
}
function closeModal() { document.querySelector('#modalBack')?.classList.remove('show'); }

function configScreen() {
  app.innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark">↗</span>Punto Market</div></header>
    <main class="auth-wrap"><section class="auth-card"><div class="eyebrow">Preparar prueba local</div><h1>Conecta tu proyecto de prueba</h1>
    <p>La web local ya está lista. Para crear cuentas y compartir perfiles entre teléfonos necesitamos la URL y la clave pública de un proyecto Supabase.</p>
    <ol class="hint"><li>Crea un proyecto de prueba en Supabase.</li><li>Copia la URL del proyecto y su clave publishable/anon.</li><li>Pégalas en un archivo <code>.env</code> en esta carpeta.</li><li>Reinicia la web con <code>npm run dev</code>.</li></ol>
    <p>Usaremos una base de datos de desarrollo. No pongas aquí la clave secreta de administración.</p></section></main>`;
}

function authScreen(mode = 'login') {
  const isSignup = mode === 'signup';
  app.innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark">↗</span>Punto Market</div><span class="top-label">PRUEBA LOCAL</span></header>
    <main class="auth-wrap"><section class="auth-card"><div class="auth-logo">Punto Market</div><div class="eyebrow">Intercambio en persona</div>
    <h1>${isSignup ? 'Crea tu perfil' : 'Entra a tu perfil'}</h1><p>${isSignup ? 'Usa tu correo para que solo tú puedas administrar tu perfil y tus objetos.' : 'Inicia sesión para abrir tu perfil.'}</p>
    <form id="authForm">${isSignup ? `<label class="form-label" for="displayName">Tu nombre</label><input class="field" id="displayName" name="displayName" autocomplete="name" required maxlength="40" placeholder="Ej. Ana López">` : ''}
    <label class="form-label" for="email">Correo</label><input class="field" id="email" name="email" type="email" required autocomplete="email" placeholder="tucorreo@ejemplo.com">
    <label class="form-label" for="password">Contraseña</label><input class="field" id="password" name="password" type="password" required minlength="8" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="Mínimo 8 caracteres">
    <button class="button-primary" style="width:100%;margin-top:16px" type="submit">${isSignup ? 'Crear perfil' : 'Iniciar sesión'}</button></form>
    <div id="authError"></div><p class="hint">${isSignup ? '¿Ya tienes perfil?' : '¿Es tu primera vez?'}</p><button class="button-secondary" id="switchAuth" style="width:100%">${isSignup ? 'Iniciar sesión' : 'Crear perfil'}</button></section></main>`;
  document.querySelector('#switchAuth').onclick = () => authScreen(isSignup ? 'login' : 'signup');
  document.querySelector('#authForm').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email')).trim();
    const password = String(form.get('password'));
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Un momento…';
    const result = isSignup
      ? await supabase.auth.signUp({ email, password, options: { data: { display_name: String(form.get('displayName')).trim() } } })
      : await supabase.auth.signInWithPassword({ email, password });
    button.disabled = false;
    button.textContent = isSignup ? 'Crear perfil' : 'Iniciar sesión';
    if (result.error) return showError(document.querySelector('#authError'), result.error);
    if (isSignup && !result.data.session) {
      showError(document.querySelector('#authError'), 'En Supabase, desactiva Confirm Email para que el perfil quede activo sin validar el correo.');
      return;
    }
    session = result.data.session;
    await loadSignedInApp();
  };
}

async function loadProfile() {
  const { data, error } = await supabase.from('profiles').select('id, display_name').eq('id', session.user.id).maybeSingle();
  if (error) throw error;
  profile = data;
  if (!profile) {
    const { data: repairedProfile, error: repairError } = await supabase.rpc('ensure_my_profile');
    if (repairError) throw new Error(`No encontramos tu perfil y no se pudo recuperar automáticamente. Ejecuta la migración 20261115000400_repair_missing_profile.sql en Supabase. Detalle: ${repairError.message}`);
    profile = Array.isArray(repairedProfile) ? repairedProfile[0] : repairedProfile;
  }
  if (!profile) throw new Error('No se pudo recuperar tu perfil. Pulsa “Volver a intentar” después de aplicar la migración de reparación en Supabase.');
}

async function loadAdminStatus() {
  const { data, error } = await supabase.from('admin_users').select('user_id').eq('user_id', profile.id).maybeSingle();
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      isAdmin = false;
      console.warn('Aplica la migración de administración para habilitar el panel.');
      return;
    }
    throw error;
  }
  isAdmin = Boolean(data);
}

function shell() {
  app.innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark">↗</span>Punto Market</div><div class="top-actions"><span class="top-label">PRUEBA LOCAL</span><button class="top-button" id="noticesButton">Avisos <span id="noticeCount"></span></button><button class="avatar" id="accountButton" title="Cuenta y cerrar sesión">${esc(initials(profile.display_name))}</button></div></header>
  <main class="shell main"><section class="hero"><div><div class="eyebrow">Intercambia en persona</div><h1>Las cosas encuentran<br>nuevas manos.</h1><p>Explora los catálogos y propón intercambios por los objetos que te interesen.</p></div><button class="button-primary" id="addProductButton">＋ Agregar producto</button></section>
  <nav class="tabs"><button class="tab active" id="peopleTab">Personas</button><button class="tab" id="myCatalogTab">Mi catálogo</button>${isAdmin ? '<button class="tab" id="adminTab">Admin</button>' : ''}</nav>
  <div class="toolbar"><label class="search"><input id="profileSearch" placeholder="Buscar personas…" autocomplete="off"></label></div>
  <div class="section-head" id="participantsHead"><h2>Participantes</h2><span class="count" id="profileCount"></span></div><section class="people" id="peopleList"></section>
  <div class="section-head" id="catalogHead"><h2 id="catalogTitle">Elige un perfil</h2><span class="count" id="productCount"></span></div><section class="grid" id="productGrid"></section></main>
  <section class="admin-panel shell" id="adminPanel" hidden></section>
  <div class="selection-bar" id="selectionBar"><div><strong id="selectionCount"></strong><span>Objetos que recibirás</span></div><button class="button-primary" id="continueTrade">Continuar →</button></div><div class="modal-back" id="modalBack"></div>`;
  document.querySelector('#peopleTab').onclick = () => { activeView = 'people'; selectedProfile = null; selectedWanted = []; renderSignedIn(); };
  document.querySelector('#myCatalogTab').onclick = () => { activeView = 'mine'; selectedProfile = null; selectedWanted = []; renderSignedIn(); };
  document.querySelector('#adminTab')?.addEventListener('click', () => { activeView = 'admin'; selectedProfile = null; selectedWanted = []; renderSignedIn(); });
  document.querySelector('#profileSearch').oninput = (event) => { searchText = event.target.value.toLowerCase(); renderPeople(); };
  document.querySelector('#addProductButton').onclick = addProductModal;
  document.querySelector('#noticesButton').onclick = openNotices;
  document.querySelector('#accountButton').onclick = () => showModal(`<div class="eyebrow">Tu cuenta</div><h2>${esc(profile.display_name)}</h2><p>${esc(session.user.email || '')}</p><button class="button-secondary" id="logoutButton" style="width:100%">Cerrar sesión</button>`);
  document.querySelector('#modalBack').addEventListener('click', (event) => { if (event.target.id === 'modalBack') closeModal(); });
  renderSignedIn();
}

function renderPeople() {
  const list = document.querySelector('#peopleList');
  const matches = profiles.filter((person) => person.display_name.toLowerCase().includes(searchText));
  document.querySelector('#profileCount').textContent = `${matches.length} perfiles`;
  list.innerHTML = matches.map((person) => `<button class="person ${activeView === 'person' && selectedProfile?.id === person.id ? 'active' : ''}" data-profile="${person.id}"><span class="avatar">${esc(initials(person.display_name))}</span><span class="person-info"><span class="person-name">${esc(person.display_name)}${person.id === profile.id ? ' · Tú' : ''}</span><span class="person-type">${person.id === profile.id ? 'Tu perfil' : 'Participante'}</span></span></button>`).join('') || '<div class="hint">No encontramos perfiles.</div>';
  list.querySelectorAll('[data-profile]').forEach((button) => button.onclick = () => openProfile(button.dataset.profile));
}

async function renderSignedIn() {
  if (activeView === 'admin' && !isAdmin) activeView = 'people';
  const adminMode = activeView === 'admin';
  document.querySelector('.main').classList.toggle('admin-mode', adminMode);
  document.querySelector('#adminPanel').hidden = !adminMode;
  clearInterval(adminRefreshTimer);
  adminRefreshTimer = null;
  const mine = activeView === 'mine';
  document.querySelector('#peopleTab').classList.toggle('active', activeView === 'people' || activeView === 'person');
  document.querySelector('#myCatalogTab').classList.toggle('active', mine);
  document.querySelector('#adminTab')?.classList.toggle('active', adminMode);
  document.querySelector('#selectionBar').classList.remove('show');
  renderPeople();
  if (adminMode) {
    await renderAdminPanel();
    adminRefreshTimer = setInterval(() => { if (activeView === 'admin') renderAdminPanel(); }, 5000);
    return;
  }
  const title = document.querySelector('#catalogTitle');
  const count = document.querySelector('#productCount');
  const grid = document.querySelector('#productGrid');
  if (mine) {
    title.textContent = 'Mi catálogo';
    await loadProducts(profile.id, true);
    return;
  }
  if (!selectedProfile) {
    title.textContent = 'Elige un perfil';
    count.textContent = '';
    grid.innerHTML = !eventProfilesOpen && !isAdmin
      ? '<div class="empty">Los perfiles y catálogos estarán disponibles cuando el admin abra el evento. Mientras tanto, puedes preparar el tuyo desde “Mi catálogo”.</div>'
      : '<div class="empty">Abre un perfil para ver su catálogo. Si te interesa un objeto, selecciónalo para proponer un intercambio.</div>';
    return;
  }
  if (selectedProfile.id === profile.id) {
    title.textContent = 'Mi catálogo';
    await loadProducts(profile.id, true);
    return;
  }
  title.textContent = `Catálogo de ${selectedProfile.display_name}`;
  if (!eventProfilesOpen && !isAdmin) {
    count.textContent = '';
    grid.innerHTML = '<div class="empty">Los catálogos estarán disponibles cuando el admin abra el evento.</div>';
    return;
  }
  await loadProducts(selectedProfile.id, false);
}

async function renderAdminPanel() {
  const panel = document.querySelector('#adminPanel');
  if (!panel || !isAdmin) return;
  panel.innerHTML = '<section class="auth-card"><p class="hint">Actualizando intercambios…</p></section>';
  const [{ data, error }, { data: openState, error: stateError }, { data: productRows, error: productsError }] = await Promise.all([
    supabase.rpc('get_admin_exchange_stats'),
    supabase.rpc('get_event_status'),
    supabase.from('products').select('owner_id, name').order('created_at', { ascending: false })
  ]);
  if (stateError || productsError) {
    const problem = stateError || productsError;
    panel.innerHTML = `<section class="auth-card"><h2>No se pudo cargar el panel</h2><p class="error">${esc(problem.message)}</p><button class="button-secondary" id="refreshAdminPanel">Reintentar</button></section>`;
    panel.querySelector('#refreshAdminPanel').onclick = renderAdminPanel;
    return;
  }
  eventProfilesOpen = Boolean(openState);
  if (error) {
    panel.innerHTML = `<section class="auth-card"><h2>No se pudo cargar el panel</h2><p class="error">${esc(error.message)}</p><button class="button-secondary" id="refreshAdminPanel">Reintentar</button></section>`;
    panel.querySelector('#refreshAdminPanel').onclick = renderAdminPanel;
    return;
  }
  const rows = data || [];
  const totalByProfile = rows.reduce((sum, row) => sum + Number(row.completed_exchanges || 0), 0);
  const totalExchanges = Math.floor(totalByProfile / 2);
  const itemCounts = new Map();
  for (const item of productRows || []) itemCounts.set(item.owner_id, (itemCounts.get(item.owner_id) || 0) + 1);
  panel.innerHTML = `<div class="admin-heading"><div><div class="eyebrow">Administración</div><h1>Control del evento</h1><p>${eventProfilesOpen ? 'Los perfiles están abiertos para todos.' : 'Los participantes pueden preparar sus catálogos; solo tú puedes revisar perfiles y objetos.'}</p></div><button class="button-primary" id="toggleProfilesButton">${eventProfilesOpen ? 'Cerrar perfiles para todos' : 'Abrir perfiles para todos'}</button></div><div class="admin-summary"><article><span>Total de intercambios</span><strong>${totalExchanges}</strong></article><article><span>Participantes</span><strong>${rows.length}</strong></article></div><h2>Perfiles y objetos</h2><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Participante</th><th>Objetos en su catálogo</th><th>Revisión</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.display_name)}</td><td>${itemCounts.get(row.profile_id) || 0}</td><td><button class="button-secondary" data-admin-profile="${row.profile_id}">Ver catálogo</button></td></tr>`).join('') || '<tr><td colspan="3">Aún no hay perfiles.</td></tr>'}</tbody></table></div><h2 style="margin-top:24px">Intercambios realizados</h2><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Participante</th><th>Intercambios realizados</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.display_name)}</td><td><b>${Number(row.completed_exchanges || 0)}</b></td></tr>`).join('') || '<tr><td colspan="2">Aún no hay perfiles.</td></tr>'}</tbody></table></div><div style="margin-top:14px"><button class="button-secondary" id="refreshAdminPanel">↻ Actualizar</button></div>`;
  panel.querySelector('#refreshAdminPanel').onclick = renderAdminPanel;
  panel.querySelector('#toggleProfilesButton').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const { data: nextState, error: toggleError } = await supabase.rpc('set_event_profiles_open', { p_open: !eventProfilesOpen });
    if (toggleError) {
      button.disabled = false;
      return toast(toggleError.message);
    }
    eventProfilesOpen = Boolean(nextState);
    const { data: updatedProfiles } = await supabase.from('profiles').select('id, display_name').order('display_name');
    if (updatedProfiles) profiles = updatedProfiles;
    toast(eventProfilesOpen ? 'Perfiles abiertos para todos.' : 'Perfiles cerrados para los participantes.');
    await renderAdminPanel();
  };
  panel.querySelectorAll('[data-admin-profile]').forEach((button) => button.onclick = () => openProfile(button.dataset.adminProfile));
}

function showGridError(error) { document.querySelector('#productGrid').innerHTML = `<div class="error">${esc(error?.message || error)}</div>`; }

async function loadProducts(ownerId, own) {
  const { data, error } = await supabase.from('products').select('id, owner_id, name, image_path, created_at').eq('owner_id', ownerId).order('created_at', { ascending: false });
  if (error) return showGridError(error);
  visibleProducts = data || [];
  document.querySelector('#productCount').textContent = `${visibleProducts.length} ${visibleProducts.length === 1 ? 'objeto' : 'objetos'}`;
  const otherCatalog = !own && activeView === 'person' && !isAdmin;
  const grid = document.querySelector('#productGrid');
  if (!visibleProducts.length) {
    grid.innerHTML = '<div class="empty">Este catálogo todavía no tiene objetos.</div>';
    return;
  }
  grid.innerHTML = visibleProducts.map((item) => `<article class="product"><div class="product-photo" data-image="${item.id}"><div class="product-emoji">📦</div><span class="available">● Disponible</span></div><div class="product-body"><div class="product-title">${esc(item.name)}</div><div class="product-owner">${own ? 'En tu catálogo' : `De ${esc(selectedProfile.display_name)}`}</div><div class="product-actions">${otherCatalog ? `<button class="pick ${selectedWanted.includes(item.id) ? 'selected' : ''}" data-want="${item.id}">${selectedWanted.includes(item.id) ? '✓ Elegido' : '+ Elegir'}</button>` : '<span class="person-type">Disponible</span>'}</div></div></article>`).join('');
  let imagePermissionError = '';
  let imageLoadErrorShown = false;
  await Promise.all(visibleProducts.filter((product) => product.image_path).map(async (item) => {
    const { data: image, error: imageError } = await supabase.storage.from('product-images').createSignedUrl(item.image_path, 60);
    const photo = document.querySelector(`[data-image="${CSS.escape(item.id)}"]`);
    if (imageError) { imagePermissionError = imageError.message || 'Permiso denegado'; return; }
    if (image?.signedUrl && photo) {
      photo.innerHTML = `<img src="${esc(image.signedUrl)}" alt="${esc(item.name)}"><span class="available">● Disponible</span>`;
      photo.querySelector('img').onerror = () => {
        photo.innerHTML = `<div class="product-emoji">📦</div><span class="available">Foto no disponible</span>`;
        if (!imageLoadErrorShown) {
          imageLoadErrorShown = true;
          toast('No se pudo cargar una foto. Revisa el acceso a las imágenes en Supabase.');
        }
      };
    }
  }));
  if (imagePermissionError?.toLowerCase().includes('object not found')) {
    toast('No se encontró la foto en Storage. Si el objeto llegó por intercambio, aplica la migración 20261115000700 en Supabase; si continúa, habrá que volver a subir la foto.');
  } else if (imagePermissionError) {
    toast(`No se pudo abrir una foto: ${imagePermissionError}. Revisa los permisos de Storage en Supabase.`);
  }
  if (otherCatalog) {
    grid.querySelectorAll('[data-want]').forEach((button) => button.onclick = () => {
      selectedWanted = selectedWanted.includes(button.dataset.want) ? selectedWanted.filter((id) => id !== button.dataset.want) : [...selectedWanted, button.dataset.want];
      renderSignedIn();
    });
    const bar = document.querySelector('#selectionBar');
    bar.classList.toggle('show', selectedWanted.length > 0);
    document.querySelector('#selectionCount').textContent = `${selectedWanted.length} ${selectedWanted.length === 1 ? 'objeto elegido' : 'objetos elegidos'}`;
    document.querySelector('#continueTrade').onclick = buildTrade;
  }
}

async function openProfile(id) {
  if (!eventProfilesOpen && !isAdmin && id !== profile.id) return toast('Los perfiles todavía están cerrados por el admin.');
  selectedProfile = profiles.find((person) => person.id === id);
  activeView = 'person';
  selectedWanted = [];
  await renderSignedIn();
}

async function addProductModal() {
  const { data: uploadedCount, error: countError } = await supabase.rpc('get_my_uploaded_product_count');
  if (countError) return toast(countError.message);
  if (uploadedCount >= 5) return toast('Ya alcanzaste el límite de 5 objetos subidos. Los objetos que recibas por intercambio no cuentan.');

  showModal(`<div class="modal-head"><div><div class="eyebrow">Mi catálogo</div><h2>Agregar producto</h2></div><button class="close" data-close aria-label="Cerrar">×</button></div><p>Escribe el nombre y toma una foto o elige una de tu galería.</p><label class="form-label" for="newProductName">Nombre</label><input class="field" id="newProductName" maxlength="80" placeholder="Ej. Taza de cerámica"><label class="form-label">Foto del objeto</label><div class="photo-actions"><button class="button-secondary" type="button" id="takePhotoButton">📷 Tomar foto</button><button class="button-secondary" type="button" id="choosePhotoButton">▧ Elegir de galería</button></div><input id="cameraPhotoInput" type="file" accept="image/*" capture="environment" hidden><input id="galleryPhotoInput" type="file" accept="image/*" hidden><div class="photo-preview" id="photoPreview">No has agregado una foto</div><div class="upload-status" id="uploadStatus" aria-live="polite"></div><div class="form-actions"><button class="button-primary" id="saveProductButton">Agregar a mi catálogo</button></div>`);
  document.querySelector('[data-close]').onclick = closeModal;
  let selectedPhoto = null;
  let previewUrl = null;
  const cameraInput = document.querySelector('#cameraPhotoInput');
  const galleryInput = document.querySelector('#galleryPhotoInput');
  document.querySelector('#takePhotoButton').onclick = () => cameraInput.click();
  document.querySelector('#choosePhotoButton').onclick = () => galleryInput.click();
  for (const input of [cameraInput, galleryInput]) input.onchange = () => {
    selectedPhoto = input.files?.[0] || selectedPhoto;
    input.value = '';
    if (!selectedPhoto) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(selectedPhoto);
    document.querySelector('#photoPreview').innerHTML = `<img src="${previewUrl}" alt="Vista previa de ${esc(selectedPhoto.name)}">`;
    document.querySelector('#uploadStatus').textContent = `${esc(selectedPhoto.name)} · ${Math.max(1, Math.round(selectedPhoto.size / 1024))} KB`;
  };
  document.querySelector('#saveProductButton').onclick = async () => {
    const button = document.querySelector('#saveProductButton');
    const name = document.querySelector('#newProductName').value.trim();
    if (!name) return toast('Escribe el nombre del objeto.');
    button.disabled = true;
    const originalLabel = button.textContent;
    const status = document.querySelector('#uploadStatus');
    let imagePath = null;
    try {
      if (selectedPhoto) {
        button.textContent = 'Preparando foto…';
        status.textContent = 'Preparando la foto…';
        const photo = await compressPhoto(selectedPhoto);
        imagePath = `${profile.id}/${createPhotoId()}.jpg`;
        button.textContent = 'Subiendo foto…';
        status.textContent = 'Subiendo la foto…';
        const upload = await supabase.storage.from('product-images').upload(imagePath, photo, { upsert: false, contentType: 'image/jpeg', cacheControl: '3600' });
        if (upload.error) throw upload.error;
      }
      button.textContent = 'Guardando…';
      status.textContent = 'Guardando el producto…';
      const { error } = await supabase.from('products').insert({ owner_id: profile.id, name, image_path: imagePath });
      if (error) throw error;
      activeView = 'mine';
      closeModal();
      await renderSignedIn();
      toast('Producto agregado a tu catálogo.');
    } catch (error) {
      if (imagePath) await supabase.storage.from('product-images').remove([imagePath]).catch(() => {});
      button.disabled = false;
      button.textContent = originalLabel;
      status.textContent = '';
      showError(document.querySelector('.modal'), error);
    }
  };
}

function createPhotoId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(4);
    globalThis.crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function compressPhoto(file) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();
    const limit = 1280;
    const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('No se pudo preparar la foto en este teléfono. Intenta elegir otra imagen.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
    if (!blob) throw new Error('No se pudo convertir la foto. Intenta con otra imagen.');
    return new File([blob], 'producto.jpg', { type: 'image/jpeg', lastModified: Date.now() });
  } catch (error) {
    if (error?.name === 'EncodingError' || error?.name === 'NotSupportedError') {
      throw new Error('El teléfono no pudo leer esta foto. Tómala con la cámara o elige una imagen JPG, PNG o WebP.');
    }
    throw error;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function buildTrade() {
  const targetItems = visibleProducts.filter((item) => selectedWanted.includes(item.id));
  if (!targetItems.length) return toast('Elige al menos un objeto primero.');
  const { data: ownItems, error } = await supabase.from('products').select('id, name, image_path').eq('owner_id', profile.id).order('created_at', { ascending: false });
  if (error) return toast(error.message);
  if (!ownItems?.length) return toast('Agrega primero un objeto a tu catálogo.');
  selectedOffered = [];
  showModal(`<div class="modal-head"><div><div class="eyebrow">Paso 2 · Propuesta</div><h2>Completa el intercambio</h2></div><button class="close" data-close aria-label="Cerrar">×</button></div><div class="exchange-summary"><div class="summary-label">Tú recibirías de ${esc(selectedProfile.display_name)}</div><div class="summary-items">${targetItems.map((item) => esc(item.name)).join(' · ')}</div></div><p><b>Ahora elige qué entregarás.</b> Puedes marcar uno o varios objetos tuyos.</p><div id="offerChoices">${ownItems.map((item) => `<div class="choice" data-offer="${item.id}"><span><b>${esc(item.name)}</b></span><span class="choice-check"></span></div>`).join('')}</div><div class="exchange-summary"><div class="summary-label">Tú entregarás</div><div class="summary-items" id="offeredSummary">Elige uno o varios objetos</div></div><button class="button-primary" id="sendProposal" disabled style="width:100%;margin-top:8px">Enviar propuesta</button>`);
  document.querySelector('[data-close]').onclick = closeModal;
  document.querySelectorAll('[data-offer]').forEach((row) => row.onclick = () => {
    const id = row.dataset.offer;
    selectedOffered = selectedOffered.includes(id) ? selectedOffered.filter((value) => value !== id) : [...selectedOffered, id];
    row.classList.toggle('selected', selectedOffered.includes(id));
    document.querySelector('#offeredSummary').textContent = selectedOffered.map((value) => ownItems.find((item) => item.id === value)?.name).filter(Boolean).join(' · ') || 'Elige uno o varios objetos';
    const submit = document.querySelector('#sendProposal');
    submit.disabled = !selectedOffered.length;
    submit.textContent = selectedOffered.length ? `Enviar propuesta · ${selectedOffered.length} objeto${selectedOffered.length === 1 ? '' : 's'}` : 'Enviar propuesta';
  });
  document.querySelector('#sendProposal').onclick = async () => {
    const submit = document.querySelector('#sendProposal');
    submit.disabled = true;
    const { error: proposalError } = await supabase.rpc('create_exchange_proposal', { p_recipient_id: selectedProfile.id, p_offered_ids: selectedOffered, p_wanted_ids: targetItems.map((item) => item.id) });
    if (proposalError) { submit.disabled = false; return showError(document.querySelector('.modal'), proposalError); }
    selectedWanted = [];
    closeModal();
    toast('Propuesta enviada. La otra persona la verá en Avisos.');
    await renderSignedIn();
  };
}

async function productsWithSignedImages(products) {
  const entries = await Promise.all(products.map(async (product) => {
    if (!product.image_path) return [product.id, { name: product.name, imageUrl: null }];
    const { data, error } = await supabase.storage.from('product-images').createSignedUrl(product.image_path, 60);
    return [product.id, { name: product.name, imageUrl: error ? null : data?.signedUrl || null }];
  }));
  return new Map(entries);
}

function renderProposalProduct(product) {
  const image = product.imageUrl ? `<img src="${esc(product.imageUrl)}" alt="">` : '<span class="proposal-product-placeholder">📦</span>';
  return `<span class="proposal-product">${image}<b>${esc(product.name)}</b></span>`;
}

function renderProductThumbs(products) {
  return `<span class="proposal-thumbs">${products.slice(0, 3).map((product) => product.imageUrl ? `<img src="${esc(product.imageUrl)}" alt="${esc(product.name)}">` : '<span class="proposal-thumb-placeholder">📦</span>').join('')}${products.length > 3 ? `<span class="proposal-more">+${products.length - 3}</span>` : ''}</span>`;
}

async function openNotices() {
  const proposalsResult = await supabase.from('exchange_proposals').select('id, proposer_id, created_at').eq('recipient_id', profile.id).eq('status', 'pending').order('created_at', { ascending: false });
  if (proposalsResult.error) return toast(proposalsResult.error.message);
  const proposals = proposalsResult.data || [];
  const ids = [...new Set(proposals.map((item) => item.proposer_id))];
  const people = profiles.filter((item) => ids.includes(item.id));
  const proposerItems = proposals.length ? await supabase.from('exchange_proposal_items').select('proposal_id, product_id, side').in('proposal_id', proposals.map((item) => item.id)) : { data: [] };
  if (proposerItems.error) return toast(proposerItems.error.message);
  const productIds = (proposerItems.data || []).map((item) => item.product_id);
  const productsResult = productIds.length ? await supabase.from('products').select('id, name, image_path').in('id', productIds) : { data: [] };
  if (productsResult.error) return toast(productsResult.error.message);
  const productMap = await productsWithSignedImages(productsResult.data || []);
  showModal(`<div class="modal-head"><div><div class="eyebrow">Avisos</div><h2>Propuestas de intercambio</h2></div><button class="close" data-close aria-label="Cerrar">×</button></div><p>Revisa y responde a las propuestas que te hicieron.</p>
    ${proposals.map((proposal) => { const person = people.find((item) => item.id === proposal.proposer_id); const items = (proposerItems.data || []).filter((item) => item.proposal_id === proposal.id); const offered = items.filter((item) => item.side === 'offered').map((item) => productMap.get(item.product_id)).filter(Boolean); const wanted = items.filter((item) => item.side === 'wanted').map((item) => productMap.get(item.product_id)).filter(Boolean); return `<button class="choice proposal-choice" data-open-proposal="${proposal.id}"><span class="proposal-person"><b>${esc(person?.display_name || 'Participante')}</b><small>Propuesta de intercambio</small></span><span class="proposal-preview">${renderProductThumbs(offered)}<span class="proposal-arrow">⇄</span>${renderProductThumbs(wanted)}</span></button>`; }).join('')}
    ${!proposals.length ? '<div class="empty">No tienes propuestas pendientes.</div>' : ''}`);
  document.querySelector('[data-close]').onclick = closeModal;
  document.querySelectorAll('[data-open-proposal]').forEach((button) => button.onclick = () => openProposal(button.dataset.openProposal));
}

async function openProposal(proposalId) {
  const [proposalResult, itemsResult] = await Promise.all([
    supabase.from('exchange_proposals').select('id, proposer_id, recipient_id').eq('id', proposalId).single(),
    supabase.from('exchange_proposal_items').select('product_id, side').eq('proposal_id', proposalId),
  ]);
  if (proposalResult.error || itemsResult.error) return toast((proposalResult.error || itemsResult.error).message);
  const proposal = proposalResult.data;
  const productIds = itemsResult.data.map((item) => item.product_id);
  const { data: rawItems, error } = await supabase.from('products').select('id, name, image_path').in('id', productIds);
  if (error) return toast(error.message);
  const items = await productsWithSignedImages(rawItems || []);
  const getProduct = (item) => items.get(item.product_id) || { name: 'Objeto', imageUrl: null };
  const offered = itemsResult.data.filter((item) => item.side === 'offered');
  const wanted = itemsResult.data.filter((item) => item.side === 'wanted');
  showModal(`<div class="modal-head"><div><div class="eyebrow">Propuesta de intercambio</div><h2>Revisa el cambio</h2></div><button class="close" data-close aria-label="Cerrar">×</button></div><div class="exchange-summary"><div class="summary-label">Te ofrecen</div><div class="proposal-products">${offered.map((item) => renderProposalProduct(getProduct(item))).join('')}</div></div><div class="exchange-summary"><div class="summary-label">A cambio de</div><div class="proposal-products">${wanted.map((item) => renderProposalProduct(getProduct(item))).join('')}</div></div><div class="form-actions"><button class="button-primary" id="acceptExchange">Aceptar intercambio</button><button class="button-secondary" id="declineExchange">Cancelar</button></div>`);
  document.querySelector('[data-close]').onclick = closeModal;
  document.querySelector('#acceptExchange').onclick = () => answerProposal(proposal.id, true);
  document.querySelector('#declineExchange').onclick = () => answerProposal(proposal.id, false);
}

async function answerProposal(proposalId, accept) {
  const { error } = await supabase.rpc('respond_exchange_proposal', { p_proposal_id: proposalId, p_accept: accept });
  if (error) return showError(document.querySelector('.modal'), error);
  closeModal();
  toast(accept ? 'Intercambio confirmado. Los catálogos siguen disponibles mientras el evento esté abierto.' : 'Propuesta cancelada.');
  await renderSignedIn();
}

async function logout() { stopNoticeUpdates(); closeModal(); await supabase.auth.signOut(); session = null; profile = null; authScreen(); }

async function refreshNoticeCount(announce = false) {
  if (!profile) return;
  const { count, error } = await supabase.from('exchange_proposals').select('id', { count: 'exact', head: true }).eq('recipient_id', profile.id).eq('status', 'pending');
  if (error) return;
  const total = count || 0;
  const badge = document.querySelector('#noticeCount');
  if (badge) badge.textContent = total ? ` · ${total}` : '';
  if (announce && lastNoticeCount !== null && total > lastNoticeCount) {
    toast('Tienes una nueva propuesta de intercambio. Revisa Avisos.');
    if (navigator.vibrate) navigator.vibrate(120);
  }
  lastNoticeCount = total;
}

function stopNoticeUpdates() {
  clearInterval(noticePollTimer);
  clearInterval(liveDataPollTimer);
  clearInterval(adminRefreshTimer);
  noticePollTimer = null;
  liveDataPollTimer = null;
  adminRefreshTimer = null;
  if (noticeChannel) supabase.removeChannel(noticeChannel);
  noticeChannel = null;
  lastNoticeCount = null;
}

async function refreshLiveData() {
  if (!profile || liveDataSyncBusy) return;
  liveDataSyncBusy = true;
  try {
    const { data: openState, error: statusError } = await supabase.rpc('get_event_status');
    if (!statusError && eventProfilesOpen !== Boolean(openState)) {
      eventProfilesOpen = Boolean(openState);
      if (!eventProfilesOpen && !isAdmin && selectedProfile?.id !== profile.id) {
        selectedProfile = null;
        activeView = 'people';
        selectedWanted = [];
      }
      const { data: refreshedProfiles } = await supabase.from('profiles').select('id, display_name').order('display_name');
      if (refreshedProfiles) profiles = refreshedProfiles;
      if (activeView !== 'admin') await renderSignedIn();
    }
    const { data, error } = await supabase.from('profiles').select('id, display_name').order('display_name');
    if (!error && data) {
      const oldProfiles = profiles.map((person) => `${person.id}:${person.display_name}`).join('|');
      const newProfiles = data.map((person) => `${person.id}:${person.display_name}`).join('|');
      if (oldProfiles !== newProfiles) {
        profiles = data;
        renderPeople();
      }
    }

  } catch (error) {
    console.warn('No se pudo actualizar la lista en vivo.', error);
  } finally {
    liveDataSyncBusy = false;
  }
}

async function startNoticeUpdates() {
  stopNoticeUpdates();
  await refreshNoticeCount(false);
  noticeChannel = supabase.channel(`notices-${profile.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'exchange_proposals', filter: `recipient_id=eq.${profile.id}` }, () => {
      toast('Nueva propuesta de intercambio. Revisa Avisos.');
      if (navigator.vibrate) navigator.vibrate(120);
      refreshNoticeCount(false);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'profiles' }, () => refreshLiveData())
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'event_settings', filter: 'singleton=eq.true' }, async (payload) => {
      const nextState = Boolean(payload.new?.profiles_open);
      if (eventProfilesOpen === nextState) return;
      eventProfilesOpen = nextState;
      if (!eventProfilesOpen && !isAdmin && selectedProfile?.id !== profile.id) {
        selectedProfile = null;
        activeView = 'people';
        selectedWanted = [];
      }
      const { data } = await supabase.from('profiles').select('id, display_name').order('display_name');
      if (data) profiles = data;
      if (activeView === 'admin') await renderAdminPanel();
      else await renderSignedIn();
    })
    .subscribe((status) => { if (status === 'SUBSCRIBED') refreshLiveData(); });
  noticePollTimer = setInterval(() => refreshNoticeCount(true), 6000);
  liveDataPollTimer = setInterval(refreshLiveData, 4000);
}

async function loadSignedInApp() {
  try {
    await loadProfile();
    await loadAdminStatus();
    const { data: openState, error: statusError } = await supabase.rpc('get_event_status');
    if (statusError) throw statusError;
    eventProfilesOpen = Boolean(openState);
    shell();
    document.querySelector('#logoutButton')?.addEventListener('click', logout);
    const { data, error } = await supabase.from('profiles').select('id, display_name').order('display_name');
    if (error) throw error;
    profiles = data || [];
    renderSignedIn();
    await startNoticeUpdates();
  } catch (error) {
    app.innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark">↗</span>Punto Market</div></header><main class="auth-wrap"><section class="auth-card"><h1>No se pudo abrir tu perfil</h1><p class="error">${esc(error.message)}</p><button class="button-secondary" id="tryAgain">Volver a intentar</button></section></main>`;
    document.querySelector('#tryAgain').onclick = loadSignedInApp;
  }
}

async function init() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshNoticeCount(false);
  });
  if (!isSupabaseConfigured) return configScreen();
  const { data, error } = await supabase.auth.getSession();
  if (error) return authScreen();
  session = data.session;
  if (!session) return authScreen();
  await loadSignedInApp();
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    if (!nextSession) { stopNoticeUpdates(); session = null; profile = null; authScreen(); }
  });
  document.addEventListener('click', (event) => { if (event.target?.id === 'logoutButton') logout(); });
}

init();
