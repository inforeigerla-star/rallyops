// ====================================================
// RALLYOPS - app.js
// V3: jerarquía Competencia > Tipo de sesión > Pasada > Módulos
// (Neumáticos, Setup, Tramos). Cada dato queda asociado
// únicamente a la Pasada donde fue cargado.
// ====================================================

// Nombres de las "cajas" donde vamos a guardar cada tipo
// de dato dentro de localStorage.
const STORAGE_KEYS = {
  competencias: 'rallyops_competencias',
  neumaticos: 'rallyops_neumaticos',
  setups: 'rallyops_setups',
  tramos: 'rallyops_tramos'
};

// Tipos de sesión fijos dentro de cada competencia.
const SESIONES = ['Test', 'Shakedown', 'Race'];

// Estado de navegación actual: en qué competencia, sesión,
// pasada y módulo está parado el usuario. No se guarda en
// localStorage a propósito: cada vez que se abre la app,
// arranca de nuevo en "Mis Competencias".
const navState = {
  competenciaId: null,
  sesion: null,
  pasada: null,
  modulo: 'setup',
  vista: 'resumen' // 'resumen' o 'pasadas', dentro de una competencia
};

// ====================================================
// FIREBASE (opcional): si firebase-config.js tiene una configuración
// real (no el placeholder "PEGAR_AQUI"), la app se conecta a Firebase
// Auth + Firestore y sincroniza los datos entre dispositivos, atrás
// de un login. Si no está configurado, sigue funcionando 100% local
// en este navegador, exactamente como antes.
// ====================================================
const FIREBASE_HABILITADO = typeof firebaseConfig !== 'undefined'
  && !!firebaseConfig.apiKey
  && !String(firebaseConfig.apiKey).includes('PEGAR_AQUI')
  && typeof firebase !== 'undefined';

let auth = null;
let db = null;
let FIREBASE_LISTO = false;

if (FIREBASE_HABILITADO) {
  try {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();
    FIREBASE_LISTO = true;
  } catch (e) {
    console.error('No se pudo inicializar Firebase:', e);
  }
}

// Usuario logueado actualmente (null si no hay sesión o si la app
// funciona en modo 100% local).
let currentUser = null;

// Espejo en memoria de los datos de Firestore, para que getList()
// pueda seguir siendo síncrona (no hay que tocar el resto de la app).
let cloudCache = { competencias: [], neumaticos: [], setups: [], tramos: [] };

// Funciones para cancelar la suscripción a cada colección al cerrar
// sesión (si no, seguirían escuchando cambios de un usuario anterior).
let firestoreListeners = [];

// Si es la primera vez que se abre la app en este navegador (modo
// local, sin Firebase), crea las listas vacías. Si ya existían, no
// las toca. En modo Firebase no hace falta: lo que no existe en
// Firestore se trata como lista vacía.
function initStorage() {
  if (FIREBASE_LISTO) return;
  Object.values(STORAGE_KEYS).forEach(key => {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify([]));
    }
  });
}

// Lee una lista. En modo Firebase, del espejo en memoria (que se
// mantiene al día solo via onSnapshot); si no, de localStorage.
function getList(key) {
  if (FIREBASE_LISTO) return cloudCache[key] || [];
  try {
    const data = JSON.parse(localStorage.getItem(key));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// Guarda una lista completa. En modo Firebase, actualiza el espejo al
// toque (para que la pantalla responda instantáneo) y manda el cambio
// a Firestore en segundo plano; si no, a localStorage.
function saveList(key, list) {
  if (FIREBASE_LISTO) {
    cloudCache[key] = list;
    if (currentUser && db) {
      db.collection('usuarios').doc(currentUser.uid).collection('datos').doc(key)
        .set({ lista: list })
        .catch(err => console.error('Error guardando en la nube:', err));
    }
    return;
  }
  localStorage.setItem(key, JSON.stringify(list));
}

// Arranca la sincronización en tiempo real con Firestore para el
// usuario logueado: cada colección se escucha con onSnapshot, así
// que si el mismo usuario carga datos desde otro dispositivo, esta
// pantalla se actualiza sola.
function iniciarSincronizacion(uid) {
  detenerSincronizacion();
  Object.values(STORAGE_KEYS).forEach(key => {
    const unsub = db.collection('usuarios').doc(uid).collection('datos').doc(key)
      .onSnapshot(doc => {
        const datos = doc.exists ? doc.data() : null;
        cloudCache[key] = (datos && Array.isArray(datos.lista)) ? datos.lista : [];
        refrescarPantallaActual();
      }, err => {
        console.error('Error de sincronización (' + key + '):', err);
      });
    firestoreListeners.push(unsub);
  });
}

function detenerSincronizacion() {
  firestoreListeners.forEach(unsub => unsub());
  firestoreListeners = [];
}

// Vuelve a dibujar lo que esté en pantalla ahora mismo, sin cambiar
// de pantalla ni perder la navegación. La usa la sincronización en
// tiempo real cuando llegan cambios desde otro dispositivo.
function refrescarPantallaActual() {
  const activa = document.querySelector('.screen.active');
  if (!activa) return;
  if (activa.id === 'screen-competencias') {
    renderCompetencias();
  } else if (activa.id === 'screen-competencia') {
    renderCompetenciaDetail();
  } else if (activa.id === 'screen-pasada') {
    renderBaseNeumaticos();
    renderBaseSetups();
    showModulo(navState.modulo);
  }
}

// Convierte texto ingresado por el usuario a HTML seguro.
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Convierte una fecha "yyyy-mm-dd" (la que da el input de tipo
// fecha) a un texto legible, ej: "14 jul 2026".
function formatFecha(fechaStr) {
  if (!fechaStr) return 'Sin fecha';
  const [y, m, d] = fechaStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Arma la "clave" que identifica de forma única a una pasada
// dentro de una competencia y sesión. Todo lo que se cargue en
// Neumáticos/Setup/Tramos se etiqueta con esta clave.
function pasadaKey(competenciaId, sesion, pasada) {
  return competenciaId + '::' + sesion + '::' + pasada;
}

function currentPasadaKey() {
  return pasadaKey(navState.competenciaId, navState.sesion, navState.pasada);
}

// "Pasada" especial que guarda el neumático y el setup BASE de una
// sesión: lo que se repite en todas sus pasadas salvo que se cargue
// algo distinto puntualmente en alguna.
const BASE_PASADA = 'base';

function baseKey(competenciaId, sesion) {
  return pasadaKey(competenciaId, sesion, BASE_PASADA);
}

function currentBaseKey() {
  return baseKey(navState.competenciaId, navState.sesion);
}

// Busca qué datos "heredaría" una pasada si no cargó nada propio:
// primero mira la pasada inmediatamente anterior (con datos propios),
// y si esa tampoco tiene, sigue para atrás hasta la Pasada 1. Si
// ninguna pasada anterior tiene nada propio, devuelve la base de la
// sesión. Así el setup/neumático "va arrastrándose" pasada a pasada
// en vez de reiniciar siempre desde la base.
function efectivoAnteriorPara(storageKey, competenciaId, sesion, hasta) {
  for (let n = hasta - 1; n >= 1; n--) {
    const key = pasadaKey(competenciaId, sesion, n);
    const list = getList(storageKey).filter(x => x.pasadaKey === key);
    if (list.length > 0) return { list, origen: 'Pasada ' + n };
  }
  const list = getList(storageKey).filter(x => x.pasadaKey === baseKey(competenciaId, sesion));
  return { list, origen: 'la base de la sesión' };
}

function currentEfectivoAnterior(storageKey, hasta) {
  return efectivoAnteriorPara(storageKey, navState.competenciaId, navState.sesion, hasta);
}

// ¿Esta pasada (dentro de la competencia/sesión actual) tiene
// algún dato cargado en cualquiera de los 3 módulos?
function pasadaHasData(n) {
  const key = pasadaKey(navState.competenciaId, navState.sesion, n);
  return getList(STORAGE_KEYS.neumaticos).some(x => x.pasadaKey === key) ||
         getList(STORAGE_KEYS.setups).some(x => x.pasadaKey === key) ||
         getList(STORAGE_KEYS.tramos).some(x => x.pasadaKey === key);
}

// --------------------------------------------------
// NAVEGACIÓN ENTRE PANTALLAS (Competencias / Competencia / Pasada)
// --------------------------------------------------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const container = document.getElementById('screen-container');
  if (container) container.scrollTop = 0;
  updateHeader();
}

// Actualiza el título, subtítulo y la flecha de "volver" del
// header según en qué pantalla estemos parados.
function updateHeader() {
  const backBtn = document.getElementById('btn-back');
  const title = document.getElementById('header-title');
  const subtitle = document.getElementById('header-subtitle');
  const activeScreen = document.querySelector('.screen.active').id;

  const acciones = document.getElementById('header-acciones');
  if (acciones) acciones.classList.toggle('hidden', activeScreen === 'screen-auth');

  if (activeScreen === 'screen-auth') {
    backBtn.classList.add('hidden');
    title.innerHTML = 'RALLY<span class="text-[#ff5722]">OPS</span>';
    subtitle.textContent = 'Iniciá sesión';
  } else if (activeScreen === 'screen-competencias') {
    backBtn.classList.add('hidden');
    title.innerHTML = 'RALLY<span class="text-[#ff5722]">OPS</span>';
    subtitle.textContent = 'Mis Competencias';
  } else if (activeScreen === 'screen-competencia') {
    backBtn.classList.remove('hidden');
    const comp = getList(STORAGE_KEYS.competencias).find(c => c.id === navState.competenciaId);
    title.textContent = comp ? comp.nombre : 'Competencia';
    subtitle.textContent = navState.sesion ? 'Sesión: ' + navState.sesion : 'Elegí una sesión';
  } else if (activeScreen === 'screen-pasada') {
    backBtn.classList.remove('hidden');
    const comp = getList(STORAGE_KEYS.competencias).find(c => c.id === navState.competenciaId);
    title.textContent = 'Pasada ' + navState.pasada;
    subtitle.textContent = (comp ? comp.nombre : '') + ' · ' + navState.sesion;
  }
}

// Botón de "volver" del header: sube un nivel en la jerarquía.
function goBack() {
  const activeScreen = document.querySelector('.screen.active').id;
  if (activeScreen === 'screen-pasada') {
    navState.pasada = null;
    showScreen('screen-competencia');
    renderCompetenciaDetail();
  } else if (activeScreen === 'screen-competencia') {
    navState.competenciaId = null;
    navState.sesion = null;
    showScreen('screen-competencias');
    renderCompetencias();
  }
}

// ====================================================
// NIVEL 1 · COMPETENCIAS - alta, edición, borrado y listado
// ====================================================

function openCompetenciaModal(id = null) {
  const form = document.getElementById('form-competencia');
  form.reset();
  document.getElementById('competencia-id').value = '';
  document.getElementById('modal-competencia-title').textContent = 'Nueva competencia';

  if (id) {
    const item = getList(STORAGE_KEYS.competencias).find(c => c.id === id);
    if (item) {
      document.getElementById('modal-competencia-title').textContent = 'Editar competencia';
      document.getElementById('competencia-id').value = item.id;
      document.getElementById('competencia-nombre-input').value = item.nombre || '';
      document.getElementById('competencia-piloto-input').value = item.piloto || '';
      document.getElementById('competencia-fecha-input').value = item.fecha || '';
    }
  }

  document.getElementById('modal-competencia').classList.remove('hidden');
}

function closeCompetenciaModal() {
  document.getElementById('modal-competencia').classList.add('hidden');
}

function handleCompetenciaSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('competencia-id').value;
  const data = {
    nombre: document.getElementById('competencia-nombre-input').value.trim(),
    piloto: document.getElementById('competencia-piloto-input').value.trim(),
    fecha: document.getElementById('competencia-fecha-input').value
  };

  if (!data.nombre) return; // el nombre es obligatorio

  const list = getList(STORAGE_KEYS.competencias);

  if (id) {
    const idx = list.findIndex(c => c.id === id);
    if (idx !== -1) list[idx] = { ...list[idx], ...data };
  } else {
    data.id = 'c_' + Date.now();
    list.unshift(data);
  }

  saveList(STORAGE_KEYS.competencias, list);
  closeCompetenciaModal();
  renderCompetencias();

  // Si estábamos editando la competencia que tenemos abierta, refrescamos su detalle
  if (id && navState.competenciaId === id) renderCompetenciaDetail();
}

// Elimina una competencia y, con ella, todos los neumáticos,
// setups y tramos que se hayan cargado en sus pasadas.
function deleteCompetencia(id) {
  if (!confirm('¿Eliminar esta competencia? Se van a borrar también todos los datos de sus pasadas (neumáticos, setups y tramos).')) return;

  const prefix = id + '::';
  saveList(STORAGE_KEYS.competencias, getList(STORAGE_KEYS.competencias).filter(c => c.id !== id));
  saveList(STORAGE_KEYS.neumaticos, getList(STORAGE_KEYS.neumaticos).filter(n => !(n.pasadaKey || '').startsWith(prefix)));
  saveList(STORAGE_KEYS.setups, getList(STORAGE_KEYS.setups).filter(s => !(s.pasadaKey || '').startsWith(prefix)));
  saveList(STORAGE_KEYS.tramos, getList(STORAGE_KEYS.tramos).filter(t => !(t.pasadaKey || '').startsWith(prefix)));

  if (navState.competenciaId === id) {
    navState.competenciaId = null;
    navState.sesion = null;
    navState.pasada = null;
    showScreen('screen-competencias');
  }
  renderCompetencias();
}

// Atajos usados por los botones de editar/eliminar dentro
// de la pantalla de detalle de una competencia.
function editCurrentCompetencia() {
  openCompetenciaModal(navState.competenciaId);
}
function deleteCurrentCompetencia() {
  deleteCompetencia(navState.competenciaId);
}

// Dibuja las tarjetas de todas las competencias guardadas.
function renderCompetencias() {
  const list = getList(STORAGE_KEYS.competencias);
  const container = document.getElementById('competencias-list');
  const empty = document.getElementById('competencias-empty');
  if (!container || !empty) return;

  if (list.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    empty.classList.add('flex');
    return;
  }
  empty.classList.add('hidden');
  empty.classList.remove('flex');

  container.innerHTML = list.map(c => `
    <div data-open-competencia="${c.id}" class="card-tap cursor-pointer bg-white border border-gray-200 shadow-sm rounded-2xl p-5 hover:border-[#ff5722]/40 hover:shadow-md transition">
      <div class="flex items-start justify-between mb-3">
        <span class="badge inline-block">${escapeHtml(c.piloto) || 'Sin piloto'}</span>
        <div class="flex gap-1">
          <button data-edit-competencia="${c.id}" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600 transition">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          </button>
          <button data-delete-competencia="${c.id}" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-gray-600 hover:text-red-500 transition">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </div>
      <p class="font-display font-semibold text-lg text-gray-900">${escapeHtml(c.nombre)}</p>
      <p class="text-xs text-gray-600 mt-1">${formatFecha(c.fecha)}</p>
    </div>
  `).join('');

  container.querySelectorAll('[data-open-competencia]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-edit-competencia]') || e.target.closest('[data-delete-competencia]')) return;
      selectCompetencia(el.dataset.openCompetencia);
    });
  });
  container.querySelectorAll('[data-edit-competencia]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openCompetenciaModal(btn.dataset.editCompetencia); });
  });
  container.querySelectorAll('[data-delete-competencia]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteCompetencia(btn.dataset.deleteCompetencia); });
  });
}

// ====================================================
// NIVEL 2 · Dentro de una competencia: sesión + pasadas
// ====================================================

function selectCompetencia(id) {
  navState.competenciaId = id;
  navState.sesion = null;
  navState.pasada = null;
  navState.vista = 'resumen';
  showScreen('screen-competencia');
  renderCompetenciaDetail();
}

function renderCompetenciaDetail() {
  const comp = getList(STORAGE_KEYS.competencias).find(c => c.id === navState.competenciaId);
  if (!comp) { showScreen('screen-competencias'); renderCompetencias(); return; }

  document.getElementById('competencia-nombre').textContent = comp.nombre;
  document.getElementById('competencia-fecha').textContent = formatFecha(comp.fecha);
  document.getElementById('competencia-piloto-badge').textContent = comp.piloto || 'Sin piloto';

  // Pestañas Resumen / Pasadas
  document.querySelectorAll('[data-vista]').forEach(btn => {
    btn.classList.toggle('modulo-tab-active', btn.dataset.vista === navState.vista);
  });
  document.getElementById('vista-resumen').classList.toggle('hidden', navState.vista !== 'resumen');
  document.getElementById('vista-pasadas').classList.toggle('hidden', navState.vista !== 'pasadas');

  if (navState.vista === 'resumen') {
    renderResumen();
    updateHeader();
    return;
  }

  document.querySelectorAll('.sesion-tab').forEach(btn => {
    btn.classList.toggle('sesion-tab-active', btn.dataset.sesion === navState.sesion);
  });

  const pasadasWrap = document.getElementById('pasadas-wrap');
  const pasadasHint = document.getElementById('pasadas-hint');
  const sesionBaseWrap = document.getElementById('sesion-base-wrap');

  if (!navState.sesion) {
    pasadasWrap.classList.add('hidden');
    pasadasHint.classList.remove('hidden');
    if (sesionBaseWrap) sesionBaseWrap.classList.add('hidden');
  } else {
    pasadasHint.classList.add('hidden');
    pasadasWrap.classList.remove('hidden');
    if (sesionBaseWrap) sesionBaseWrap.classList.remove('hidden');
    renderBaseNeumaticos();
    renderBaseSetups();
    renderPasadasGrid();
  }

  updateHeader();
}

function selectVista(vista) {
  navState.vista = vista;
  renderCompetenciaDetail();
}

function selectSesion(sesion) {
  navState.sesion = sesion;
  navState.pasada = null;
  renderCompetenciaDetail();
}

// Dibuja la vista de "Resumen": totales de la competencia entera y,
// para cada pasada que tenga algo cargado, el detalle completo de
// sus neumáticos, su setup y sus tramos (sin tener que entrar). Usa
// las mismas tarjetas que el módulo de cada pasada, así también acá
// se ve si algo se heredó (de la pasada anterior o de la base) y qué
// cambió puntualmente, resaltado en naranja.
function renderResumen() {
  const compId = navState.competenciaId;
  const prefix = compId + '::';

  const neumaticos = getList(STORAGE_KEYS.neumaticos).filter(n => (n.pasadaKey || '').startsWith(prefix));
  const setups = getList(STORAGE_KEYS.setups).filter(s => (s.pasadaKey || '').startsWith(prefix));
  const tramos = getList(STORAGE_KEYS.tramos).filter(t => (t.pasadaKey || '').startsWith(prefix));

  document.getElementById('resumen-count-neumaticos').textContent = neumaticos.length;
  document.getElementById('resumen-count-setups').textContent = setups.length;
  document.getElementById('resumen-count-tramos').textContent = tramos.length;

  // Tarjeta de tramo: incluye notas además de tiempo/distancia/posición.
  // Los tramos no tienen concepto de base/herencia, así que se quedan
  // con su propia tarjeta simple.
  const tramoCard = (t) => `
    <div class="bg-gray-50 border border-gray-200 rounded-xl p-3">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm font-medium text-gray-900 truncate">${escapeHtml(t.nombre)}</p>
        <p class="font-display font-semibold text-gray-900 shrink-0">${escapeHtml(t.tiempo) || '—'}</p>
      </div>
      <p class="text-xs text-gray-600">${t.posicion ? escapeHtml(t.posicion) : ''}${t.distancia ? (t.posicion ? ' · ' : '') + escapeHtml(t.distancia) + ' km' : ''}</p>
      ${t.notas ? `<p class="text-xs text-gray-600 mt-1">${escapeHtml(t.notas)}</p>` : ''}
    </div>
  `;

  const sesionesWrap = document.getElementById('resumen-sesiones');
  let html = '';

  SESIONES.forEach(ses => {
    const pasadasConDatos = [];
    for (let n = 1; n <= 10; n++) {
      const key = pasadaKey(compId, ses, n);
      const nOwn = neumaticos.filter(x => x.pasadaKey === key);
      const sOwn = setups.filter(x => x.pasadaKey === key);
      const tDePasada = tramos.filter(x => x.pasadaKey === key);
      if (nOwn.length || sOwn.length || tDePasada.length) {
        pasadasConDatos.push({ n, nOwn, sOwn, tDePasada });
      }
    }

    html += `
      <div>
        <p class="font-display font-semibold text-gray-900 mb-2">${ses}
          <span class="text-xs font-normal text-gray-600">(${pasadasConDatos.length} de 10 pasadas con datos)</span>
        </p>
    `;

    if (pasadasConDatos.length === 0) {
      html += `<p class="text-sm text-gray-600 mb-4">Sin datos cargados todavía.</p>`;
    } else {
      html += pasadasConDatos.map(p => {
        // Qué mostraría esta pasada si no hubiera cargado nada propio
        // (para saber si heredó y contra qué comparar los cambios).
        const neumHeredado = efectivoAnteriorPara(STORAGE_KEYS.neumaticos, compId, ses, p.n);
        const setupHeredado = efectivoAnteriorPara(STORAGE_KEYS.setups, compId, ses, p.n);

        const usaHeredadoNeum = p.nOwn.length === 0 && neumHeredado.list.length > 0;
        const listaNeum = p.nOwn.length > 0 ? p.nOwn : neumHeredado.list;

        const usaHeredadoSetup = p.sOwn.length === 0 && setupHeredado.list.length > 0;
        const listaSetup = p.sOwn.length > 0 ? p.sOwn : setupHeredado.list;

        return `
        <div class="bg-white border border-gray-200 shadow-sm rounded-2xl p-4 mb-3">
          <p class="text-xs font-medium text-[#c2410c] uppercase tracking-wide mb-3">Pasada ${p.n}</p>

          ${listaNeum.length ? `
            <p class="text-xs text-gray-600 mb-1.5">Neumáticos</p>
            <div class="grid gap-2 mb-3 grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
              ${listaNeum.map((n, i) => {
                const base = (!usaHeredadoNeum && neumHeredado.list[i]) ? neumHeredado.list[i] : null;
                return neumaticoCardHtml(n, { heredado: usaHeredadoNeum, base, origenLabel: neumHeredado.origen, soloLectura: true });
              }).join('')}
            </div>
          ` : ''}

          ${listaSetup.length ? `
            <p class="text-xs text-gray-600 mb-1.5">Setup</p>
            <div class="grid gap-2 mb-3 grid-cols-[repeat(auto-fit,minmax(340px,1fr))]">
              ${listaSetup.map((s, i) => {
                const base = (!usaHeredadoSetup && setupHeredado.list[i]) ? setupHeredado.list[i] : null;
                return setupCardHtml(s, { heredado: usaHeredadoSetup, base, origenLabel: setupHeredado.origen, soloLectura: true });
              }).join('')}
            </div>
          ` : ''}

          ${p.tDePasada.length ? `
            <p class="text-xs text-gray-600 mb-1.5">Tramos</p>
            <div class="grid gap-2 grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
              ${p.tDePasada.map(tramoCard).join('')}
            </div>
          ` : ''}
        </div>
      `;
      }).join('');
    }

    html += `</div>`;
  });

  sesionesWrap.innerHTML = html;
}

// ¿La pasada `n` cargó un neumático o setup PROPIO que además es
// distinto de lo que hubiera heredado (de la pasada anterior o de la
// base)? Sirve para marcar en la grilla qué pasadas tienen cambios
// reales, no solo datos heredados sin tocar.
function pasadaTieneCambios(n) {
  const key = pasadaKey(navState.competenciaId, navState.sesion, n);
  const neumOverride = getList(STORAGE_KEYS.neumaticos).filter(x => x.pasadaKey === key);
  const setupOverride = getList(STORAGE_KEYS.setups).filter(x => x.pasadaKey === key);
  if (neumOverride.length === 0 && setupOverride.length === 0) return false;

  const neumHeredado = currentEfectivoAnterior(STORAGE_KEYS.neumaticos, n).list;
  const setupHeredado = currentEfectivoAnterior(STORAGE_KEYS.setups, n).list;

  const neumCambio = neumOverride.some((item, i) => neumHeredado[i] && diffCampos(item, neumHeredado[i], NEUMATICO_DIFF_FIELDS).length > 0);
  const setupCambio = setupOverride.some((item, i) => setupHeredado[i] && setupCambiosHtml(item, setupHeredado[i]) !== '');

  return neumCambio || setupCambio;
}

function renderPasadasGrid() {
  const grid = document.getElementById('pasadas-grid');
  if (!grid) return;

  let html = '';
  for (let n = 1; n <= 10; n++) {
    const activa = navState.pasada === n;
    const tieneDatos = pasadaHasData(n);
    const tieneCambios = pasadaTieneCambios(n);
    html += `
      <button data-pasada="${n}" class="pasada-btn ${activa ? 'pasada-btn-active' : ''}">
        ${n}
        ${tieneDatos ? '<span class="pasada-dot"></span>' : ''}
        ${tieneCambios ? '<span class="pasada-dot-cambio"></span>' : ''}
      </button>
    `;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('[data-pasada]').forEach(btn => {
    btn.addEventListener('click', () => selectPasada(Number(btn.dataset.pasada)));
  });
}

// ====================================================
// NIVEL 3 · Dentro de una pasada: módulos
// ====================================================

function selectPasada(n) {
  navState.pasada = n;
  showScreen('screen-pasada');
  document.querySelectorAll('.modulo-tab').forEach(btn => {
    btn.classList.toggle('modulo-tab-active', btn.dataset.modulo === navState.modulo);
  });
  showModulo(navState.modulo);
}

function showModulo(modulo) {
  navState.modulo = modulo;

  document.querySelectorAll('.modulo-tab').forEach(btn => {
    btn.classList.toggle('modulo-tab-active', btn.dataset.modulo === modulo);
  });
  document.querySelectorAll('.modulo-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById('modulo-' + modulo);
  if (panel) panel.classList.remove('hidden');

  if (modulo === 'neumaticos') renderNeumaticos();
  if (modulo === 'setup') renderSetups();
  if (modulo === 'tramos') renderTramos();

  updateHeader();
}

// ====================================================
// MÓDULO · NEUMÁTICOS (alta, edición, borrado y listado)
// Todo queda asociado a la pasada actual (currentPasadaKey)
// ====================================================

const ESTADO_CLASSES = {
  'Nuevo': 'bg-emerald-50 text-emerald-600',
  'Usado': 'bg-amber-50 text-amber-600',
  'Gastado': 'bg-red-50 text-red-600',
  'Descartado': 'bg-gray-100 text-gray-600'
};

// Campos de neumático que se comparan contra la base para saber
// qué resaltar cuando una pasada carga uno propio.
const NEUMATICO_DIFF_FIELDS = [
  ['marca', 'Marca'],
  ['compuesto', 'Compuesto'],
  ['posicion', 'Posición'],
  ['estado', 'Estado'],
  ['presionDelFrio', 'Presión del. (frío)'],
  ['presionDelCaliente', 'Presión del. (caliente)'],
  ['presionTrasFrio', 'Presión tras. (frío)'],
  ['presionTrasCaliente', 'Presión tras. (caliente)'],
  ['uso', 'Uso'],
  ['notas', 'Notas']
];

// Devuelve las etiquetas de los campos que cambiaron entre "actual"
// y "base" (solo cuenta si el campo actual tiene algo cargado).
function diffCampos(actual, base, campos) {
  if (!actual || !base) return [];
  return campos
    .filter(([clave]) => (actual[clave] || '') !== (base[clave] || '') && (actual[clave] || '') !== '')
    .map(([, label]) => label);
}

// true si estamos completando el modal para el neumático BASE de la
// sesión (en vez de para la pasada puntual que se está viendo).
let neumaticoModalEsBase = false;

function completarFormNeumatico(item) {
  document.getElementById('neumatico-codigo').value = item.codigo || '';
  document.getElementById('neumatico-marca').value = item.marca || '';
  document.getElementById('neumatico-compuesto').value = item.compuesto || 'Blando';
  document.getElementById('neumatico-posicion').value = item.posicion || 'Juego completo (4)';
  document.getElementById('neumatico-estado').value = item.estado || 'Nuevo';
  document.getElementById('neumatico-presion-del-frio').value = item.presionDelFrio || '';
  document.getElementById('neumatico-presion-del-caliente').value = item.presionDelCaliente || '';
  document.getElementById('neumatico-presion-tras-frio').value = item.presionTrasFrio || '';
  document.getElementById('neumatico-presion-tras-caliente').value = item.presionTrasCaliente || '';
  document.getElementById('neumatico-uso').value = item.uso || '';
  document.getElementById('neumatico-notas').value = item.notas || '';
}

// `esBase`: true si se está creando/editando el neumático BASE de la
// sesión. `valoresIniciales`: cuando se quiere "editar para esta
// pasada" a partir de un neumático heredado de la base, se pasa ese
// neumático acá para precargar el formulario (pero guarda como
// registro nuevo, propio de la pasada).
function openNeumaticoModal(id = null, esBase = false, valoresIniciales = null) {
  neumaticoModalEsBase = esBase;
  const form = document.getElementById('form-neumatico');
  form.reset();
  document.getElementById('neumatico-id').value = '';
  document.getElementById('modal-neumatico-title').textContent = esBase ? 'Nuevo neumático base' : 'Nuevo juego de neumáticos';

  if (id) {
    const item = getList(STORAGE_KEYS.neumaticos).find(n => n.id === id);
    if (item) {
      document.getElementById('modal-neumatico-title').textContent = esBase ? 'Editar neumático base' : 'Editar juego de neumáticos';
      document.getElementById('neumatico-id').value = item.id;
      completarFormNeumatico(item);
    }
  } else if (valoresIniciales) {
    document.getElementById('modal-neumatico-title').textContent = 'Editar para esta pasada';
    completarFormNeumatico(valoresIniciales);
  }

  document.getElementById('modal-neumatico').classList.remove('hidden');
}

function closeNeumaticoModal() {
  document.getElementById('modal-neumatico').classList.add('hidden');
}

function handleNeumaticoSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('neumatico-id').value;
  const data = {
    codigo: document.getElementById('neumatico-codigo').value.trim(),
    marca: document.getElementById('neumatico-marca').value.trim(),
    compuesto: document.getElementById('neumatico-compuesto').value,
    posicion: document.getElementById('neumatico-posicion').value,
    estado: document.getElementById('neumatico-estado').value,
    presionDelFrio: document.getElementById('neumatico-presion-del-frio').value,
    presionDelCaliente: document.getElementById('neumatico-presion-del-caliente').value,
    presionTrasFrio: document.getElementById('neumatico-presion-tras-frio').value,
    presionTrasCaliente: document.getElementById('neumatico-presion-tras-caliente').value,
    uso: document.getElementById('neumatico-uso').value.trim(),
    notas: document.getElementById('neumatico-notas').value.trim()
  };

  if (!data.codigo) return;

  const list = getList(STORAGE_KEYS.neumaticos);

  if (id) {
    const idx = list.findIndex(n => n.id === id);
    if (idx !== -1) list[idx] = { ...list[idx], ...data };
  } else {
    data.id = 'n_' + Date.now();
    data.fecha = new Date().toISOString();
    data.pasadaKey = neumaticoModalEsBase ? currentBaseKey() : currentPasadaKey();
    list.unshift(data);
  }

  saveList(STORAGE_KEYS.neumaticos, list);
  closeNeumaticoModal();
  renderNeumaticos();
  renderBaseNeumaticos();
}

function deleteNeumatico(id) {
  if (!confirm('¿Eliminar este juego de neumáticos?')) return;
  const list = getList(STORAGE_KEYS.neumaticos).filter(n => n.id !== id);
  saveList(STORAGE_KEYS.neumaticos, list);
  renderNeumaticos();
  renderBaseNeumaticos();
}

// Arma la tarjeta de un neumático. Si `opciones.heredado` es true, la
// tarjeta viene de la base de la sesión (la pasada no tiene uno
// propio) y se muestra con borde punteado + botón para personalizarla
// solo en esta pasada. Si `opciones.base` viene cargado, se resaltan
// en naranja los campos que cambiaron respecto a ese neumático base.
function neumaticoCardHtml(n, opciones = {}) {
  const base = opciones.base || null;
  const heredado = !!opciones.heredado;
  const origenLabel = opciones.origenLabel || 'la base de la sesión';
  const soloLectura = !!opciones.soloLectura;
  const cambios = base ? diffCampos(n, base, NEUMATICO_DIFF_FIELDS) : [];

  return `
    <div class="bg-white border ${heredado ? 'border-dashed border-gray-300' : 'border-gray-200'} shadow-sm rounded-2xl p-5">
      ${heredado ? `<p class="text-[10px] uppercase tracking-wide text-gray-600 mb-2">Heredado de ${escapeHtml(origenLabel)}</p>` : ''}
      <div class="flex items-start justify-between mb-3">
        <div>
          <p class="font-display font-semibold text-base text-gray-900">${escapeHtml(n.codigo)}</p>
          <p class="text-xs text-gray-600">${escapeHtml(n.marca) || 'Sin marca'}</p>
        </div>
        <span class="text-[10px] uppercase tracking-wide font-medium px-2 py-1 rounded-full ${ESTADO_CLASSES[n.estado] || ESTADO_CLASSES['Nuevo']}">${escapeHtml(n.estado)}</span>
      </div>
      ${cambios.length ? `<div class="flex flex-wrap gap-1 mb-3">${cambios.map(c => `<span class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#ff5722]/15 text-[#c2410c]">Cambió: ${escapeHtml(c)}</span>`).join('')}</div>` : ''}
      <div class="flex flex-wrap gap-1.5 mb-4">
        <span class="badge">${escapeHtml(n.compuesto)}</span>
        <span class="badge">${escapeHtml(n.posicion)}</span>
      </div>
      <div class="grid grid-cols-2 gap-3 text-sm mb-3">
        <div>
          <p class="text-gray-600 text-xs">Del. frío / caliente</p>
          <p class="font-display font-semibold text-gray-900">${n.presionDelFrio ? n.presionDelFrio + ' bar' : '—'} / ${n.presionDelCaliente ? n.presionDelCaliente + ' bar' : '—'}</p>
        </div>
        <div>
          <p class="text-gray-600 text-xs">Tras. frío / caliente</p>
          <p class="font-display font-semibold text-gray-900">${n.presionTrasFrio ? n.presionTrasFrio + ' bar' : '—'} / ${n.presionTrasCaliente ? n.presionTrasCaliente + ' bar' : '—'}</p>
        </div>
      </div>
      <div class="text-sm mb-4">
        <p class="text-gray-600 text-xs">Uso</p>
        <p class="font-display font-semibold text-gray-900">${escapeHtml(n.uso) || '—'}</p>
      </div>
      ${n.notas ? `<p class="text-xs text-gray-600 mb-4">${escapeHtml(n.notas)}</p>` : ''}
      ${soloLectura ? '' : `
      <div class="flex gap-2 pt-3 border-t border-gray-100">
        ${heredado ? `
          <button data-usar-base="${n.id}" class="flex-1 text-xs font-medium py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition">Editar para esta pasada</button>
        ` : `
          <button data-edit="${n.id}" class="flex-1 text-xs font-medium py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition">Editar</button>
          <button data-delete="${n.id}" class="flex-1 text-xs font-medium py-2 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition">Eliminar</button>
        `}
      </div>
      `}
    </div>
  `;
}

// Dibuja los neumáticos de la pasada actual. Si la pasada no cargó
// ninguno propio, muestra los de la base de la sesión (heredados).
// Si sí tiene propios, resalta los campos que difieren de la base.
function renderNeumaticos() {
  const overrideList = getList(STORAGE_KEYS.neumaticos).filter(n => n.pasadaKey === currentPasadaKey());
  const heredado = currentEfectivoAnterior(STORAGE_KEYS.neumaticos, navState.pasada);
  const heredadoList = heredado.list;
  const container = document.getElementById('neumaticos-list');
  const empty = document.getElementById('neumaticos-empty');
  if (!container || !empty) return;

  const usaHeredado = overrideList.length === 0 && heredadoList.length > 0;
  const list = overrideList.length > 0 ? overrideList : heredadoList;

  if (list.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    empty.classList.add('flex');
    return;
  }
  empty.classList.add('hidden');
  empty.classList.remove('flex');

  container.innerHTML = list.map((n, i) => {
    const baseItem = (!usaHeredado && heredadoList[i]) ? heredadoList[i] : null;
    return neumaticoCardHtml(n, { heredado: usaHeredado, base: baseItem, origenLabel: heredado.origen });
  }).join('');

  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openNeumaticoModal(btn.dataset.edit));
  });
  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteNeumatico(btn.dataset.delete));
  });
  container.querySelectorAll('[data-usar-base]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = heredadoList.find(x => x.id === btn.dataset.usarBase);
      if (item) openNeumaticoModal(null, false, item);
    });
  });
}

// Dibuja los neumáticos BASE de la sesión actualmente seleccionada
// (se muestra en la solapa "Pasadas", antes de elegir una pasada).
function renderBaseNeumaticos() {
  const list = getList(STORAGE_KEYS.neumaticos).filter(n => n.pasadaKey === currentBaseKey());
  const container = document.getElementById('base-neumaticos-list');
  const empty = document.getElementById('base-neumaticos-empty');
  if (!container || !empty) return;

  if (list.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  container.innerHTML = list.map(n => neumaticoCardHtml(n)).join('');

  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openNeumaticoModal(btn.dataset.edit, true));
  });
  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteNeumatico(btn.dataset.delete));
  });
}

// ====================================================
// MÓDULO · SETUP (alta, edición, borrado y listado)
// Todo queda asociado a la pasada actual (currentPasadaKey)
// ====================================================

// Campos que se repiten igual para el amortiguador delantero (prefijo
// "ad") y el trasero (prefijo "at"). Cada fila es [sufijo del id en el
// HTML, clave con la que se guarda en el objeto de datos, etiqueta
// legible (se usa para mostrar el detalle completo en las tarjetas)].
const SETUP_AMORT_FIELDS = [
  ['altura', 'altura', 'Alta'],
  ['baja', 'baja', 'Baja'],
  ['expansion', 'expansion', 'Expansión'],
  ['altura-rosca', 'alturaRosca', 'Altura Rosca'],
  ['altura-puente-piso', 'alturaPuentePiso', 'Altura Puente Piso'],
  ['espirales', 'espirales', 'Espirales'],
  ['helpers', 'helpers', 'Helpers'],
  ['barra-dureza', 'barraDureza', 'Barra Dureza'],
  ['barra-posicion', 'barraPosicion', 'Barra Posición'],
  ['alineado', 'alineado', 'Alineado'],
  ['setting', 'setting', 'Setting'],
  ['rcv', 'rcv', 'RCV']
];

// Campos del Diferencial, delantero (prefijo "dd") y trasero (prefijo "dt").
const SETUP_DIF_FIELDS = [
  ['rampas', 'rampas', 'Rampas'],
  ['cf', 'cf', 'CF'],
  ['precarga', 'precarga', 'Precarga']
];

// Lee del formulario todos los campos de un grupo (ej: amortiguador
// delantero) y arma un objeto { altura: '...', baja: '...', ... }.
function leerGrupoSetup(prefijo, campos) {
  const obj = {};
  campos.forEach(([sufijoId, clave]) => {
    const el = document.getElementById('setup-' + prefijo + '-' + sufijoId);
    obj[clave] = el ? el.value.trim() : '';
  });
  return obj;
}

// Hace lo inverso: toma un objeto guardado y lo vuelve a poner en
// los campos del formulario correspondientes.
function completarGrupoSetup(prefijo, campos, valores) {
  campos.forEach(([sufijoId, clave]) => {
    const el = document.getElementById('setup-' + prefijo + '-' + sufijoId);
    if (el) el.value = (valores && valores[clave]) || '';
  });
}

// true si estamos completando el modal para el setup BASE de la sesión.
let setupModalEsBase = false;

function completarFormSetup(item) {
  document.getElementById('setup-nombre').value = item.nombre || '';
  document.getElementById('setup-superficie').value = item.superficie || 'Grava';
  document.getElementById('setup-notas').value = item.notas || '';

  completarGrupoSetup('ad', SETUP_AMORT_FIELDS, item.amortDel);
  completarGrupoSetup('at', SETUP_AMORT_FIELDS, item.amortTras);
  completarGrupoSetup('dd', SETUP_DIF_FIELDS, item.difDel);
  completarGrupoSetup('dt', SETUP_DIF_FIELDS, item.difTras);
}

// `esBase`: true si se está creando/editando el setup BASE de la
// sesión. `valoresIniciales`: para "editar para esta pasada" a partir
// de un setup heredado de la base (precarga el formulario, guarda
// como registro nuevo propio de la pasada).
function openSetupModal(id = null, esBase = false, valoresIniciales = null) {
  setupModalEsBase = esBase;
  const form = document.getElementById('form-setup');
  form.reset();
  document.getElementById('setup-id').value = '';
  document.getElementById('modal-setup-title').textContent = esBase ? 'Nuevo setup base' : 'Nuevo setup';

  if (id) {
    const item = getList(STORAGE_KEYS.setups).find(s => s.id === id);
    if (item) {
      document.getElementById('modal-setup-title').textContent = esBase ? 'Editar setup base' : 'Editar setup';
      document.getElementById('setup-id').value = item.id;
      completarFormSetup(item);
    }
  } else if (valoresIniciales) {
    document.getElementById('modal-setup-title').textContent = 'Editar para esta pasada';
    completarFormSetup(valoresIniciales);
  }

  document.getElementById('modal-setup').classList.remove('hidden');
}

function closeSetupModal() {
  document.getElementById('modal-setup').classList.add('hidden');
}

function handleSetupSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('setup-id').value;
  const data = {
    nombre: document.getElementById('setup-nombre').value.trim(),
    superficie: document.getElementById('setup-superficie').value,
    notas: document.getElementById('setup-notas').value.trim(),
    amortDel: leerGrupoSetup('ad', SETUP_AMORT_FIELDS),
    amortTras: leerGrupoSetup('at', SETUP_AMORT_FIELDS),
    difDel: leerGrupoSetup('dd', SETUP_DIF_FIELDS),
    difTras: leerGrupoSetup('dt', SETUP_DIF_FIELDS)
  };

  if (!data.nombre) return;

  const list = getList(STORAGE_KEYS.setups);

  if (id) {
    const idx = list.findIndex(s => s.id === id);
    if (idx !== -1) list[idx] = { ...list[idx], ...data };
  } else {
    data.id = 's_' + Date.now();
    data.fecha = new Date().toISOString();
    data.pasadaKey = setupModalEsBase ? currentBaseKey() : currentPasadaKey();
    list.unshift(data);
  }

  saveList(STORAGE_KEYS.setups, list);
  closeSetupModal();
  renderSetups();
  renderBaseSetups();
}

// Arma el HTML con el detalle completo de un grupo de Setup (ej:
// Amortiguador Delantero) mostrando solo los campos que tienen algo
// cargado. Se usa tanto en la tarjeta del módulo Setup como en el
// Resumen, para que en ningún lado se pierda información cargada.
function grupoSetupDetalleHtml(titulo, campos, valores) {
  if (!valores) return '';
  const filas = campos.filter(([, clave]) => valores[clave]);
  if (filas.length === 0) return '';
  return `
    <div class="mb-3">
      <p class="text-xs font-semibold text-gray-600 mb-1">${titulo}</p>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5">
        ${filas.map(([, clave, label]) => `
          <p class="text-xs text-gray-700"><span class="text-gray-600">${label}:</span> ${escapeHtml(valores[clave])}</p>
        `).join('')}
      </div>
    </div>
  `;
}

// Versión en texto plano de grupoSetupDetalleHtml (para el PDF): una
// sola línea "Título: campo=valor, campo=valor". Vacío si no hay nada
// cargado en ese grupo.
function grupoSetupDetalleTexto(titulo, campos, valores) {
  if (!valores) return '';
  const filas = campos.filter(([, clave]) => valores[clave]);
  if (filas.length === 0) return '';
  const partes = filas.map(([, clave, label]) => `${label}=${valores[clave]}`);
  return `${titulo}: ${partes.join(', ')}`;
}

// Detalle completo de amortiguadores + diferencial de un setup (todo
// lo que se haya cargado, sin importar cuánto sea).
function setupDetalleCompletoHtml(s) {
  return `
    ${grupoSetupDetalleHtml('Amortiguador Delantero', SETUP_AMORT_FIELDS, s.amortDel)}
    ${grupoSetupDetalleHtml('Amortiguador Trasero', SETUP_AMORT_FIELDS, s.amortTras)}
    ${grupoSetupDetalleHtml('Diferencial Delantero', SETUP_DIF_FIELDS, s.difDel)}
    ${grupoSetupDetalleHtml('Diferencial Trasero', SETUP_DIF_FIELDS, s.difTras)}
  `;
}

function deleteSetup(id) {
  if (!confirm('¿Eliminar este setup?')) return;
  const list = getList(STORAGE_KEYS.setups).filter(s => s.id !== id);
  saveList(STORAGE_KEYS.setups, list);
  renderSetups();
  renderBaseSetups();
}

// Compara un grupo de campos (ej: Amortiguador Delantero) entre el
// setup actual y el setup base, y devuelve las etiquetas de los que
// cambiaron, con el nombre del grupo entre paréntesis.
function diffGrupoConPrefijo(prefijoLabel, actualObj, baseObj, campos) {
  if (!actualObj || !baseObj) return [];
  return campos
    .filter(([, clave]) => (actualObj[clave] || '') !== (baseObj[clave] || '') && (actualObj[clave] || '') !== '')
    .map(([, , label]) => `${label} (${prefijoLabel})`);
}

// Lista (en texto plano) de todos los campos que cambiaron entre un
// setup y el setup base de la sesión (presiones + los 4 grupos). La
// usan tanto la tarjeta HTML (setupCambiosHtml) como el generador de PDF.
function cambiosSetupTexto(s, base) {
  if (!base) return [];
  let cambios = diffCampos(s, base, [['notas', 'Notas']]);
  cambios = cambios.concat(diffGrupoConPrefijo('Amort. Del.', s.amortDel, base.amortDel, SETUP_AMORT_FIELDS));
  cambios = cambios.concat(diffGrupoConPrefijo('Amort. Tras.', s.amortTras, base.amortTras, SETUP_AMORT_FIELDS));
  cambios = cambios.concat(diffGrupoConPrefijo('Dif. Del.', s.difDel, base.difDel, SETUP_DIF_FIELDS));
  cambios = cambios.concat(diffGrupoConPrefijo('Dif. Tras.', s.difTras, base.difTras, SETUP_DIF_FIELDS));
  return cambios;
}

// Arma los "chips" naranjas con todos los campos que cambiaron entre
// un setup y el setup base de la sesión.
function setupCambiosHtml(s, base) {
  const cambios = cambiosSetupTexto(s, base);
  if (cambios.length === 0) return '';
  return `<div class="flex flex-wrap gap-1 mb-3">${cambios.map(c => `<span class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#ff5722]/15 text-[#c2410c]">Cambió: ${escapeHtml(c)}</span>`).join('')}</div>`;
}

// Arma la tarjeta de un setup. Igual que con neumáticos: `heredado`
// = viene de la base (sin override propio en esta pasada), `base`
// = setup base contra el que comparar para resaltar cambios.
function setupCardHtml(s, opciones = {}) {
  const base = opciones.base || null;
  const heredado = !!opciones.heredado;
  const origenLabel = opciones.origenLabel || 'la base de la sesión';
  const soloLectura = !!opciones.soloLectura;

  return `
    <div class="bg-white border ${heredado ? 'border-dashed border-gray-300' : 'border-gray-200'} shadow-sm rounded-2xl p-5">
      ${heredado ? `<p class="text-[10px] uppercase tracking-wide text-gray-600 mb-2">Heredado de ${escapeHtml(origenLabel)}</p>` : ''}
      <div class="mb-3">
        <p class="font-display font-semibold text-base text-gray-900">${escapeHtml(s.nombre)}</p>
        <span class="badge inline-block mt-1">${escapeHtml(s.superficie)}</span>
      </div>
      ${base ? setupCambiosHtml(s, base) : ''}
      ${setupDetalleCompletoHtml(s)}
      ${s.notas ? `<p class="text-xs text-gray-600 mb-4">${escapeHtml(s.notas)}</p>` : ''}
      ${soloLectura ? '' : `
      <div class="flex gap-2 pt-3 border-t border-gray-100">
        ${heredado ? `
          <button data-usar-base-setup="${s.id}" class="flex-1 text-xs font-medium py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition">Editar para esta pasada</button>
        ` : `
          <button data-edit-setup="${s.id}" class="flex-1 text-xs font-medium py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition">Editar</button>
          <button data-delete-setup="${s.id}" class="flex-1 text-xs font-medium py-2 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition">Eliminar</button>
        `}
      </div>
      `}
    </div>
  `;
}

// Dibuja los setups de la pasada actual. Si no cargó ninguno propio,
// muestra el/los de la base de la sesión (heredados). Si sí tiene
// propios, resalta los campos que difieren de la base.
function renderSetups() {
  const overrideList = getList(STORAGE_KEYS.setups).filter(s => s.pasadaKey === currentPasadaKey());
  const heredado = currentEfectivoAnterior(STORAGE_KEYS.setups, navState.pasada);
  const heredadoList = heredado.list;
  const container = document.getElementById('setups-list');
  const empty = document.getElementById('setups-empty');
  if (!container || !empty) return;

  const usaHeredado = overrideList.length === 0 && heredadoList.length > 0;
  const list = overrideList.length > 0 ? overrideList : heredadoList;

  if (list.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    empty.classList.add('flex');
    return;
  }
  empty.classList.add('hidden');
  empty.classList.remove('flex');

  container.innerHTML = list.map((s, i) => {
    const baseItem = (!usaHeredado && heredadoList[i]) ? heredadoList[i] : null;
    return setupCardHtml(s, { heredado: usaHeredado, base: baseItem, origenLabel: heredado.origen });
  }).join('');

  container.querySelectorAll('[data-edit-setup]').forEach(btn => {
    btn.addEventListener('click', () => openSetupModal(btn.dataset.editSetup));
  });
  container.querySelectorAll('[data-delete-setup]').forEach(btn => {
    btn.addEventListener('click', () => deleteSetup(btn.dataset.deleteSetup));
  });
  container.querySelectorAll('[data-usar-base-setup]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = heredadoList.find(x => x.id === btn.dataset.usarBaseSetup);
      if (item) openSetupModal(null, false, item);
    });
  });
}

// Dibuja el/los setup BASE de la sesión actualmente seleccionada.
function renderBaseSetups() {
  const list = getList(STORAGE_KEYS.setups).filter(s => s.pasadaKey === currentBaseKey());
  const container = document.getElementById('base-setups-list');
  const empty = document.getElementById('base-setups-empty');
  if (!container || !empty) return;

  if (list.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  container.innerHTML = list.map(s => setupCardHtml(s)).join('');

  container.querySelectorAll('[data-edit-setup]').forEach(btn => {
    btn.addEventListener('click', () => openSetupModal(btn.dataset.editSetup, true));
  });
  container.querySelectorAll('[data-delete-setup]').forEach(btn => {
    btn.addEventListener('click', () => deleteSetup(btn.dataset.deleteSetup));
  });
}

// ====================================================
// MÓDULO · TRAMOS (alta, edición, borrado y listado)
// Todo queda asociado a la pasada actual (currentPasadaKey)
// ====================================================

function openTramoModal(id = null) {
  const form = document.getElementById('form-tramo');
  form.reset();
  document.getElementById('tramo-id').value = '';
  document.getElementById('modal-tramo-title').textContent = 'Nuevo tramo';

  if (id) {
    const item = getList(STORAGE_KEYS.tramos).find(t => t.id === id);
    if (item) {
      document.getElementById('modal-tramo-title').textContent = 'Editar tramo';
      document.getElementById('tramo-id').value = item.id;
      document.getElementById('tramo-nombre').value = item.nombre || '';
      document.getElementById('tramo-tiempo').value = item.tiempo || '';
      document.getElementById('tramo-distancia').value = item.distancia || '';
      document.getElementById('tramo-posicion').value = item.posicion || '';
      document.getElementById('tramo-notas').value = item.notas || '';
    }
  }

  document.getElementById('modal-tramo').classList.remove('hidden');
}

function closeTramoModal() {
  document.getElementById('modal-tramo').classList.add('hidden');
}

function handleTramoSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('tramo-id').value;
  const data = {
    nombre: document.getElementById('tramo-nombre').value.trim(),
    tiempo: document.getElementById('tramo-tiempo').value.trim(),
    distancia: document.getElementById('tramo-distancia').value,
    posicion: document.getElementById('tramo-posicion').value.trim(),
    notas: document.getElementById('tramo-notas').value.trim()
  };

  if (!data.nombre) return;

  const list = getList(STORAGE_KEYS.tramos);

  if (id) {
    const idx = list.findIndex(t => t.id === id);
    if (idx !== -1) list[idx] = { ...list[idx], ...data };
  } else {
    data.id = 't_' + Date.now();
    data.fecha = new Date().toISOString();
    data.pasadaKey = currentPasadaKey();
    list.unshift(data);
  }

  saveList(STORAGE_KEYS.tramos, list);
  closeTramoModal();
  renderTramos();
}

function deleteTramo(id) {
  if (!confirm('¿Eliminar este tramo?')) return;
  const list = getList(STORAGE_KEYS.tramos).filter(t => t.id !== id);
  saveList(STORAGE_KEYS.tramos, list);
  renderTramos();
}

// Dibuja solo los tramos que pertenecen a la pasada actual.
function renderTramos() {
  const key = currentPasadaKey();
  const list = getList(STORAGE_KEYS.tramos).filter(t => t.pasadaKey === key);
  const container = document.getElementById('tramos-list');
  const empty = document.getElementById('tramos-empty');
  if (!container || !empty) return;

  if (list.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    empty.classList.add('flex');
    return;
  }
  empty.classList.add('hidden');
  empty.classList.remove('flex');

  container.innerHTML = list.map(t => `
    <div class="bg-white border border-gray-200 shadow-sm rounded-2xl p-5">
      <div class="flex items-start justify-between mb-3">
        <p class="font-display font-semibold text-base text-gray-900">${escapeHtml(t.nombre)}</p>
        ${t.posicion ? `<span class="badge inline-block">${escapeHtml(t.posicion)}</span>` : ''}
      </div>
      <div class="grid grid-cols-2 gap-3 text-sm mb-4">
        <div>
          <p class="text-gray-600 text-xs">Tiempo</p>
          <p class="font-display font-semibold text-gray-900">${escapeHtml(t.tiempo) || '—'}</p>
        </div>
        <div>
          <p class="text-gray-600 text-xs">Distancia</p>
          <p class="font-display font-semibold text-gray-900">${t.distancia ? t.distancia + ' km' : '—'}</p>
        </div>
      </div>
      ${t.notas ? `<p class="text-xs text-gray-600 mb-4">${escapeHtml(t.notas)}</p>` : ''}
      <div class="flex gap-2 pt-3 border-t border-gray-100">
        <button data-edit-tramo="${t.id}" class="flex-1 text-xs font-medium py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition">Editar</button>
        <button data-delete-tramo="${t.id}" class="flex-1 text-xs font-medium py-2 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition">Eliminar</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-edit-tramo]').forEach(btn => {
    btn.addEventListener('click', () => openTramoModal(btn.dataset.editTramo));
  });
  container.querySelectorAll('[data-delete-tramo]').forEach(btn => {
    btn.addEventListener('click', () => deleteTramo(btn.dataset.deleteTramo));
  });
}

// ====================================================
// EXPORTAR RESUMEN A PDF (descargar / compartir)
// ====================================================

// Arma el documento PDF con todo el contenido de la solapa Resumen
// de la competencia actual: por sesión, cada pasada con datos, y sus
// neumáticos/setup/tramos (marcando qué se heredó y qué cambió).
function construirResumenPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  // Si el plugin jsPDF-AutoTable llegó a cargar, dibujamos los datos
  // en cuadros con bordes. Si no (ej: sin internet), el PDF se arma
  // igual pero con el listado en texto plano de siempre.
  const usarTablas = typeof doc.autoTable === 'function';

  const margenX = 40;
  const anchoUtil = doc.internal.pageSize.getWidth() - margenX * 2;
  const altoPagina = doc.internal.pageSize.getHeight();
  let y = 50;

  function saltoSiHaceFalta(alturaNecesaria) {
    if (y + alturaNecesaria > altoPagina - 40) {
      doc.addPage();
      y = 50;
    }
  }

  function escribir(texto, opciones = {}) {
    const tamano = opciones.tamano || 10;
    const negrita = !!opciones.negrita;
    const color = opciones.color || [17, 24, 39];
    const sangria = opciones.sangria || 0;
    const espacio = opciones.espacio !== undefined ? opciones.espacio : 4;

    doc.setFont('helvetica', negrita ? 'bold' : 'normal');
    doc.setFontSize(tamano);
    doc.setTextColor(color[0], color[1], color[2]);

    const lineas = doc.splitTextToSize(texto, anchoUtil - sangria);
    lineas.forEach(linea => {
      saltoSiHaceFalta(tamano * 1.4);
      doc.text(linea, margenX + sangria, y);
      y += tamano * 1.4;
    });
    y += espacio;
  }

  const comp = getList(STORAGE_KEYS.competencias).find(c => c.id === navState.competenciaId);
  if (!comp) return doc;

  escribir('RALLYOPS', { tamano: 12, negrita: true, color: [230, 73, 27], espacio: 2 });
  escribir(comp.nombre || 'Competencia', { tamano: 18, negrita: true, espacio: 2 });
  escribir(
    `${comp.piloto ? 'Piloto: ' + comp.piloto : 'Sin piloto'}${comp.fecha ? '   ·   ' + formatFecha(comp.fecha) : ''}`,
    { tamano: 10, color: [75, 85, 99], espacio: 16 }
  );

  const compId = comp.id;
  const prefix = compId + '::';
  const neumaticos = getList(STORAGE_KEYS.neumaticos).filter(n => (n.pasadaKey || '').startsWith(prefix));
  const setups = getList(STORAGE_KEYS.setups).filter(s => (s.pasadaKey || '').startsWith(prefix));
  const tramos = getList(STORAGE_KEYS.tramos).filter(t => (t.pasadaKey || '').startsWith(prefix));

  // Cada pasada con datos arranca en una hoja nueva. La primera
  // pasada de todas sigue en la misma página que el encabezado (para
  // no dejar una hoja en blanco al principio del PDF).
  let primeraPaginaDePasada = true;

  SESIONES.forEach(ses => {
    const pasadasConDatos = [];
    for (let n = 1; n <= 10; n++) {
      const key = pasadaKey(compId, ses, n);
      const nOwn = neumaticos.filter(x => x.pasadaKey === key);
      const sOwn = setups.filter(x => x.pasadaKey === key);
      const tDePasada = tramos.filter(x => x.pasadaKey === key);
      if (nOwn.length || sOwn.length || tDePasada.length) {
        pasadasConDatos.push({ n, nOwn, sOwn, tDePasada });
      }
    }

    if (pasadasConDatos.length === 0) {
      saltoSiHaceFalta(30);
      escribir(ses.toUpperCase(), { tamano: 13, negrita: true, color: [194, 65, 12], espacio: 6 });
      escribir('Sin datos cargados todavía.', { tamano: 9, color: [107, 114, 128], espacio: 12 });
      return;
    }

    pasadasConDatos.forEach(p => {
      if (!primeraPaginaDePasada) {
        doc.addPage();
        y = 50;
      }
      primeraPaginaDePasada = false;

      const neumHeredado = efectivoAnteriorPara(STORAGE_KEYS.neumaticos, compId, ses, p.n);
      const setupHeredado = efectivoAnteriorPara(STORAGE_KEYS.setups, compId, ses, p.n);
      const usaHeredadoNeum = p.nOwn.length === 0 && neumHeredado.list.length > 0;
      const listaNeum = p.nOwn.length > 0 ? p.nOwn : neumHeredado.list;
      const usaHeredadoSetup = p.sOwn.length === 0 && setupHeredado.list.length > 0;
      const listaSetup = p.sOwn.length > 0 ? p.sOwn : setupHeredado.list;

      escribir(ses.toUpperCase(), { tamano: 13, negrita: true, color: [194, 65, 12], espacio: 4 });
      escribir(`Pasada ${p.n}`, { tamano: 11, negrita: true, espacio: 3 });

      if (listaNeum.length) {
        escribir('Neumáticos' + (usaHeredadoNeum ? ` (heredado de ${neumHeredado.origen})` : ''), { tamano: 9, negrita: true, color: [75, 85, 99], sangria: 8, espacio: 2 });

        if (usarTablas) {
          const filasConCambios = [];
          const filas = listaNeum.map((n, i) => {
            const base = (!usaHeredadoNeum && neumHeredado.list[i]) ? neumHeredado.list[i] : null;
            const cambios = base ? diffCampos(n, base, NEUMATICO_DIFF_FIELDS) : [];
            filasConCambios.push(cambios.length > 0);
            const notasCambios = [n.notas, cambios.length ? `Cambió: ${cambios.join(', ')}` : ''].filter(Boolean).join(' — ');
            return [
              n.marca ? `${n.codigo} (${n.marca})` : n.codigo,
              n.compuesto,
              n.posicion,
              n.estado,
              `${n.presionDelFrio || '—'} / ${n.presionDelCaliente || '—'}`,
              `${n.presionTrasFrio || '—'} / ${n.presionTrasCaliente || '—'}`,
              n.uso || '—',
              notasCambios
            ];
          });
          doc.autoTable({
            startY: y,
            margin: { left: margenX, right: margenX },
            head: [['Código', 'Compuesto', 'Posición', 'Estado', 'Del. frío/cal.', 'Tras. frío/cal.', 'Uso', 'Notas / cambios']],
            body: filas,
            theme: 'grid',
            styles: { fontSize: 7.5, cellPadding: 4, textColor: [55, 65, 81], lineColor: [229, 231, 235] },
            headStyles: { fillColor: [230, 73, 27], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
            columnStyles: { 7: { cellWidth: 110 } },
            didParseCell: (data) => {
              if (data.section === 'body' && filasConCambios[data.row.index]) {
                data.cell.styles.fillColor = [255, 237, 224];
              }
            }
          });
          y = doc.lastAutoTable.finalY + 10;
        } else {
          listaNeum.forEach((n, i) => {
            const base = (!usaHeredadoNeum && neumHeredado.list[i]) ? neumHeredado.list[i] : null;
            const presionTexto = [
              n.presionDelFrio ? 'Del. frío ' + n.presionDelFrio : '',
              n.presionDelCaliente ? 'Del. caliente ' + n.presionDelCaliente : '',
              n.presionTrasFrio ? 'Tras. frío ' + n.presionTrasFrio : '',
              n.presionTrasCaliente ? 'Tras. caliente ' + n.presionTrasCaliente : ''
            ].filter(Boolean).join(', ');
            escribir(`- ${n.codigo}${n.marca ? ' (' + n.marca + ')' : ''} — ${n.compuesto}, ${n.posicion}${presionTexto ? ', Presión: ' + presionTexto + ' bar' : ''}${n.uso ? ', Uso: ' + n.uso : ''}`, { tamano: 9, sangria: 14, espacio: 1 });
            if (n.notas) escribir(`Notas: ${n.notas}`, { tamano: 8.5, color: [107, 114, 128], sangria: 18, espacio: 1 });
            if (base) {
              const cambios = diffCampos(n, base, NEUMATICO_DIFF_FIELDS);
              if (cambios.length) escribir(`Cambió: ${cambios.join(', ')}`, { tamano: 8.5, color: [194, 65, 12], sangria: 18, espacio: 2 });
            }
          });
          y += 2;
        }
      }

      if (listaSetup.length) {
        escribir('Setup' + (usaHeredadoSetup ? ` (heredado de ${setupHeredado.origen})` : ''), { tamano: 9, negrita: true, color: [75, 85, 99], sangria: 8, espacio: 2 });

        listaSetup.forEach((s, i) => {
          const base = (!usaHeredadoSetup && setupHeredado.list[i]) ? setupHeredado.list[i] : null;
          const cambios = base ? cambiosSetupTexto(s, base) : [];

          saltoSiHaceFalta(16);
          escribir(`${s.nombre} (${s.superficie})`, { tamano: 9.5, negrita: true, sangria: 8, espacio: 1 });
          if (cambios.length) escribir(`Cambió: ${cambios.join(', ')}`, { tamano: 8, color: [194, 65, 12], sangria: 8, espacio: 2 });

          if (usarTablas) {
            const grupos = [
              ['Amortiguador Delantero', 'Amort. Del.', SETUP_AMORT_FIELDS, s.amortDel],
              ['Amortiguador Trasero', 'Amort. Tras.', SETUP_AMORT_FIELDS, s.amortTras],
              ['Diferencial Delantero', 'Dif. Del.', SETUP_DIF_FIELDS, s.difDel],
              ['Diferencial Trasero', 'Dif. Tras.', SETUP_DIF_FIELDS, s.difTras]
            ];
            let algoCargado = false;

            grupos.forEach(([titulo, abrev, campos, valores]) => {
              if (!valores) return;
              const items = campos
                .filter(([, clave]) => valores[clave])
                .map(([, clave, label]) => ({ label, valor: valores[clave], matchKey: `${label} (${abrev})` }));
              if (items.length === 0) return;
              algoCargado = true;

              saltoSiHaceFalta(30);
              doc.setFont('helvetica', 'bold');
              doc.setFontSize(8.5);
              doc.setTextColor(107, 114, 128);
              doc.text(titulo, margenX + 8, y + 8.5);
              y += 8.5 + 3;

              const filasTabla = [];
              const matchTabla = [];
              for (let j = 0; j < items.length; j += 2) {
                const a = items[j];
                const b = items[j + 1];
                filasTabla.push([a.label, a.valor, b ? b.label : '', b ? b.valor : '']);
                matchTabla.push([a.matchKey, a.matchKey, b ? b.matchKey : '', b ? b.matchKey : '']);
              }

              doc.autoTable({
                startY: y,
                margin: { left: margenX, right: margenX },
                head: [['Descripción', 'Valor', 'Descripción', 'Valor']],
                body: filasTabla,
                theme: 'grid',
                styles: { fontSize: 7.5, cellPadding: 4, textColor: [55, 65, 81], lineColor: [229, 231, 235] },
                headStyles: { fillColor: [55, 65, 81], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
                columnStyles: { 0: { minCellWidth: 105 }, 2: { minCellWidth: 105 } },
                didParseCell: (data) => {
                  if (data.section !== 'body') return;
                  const key = matchTabla[data.row.index][data.column.index];
                  if (key && cambios.includes(key)) {
                    data.cell.styles.fillColor = [255, 237, 224];
                  }
                }
              });
              y = doc.lastAutoTable.finalY + 12;
            });

            if (s.notas) escribir(`Notas: ${s.notas}`, { tamano: 8.5, color: [107, 114, 128], sangria: 8, espacio: 2 });
            if (!algoCargado && !s.notas) {
              escribir('Sin detalle cargado.', { tamano: 8.5, color: [156, 163, 175], sangria: 8, espacio: 8 });
            }
          } else {
            [
              grupoSetupDetalleTexto('Amort. Delantero', SETUP_AMORT_FIELDS, s.amortDel),
              grupoSetupDetalleTexto('Amort. Trasero', SETUP_AMORT_FIELDS, s.amortTras),
              grupoSetupDetalleTexto('Dif. Delantero', SETUP_DIF_FIELDS, s.difDel),
              grupoSetupDetalleTexto('Dif. Trasero', SETUP_DIF_FIELDS, s.difTras)
            ].filter(Boolean).forEach(linea => escribir(linea, { tamano: 8.5, color: [55, 65, 81], sangria: 18, espacio: 1 }));
            if (s.notas) escribir(`Notas: ${s.notas}`, { tamano: 8.5, color: [107, 114, 128], sangria: 18, espacio: 1 });
            y += 4;
          }
        });
        y += 2;
      }

      if (p.tDePasada.length) {
        escribir('Tramos', { tamano: 9, negrita: true, color: [75, 85, 99], sangria: 8, espacio: 2 });

        if (usarTablas) {
          const filas = p.tDePasada.map(t => [
            t.nombre,
            t.tiempo || '—',
            t.distancia ? t.distancia + ' km' : '—',
            t.posicion || '—',
            t.notas || ''
          ]);
          doc.autoTable({
            startY: y,
            margin: { left: margenX, right: margenX },
            head: [['Tramo', 'Tiempo', 'Distancia', 'Posición', 'Notas']],
            body: filas,
            theme: 'grid',
            styles: { fontSize: 7.5, cellPadding: 4, textColor: [55, 65, 81], lineColor: [229, 231, 235] },
            headStyles: { fillColor: [230, 73, 27], textColor: 255, fontStyle: 'bold', fontSize: 7.5 }
          });
          y = doc.lastAutoTable.finalY + 10;
        } else {
          p.tDePasada.forEach(t => {
            escribir(`- ${t.nombre} — ${t.tiempo || '—'}${t.distancia ? ', ' + t.distancia + ' km' : ''}${t.posicion ? ', ' + t.posicion : ''}`, { tamano: 9, sangria: 14, espacio: 1 });
            if (t.notas) escribir(`Notas: ${t.notas}`, { tamano: 8.5, color: [107, 114, 128], sangria: 18, espacio: 1 });
          });
        }
      }

      y += 6;
    });

    y += 6;
  });

  return doc;
}

// Arma un nombre de archivo legible a partir del nombre de la competencia.
function nombreArchivoResumen() {
  const comp = getList(STORAGE_KEYS.competencias).find(c => c.id === navState.competenciaId);
  const base = comp ? comp.nombre : 'competencia';
  const slug = base.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'resumen';
  return `rallyops-${slug}-resumen.pdf`;
}

function descargarResumenPDF() {
  if (!window.jspdf) { alert('No se pudo cargar el generador de PDF. Revisá tu conexión a internet e intentá de nuevo.'); return; }
  const doc = construirResumenPDF();
  doc.save(nombreArchivoResumen());
}

// Comparte el PDF usando la Web Share API (si el navegador lo permite),
// lo que abre el selector nativo del sistema para elegir WhatsApp,
// Correo, Drive, etc. Si no está disponible, descarga el PDF y avisa
// que hay que adjuntarlo a mano.
async function compartirResumenPDF() {
  if (!window.jspdf) { alert('No se pudo cargar el generador de PDF. Revisá tu conexión a internet e intentá de nuevo.'); return; }
  const doc = construirResumenPDF();
  const blob = doc.output('blob');
  const archivo = new File([blob], nombreArchivoResumen(), { type: 'application/pdf' });

  if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
    try {
      await navigator.share({
        files: [archivo],
        title: 'Resumen RallyOps',
        text: 'Resumen de la competencia'
      });
    } catch (err) {
      // El usuario canceló el share, o falló silenciosamente: no hacemos nada más.
    }
  } else {
    alert('Tu navegador no permite compartir archivos directamente. Se descargó el PDF: adjuntalo manualmente en WhatsApp o en tu correo.');
    descargarResumenPDF();
  }
}

// Muestra el botón "Compartir" solo si el navegador soporta compartir
// archivos (Web Share API con adjuntos). Si no, queda oculto y solo
// se ofrece la descarga.
function actualizarDisponibilidadCompartir() {
  const btn = document.getElementById('btn-compartir-pdf');
  if (!btn) return;
  let soportado = false;
  try {
    if (navigator.canShare) {
      const prueba = new File(['x'], 'prueba.pdf', { type: 'application/pdf' });
      soportado = navigator.canShare({ files: [prueba] });
    }
  } catch (e) {
    soportado = false;
  }
  btn.classList.toggle('hidden', !soportado);
  btn.classList.toggle('flex', soportado);
}

// ====================================================
// LOGIN / REGISTRO / CERRAR SESIÓN (solo si Firebase está listo)
// ====================================================

// 'login' o 'registro': qué pestaña está activa en la pantalla de inicio.
let authModo = 'login';

function actualizarTabsAuth() {
  document.querySelectorAll('[data-auth-tab]').forEach(btn => {
    btn.classList.toggle('modulo-tab-active', btn.dataset.authTab === authModo);
  });
  const btnSubmit = document.getElementById('auth-submit-btn');
  if (btnSubmit) btnSubmit.textContent = authModo === 'login' ? 'Iniciar sesión' : 'Crear cuenta';
  const errorEl = document.getElementById('auth-error');
  if (errorEl) errorEl.classList.add('hidden');
}

function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errorEl = document.getElementById('auth-error');
  errorEl.classList.add('hidden');

  const accion = authModo === 'login'
    ? auth.signInWithEmailAndPassword(email, password)
    : auth.createUserWithEmailAndPassword(email, password);

  accion.catch(err => {
    errorEl.textContent = traducirErrorAuth(err);
    errorEl.classList.remove('hidden');
  });
}

// Traduce los códigos de error de Firebase Auth a mensajes en español,
// entendibles para alguien que no programa.
function traducirErrorAuth(err) {
  const mapa = {
    'auth/invalid-email': 'El email no es válido.',
    'auth/user-not-found': 'No existe una cuenta con ese email.',
    'auth/wrong-password': 'Contraseña incorrecta.',
    'auth/email-already-in-use': 'Ya existe una cuenta con ese email.',
    'auth/weak-password': 'La contraseña tiene que tener al menos 6 caracteres.',
    'auth/invalid-credential': 'Email o contraseña incorrectos.',
    'auth/too-many-requests': 'Demasiados intentos. Esperá un momento y probá de nuevo.',
    'auth/network-request-failed': 'Sin conexión a internet.'
  };
  return mapa[err.code] || 'Ocurrió un error. Intentá de nuevo.';
}

function enviarResetPassword() {
  const email = document.getElementById('auth-email').value.trim();
  if (!email) {
    alert('Escribí tu email arriba y volvé a tocar el link.');
    return;
  }
  auth.sendPasswordResetEmail(email)
    .then(() => alert('Te enviamos un email para restablecer tu contraseña.'))
    .catch(err => alert(traducirErrorAuth(err)));
}

function cerrarSesion() {
  if (!auth) return;
  auth.signOut();
}

// ====================================================
// BACKUP: exportar todo a un archivo JSON / restaurarlo
// Sirve como respaldo manual y para mover datos entre
// dispositivos (además de la sincronización con Firebase).
// ====================================================

function descargarBackup() {
  const backup = {
    app: 'rallyops',
    version: 1,
    exportado: new Date().toISOString(),
    datos: {
      competencias: getList(STORAGE_KEYS.competencias),
      neumaticos: getList(STORAGE_KEYS.neumaticos),
      setups: getList(STORAGE_KEYS.setups),
      tramos: getList(STORAGE_KEYS.tramos)
    }
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fecha = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `rallyops-backup-${fecha}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Agrega a `key` los elementos de `listaImportada` que no existan
// todavía (comparando por id), sin tocar ni duplicar lo que ya hay.
function combinarLista(key, listaImportada) {
  const actual = getList(key);
  const idsActuales = new Set(actual.map(x => x.id));
  const nuevos = (listaImportada || []).filter(x => x && x.id && !idsActuales.has(x.id));
  saveList(key, actual.concat(nuevos));
}

function restaurarBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    let backup;
    try {
      backup = JSON.parse(e.target.result);
    } catch (err) {
      alert('El archivo no es un backup válido de RallyOps.');
      return;
    }
    const datos = backup && backup.datos;
    if (!datos || !Array.isArray(datos.competencias)) {
      alert('El archivo no es un backup válido de RallyOps.');
      return;
    }

    const reemplazar = confirm(
      '¿Cómo querés restaurar este backup?\n\n' +
      'Aceptar = REEMPLAZAR todos los datos actuales por los del archivo.\n' +
      'Cancelar = COMBINAR: agrega lo que falte sin borrar lo que ya tenés.'
    );

    if (reemplazar) {
      saveList(STORAGE_KEYS.competencias, datos.competencias || []);
      saveList(STORAGE_KEYS.neumaticos, datos.neumaticos || []);
      saveList(STORAGE_KEYS.setups, datos.setups || []);
      saveList(STORAGE_KEYS.tramos, datos.tramos || []);
    } else {
      combinarLista(STORAGE_KEYS.competencias, datos.competencias);
      combinarLista(STORAGE_KEYS.neumaticos, datos.neumaticos);
      combinarLista(STORAGE_KEYS.setups, datos.setups);
      combinarLista(STORAGE_KEYS.tramos, datos.tramos);
    }

    alert('Backup restaurado correctamente.');
    navState.competenciaId = null;
    navState.sesion = null;
    navState.pasada = null;
    showScreen('screen-competencias');
    renderCompetencias();
  };
  reader.readAsText(file);
}

// --------------------------------------------------
// ARRANQUE DE LA APP
// --------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  if (FIREBASE_LISTO) {
    // La pantalla inicial (login o Mis Competencias) la decide
    // onAuthStateChanged, más abajo, apenas Firebase sepa si hay
    // sesión activa o no.
    showScreen('screen-auth');
  } else {
    initStorage();
    renderCompetencias();
    showScreen('screen-competencias');
  }
  actualizarDisponibilidadCompartir();

  // Login / registro (solo si Firebase está configurado)
  if (FIREBASE_LISTO) {
    const formAuth = document.getElementById('form-auth');
    if (formAuth) formAuth.addEventListener('submit', handleAuthSubmit);
    document.querySelectorAll('[data-auth-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        authModo = btn.dataset.authTab;
        actualizarTabsAuth();
      });
    });
    actualizarTabsAuth();

    auth.onAuthStateChanged(user => {
      currentUser = user;
      if (user) {
        iniciarSincronizacion(user.uid);
        navState.competenciaId = null;
        navState.sesion = null;
        navState.pasada = null;
        navState.vista = 'resumen';
        showScreen('screen-competencias');
        renderCompetencias();
      } else {
        detenerSincronizacion();
        cloudCache = { competencias: [], neumaticos: [], setups: [], tramos: [] };
        showScreen('screen-auth');
      }
    });
  }

  // Backup: restaurar desde archivo JSON
  const inputBackup = document.getElementById('input-restaurar-backup');
  if (inputBackup) {
    inputBackup.addEventListener('change', (e) => {
      const file = e.target.files[0];
      restaurarBackup(file);
      e.target.value = '';
    });
  }

  // Formulario de competencias
  const formCompetencia = document.getElementById('form-competencia');
  if (formCompetencia) formCompetencia.addEventListener('submit', handleCompetenciaSubmit);
  const modalCompetencia = document.getElementById('modal-competencia');
  if (modalCompetencia) {
    modalCompetencia.addEventListener('click', (e) => {
      if (e.target === modalCompetencia) closeCompetenciaModal();
    });
  }

  // Tabs de tipo de sesión (Test / Shakedown / Race)
  document.querySelectorAll('.sesion-tab').forEach(btn => {
    btn.addEventListener('click', () => selectSesion(btn.dataset.sesion));
  });

  // Tabs de módulo dentro de una pasada (Neumáticos / Setup / Tramos)
  document.querySelectorAll('.modulo-tab[data-modulo]').forEach(btn => {
    btn.addEventListener('click', () => showModulo(btn.dataset.modulo));
  });

  // Tabs de vista dentro de una competencia (Resumen / Pasadas)
  document.querySelectorAll('[data-vista]').forEach(btn => {
    btn.addEventListener('click', () => selectVista(btn.dataset.vista));
  });

  // Formulario de neumáticos
  const formNeumatico = document.getElementById('form-neumatico');
  if (formNeumatico) formNeumatico.addEventListener('submit', handleNeumaticoSubmit);
  const modalNeumatico = document.getElementById('modal-neumatico');
  if (modalNeumatico) {
    modalNeumatico.addEventListener('click', (e) => {
      if (e.target === modalNeumatico) closeNeumaticoModal();
    });
  }

  // Formulario de setup
  const formSetup = document.getElementById('form-setup');
  if (formSetup) formSetup.addEventListener('submit', handleSetupSubmit);
  const modalSetup = document.getElementById('modal-setup');
  if (modalSetup) {
    modalSetup.addEventListener('click', (e) => {
      if (e.target === modalSetup) closeSetupModal();
    });
  }

  // Formulario de tramos
  const formTramo = document.getElementById('form-tramo');
  if (formTramo) formTramo.addEventListener('submit', handleTramoSubmit);
  const modalTramo = document.getElementById('modal-tramo');
  if (modalTramo) {
    modalTramo.addEventListener('click', (e) => {
      if (e.target === modalTramo) closeTramoModal();
    });
  }
});
