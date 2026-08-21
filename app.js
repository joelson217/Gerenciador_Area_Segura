// ============================================
// ÁREA SEGURA PRO - PWA GERENCIADOR MOBILE & DESKTOP
// Versão: 2.0.0 Pro Enterprise
// ============================================

// --- Configuração da API (Edge Function) ---
// O app nunca mais fala direto com a tabela do banco. Toda operação sensível
// (gerar chave de licença, comando remoto, dados de clientes) passa por uma
// Supabase Edge Function que guarda os segredos só no servidor.
const SUPABASE_PROJECT_URL = 'https://inndgkbugwegrkbvogew.supabase.co';
const LICENSE_API_URL = `${SUPABASE_PROJECT_URL}/functions/v1/license-api`;
// Backend ISOLADO do AreaSegura2 (tabela licencas2, separada da licencas das
// 40 máquinas reais) - usado só pra mostrar os alertas de senha bloqueada/
// trocada da máquina de testes, sem mexer em nada do que já está em produção.
const LICENSE_API_V2_URL = `${SUPABASE_PROJECT_URL}/functions/v1/license-api-v2`;
const PIN_SALT = '@AreaSegura_Salt_2026!';

function getAdminToken() {
  const token = localStorage.getItem('area_segura_admin_token');
  if (!token) {
    showToast('Configure o Token de Administrador em Ajustes antes de fazer isso.', 'warning');
  }
  return token || '';
}

function saveAdminTokenFromSettings() {
  const input = document.getElementById('admin-token-input');
  const token = input?.value.trim() || '';
  if (!token) {
    showToast('Cole o token antes de salvar.', 'warning');
    return;
  }
  localStorage.setItem('area_segura_admin_token', token);
  if (input) input.value = '';
  renderAdminTokenStatus();
  showToast('Token de administrador salvo neste aparelho.', 'success');
}

// Portão de ativação do aparelho: só quem digita o Token de Administrador
// correto consegue avançar. Sem isso, qualquer pessoa que abrisse a URL
// base do Gerenciador (ex: apagando a parte "?u=..." do link de um
// cliente) conseguia criar seu próprio PIN e "entrar" no painel.
async function submitActivation() {
  const input = document.getElementById('activation-token-input');
  const errorEl = document.getElementById('activation-error');
  const token = input?.value.trim() || '';

  if (!token) {
    if (errorEl) errorEl.textContent = 'Digite o token de administrador.';
    return;
  }

  const result = await callLicenseApi('admin-verify', { admin_token: token });
  if (result.error || !result.ok) {
    if (errorEl) errorEl.textContent = 'Token incorreto. Este painel é de uso exclusivo do administrador.';
    if (input) { input.value = ''; input.focus(); }
    return;
  }

  localStorage.setItem('area_segura_admin_token', token);
  document.getElementById('activation-screen')?.classList.remove('active');
  renderAdminTokenStatus();
  initialSyncPromise = syncFromCloud();
  fetchCloudStatuses();
  checkV2SecurityAlerts();
  showLockScreen('setup');
}

function renderAdminTokenStatus() {
  const statusEl = document.getElementById('admin-token-status');
  if (!statusEl) return;
  const hasToken = !!localStorage.getItem('area_segura_admin_token');
  statusEl.textContent = hasToken ? 'Token configurado neste aparelho.' : 'Nenhum token configurado ainda.';
  statusEl.style.color = hasToken ? 'var(--accent-green)' : 'var(--text-muted)';
}

async function callLicenseApi(action, payload = {}) {
  try {
    const res = await fetch(LICENSE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await res.json();
    // Token de admin salvo estava errado/expirado: limpa e avisa em UM lugar
    // só, pra não ficar preso silenciosamente em loop de erro em toda chamada.
    if (data && data.error === 'não autorizado' && payload.admin_token) {
      localStorage.removeItem('area_segura_admin_token');
      showToast('Token de administrador incorreto. Toque em qualquer ação de novo para digitar o certo.', 'error');
    }
    return data;
  } catch (e) {
    return { error: 'offline' };
  }
}

async function callLicenseApiV2(action, payload = {}) {
  try {
    const res = await fetch(LICENSE_API_V2_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload })
    });
    return await res.json();
  } catch (e) {
    return { error: 'offline' };
  }
}

// --- Alertas de segurança do Área Segura 2 (senha bloqueada por tentativas
// erradas / senha trocada) - mostrados como um aviso destacado assim que o
// Gerenciador é aberto ou atualizado, pra não depender de e-mail/push (ainda
// não existe canal pra isso). Guarda no aparelho qual foi o último evento já
// visto de cada máquina, pra não ficar repetindo o mesmo alerta pra sempre -
// mas um evento NOVO (data/hora diferente) sempre aparece de novo.
function getV2AlertsSeen() {
  try { return JSON.parse(localStorage.getItem('areaSegura2AlertsSeen') || '{}'); }
  catch (e) { return {}; }
}
function saveV2AlertsSeen(seen) {
  localStorage.setItem('areaSegura2AlertsSeen', JSON.stringify(seen));
}
function dismissV2Alert(hwId, field) {
  const seen = getV2AlertsSeen();
  seen[hwId] = seen[hwId] || {};
  seen[hwId][field] = window.__v2AlertValues?.[hwId]?.[field] || true;
  saveV2AlertsSeen(seen);
  checkV2SecurityAlerts();
}

async function checkV2SecurityAlerts() {
  if (!localStorage.getItem('area_segura_admin_token')) return;
  const result = await callLicenseApiV2('admin-list', { admin_token: getAdminToken() });
  const maquinas = result?.maquinas || [];
  const seen = getV2AlertsSeen();
  const now = new Date();
  const alerts = [];
  window.__v2AlertValues = window.__v2AlertValues || {};
  // Guarda por hardware_id pra renderMachineList saber quais máquinas já
  // migraram - sem isso, o card de uma máquina migrada continuava mostrando
  // (ou parando de mostrar, depois da correção de "sem contato") o status do
  // Área Segura ANTIGO, sem nenhum jeito de saber pelo Gerenciador que ela
  // já está no Área Segura 2.
  window.__v2MachinesByHwId = {};
  maquinas.forEach(m => { window.__v2MachinesByHwId[m.hardware_id] = m; });

  maquinas.forEach(m => {
    const hwId = m.hardware_id;
    const label = m.nome_maquina ? `${m.nome_maquina} (${hwId})` : hwId;
    window.__v2AlertValues[hwId] = window.__v2AlertValues[hwId] || {};

    if (m.senha_bloqueada_ate) {
      const ate = new Date(m.senha_bloqueada_ate);
      if (ate > now && seen[hwId]?.senha_bloqueada_ate !== m.senha_bloqueada_ate) {
        window.__v2AlertValues[hwId].senha_bloqueada_ate = m.senha_bloqueada_ate;
        alerts.push({
          hwId, field: 'senha_bloqueada_ate', type: 'blocked',
          text: `🔒 ${label}: senha BLOQUEADA por tentativas erradas até ${ate.toLocaleString('pt-BR')}. Só você pode desbloquear ou trocar a senha pelo Gerenciador.`
        });
      }
    }
    if (m.senha_alterada_em && seen[hwId]?.senha_alterada_em !== m.senha_alterada_em) {
      window.__v2AlertValues[hwId].senha_alterada_em = m.senha_alterada_em;
      alerts.push({
        hwId, field: 'senha_alterada_em', type: 'changed',
        text: `🔑 ${label}: a senha foi trocada em ${new Date(m.senha_alterada_em).toLocaleString('pt-BR')}.`
      });
    }
  });

  renderV2SecurityAlerts(alerts);
  if (typeof currentPage !== 'undefined' && currentPage === 'machines') renderMachineList();
}

// Só o admin, com o token deste Gerenciador, consegue mandar esses dois
// comandos - vão pra fila `comando_remoto` do AreaSeguraService (que só ele
// lê, protegido pelo admin_token no backend), nunca pelo cano local que o
// painel do aluno usa.
async function unlockV2Machine(hwId) {
  const r = await callLicenseApiV2('command', { hardware_id: hwId, comando: 'UNLOCK', admin_token: getAdminToken() });
  if (r?.ok) { showToast('Desbloqueio enviado - aplica no próximo contato da máquina com a internet.', 'success'); }
  else { showToast('Não consegui enviar o desbloqueio.', 'error'); }
}
async function setPasswordV2Machine(hwId) {
  const novaSenha = prompt('Nova senha para esta máquina (fica valendo assim que ela conectar):');
  if (!novaSenha) return;
  const r = await callLicenseApiV2('command', { hardware_id: hwId, comando: `SETPASS|${novaSenha}`, admin_token: getAdminToken() });
  if (r?.ok) { showToast('Nova senha enviada - aplica no próximo contato da máquina com a internet.', 'success'); }
  else { showToast('Não consegui enviar a nova senha.', 'error'); }
}

function renderV2SecurityAlerts(alerts) {
  const box = document.getElementById('v2-security-alerts');
  if (!box) return;
  if (!alerts.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'flex';
  box.innerHTML = alerts.map(a => `
    <div class="v2-alert-item ${a.type === 'changed' ? 'v2-alert-changed' : ''}">
      <span class="v2-alert-text">${a.text}</span>
      <div style="display:flex; gap:6px; flex-shrink:0;">
        ${a.type === 'blocked' ? `<button class="v2-alert-dismiss" onclick="unlockV2Machine('${a.hwId}')">Desbloquear</button>` : ''}
        <button class="v2-alert-dismiss" onclick="setPasswordV2Machine('${a.hwId}')">Trocar senha</button>
        <button class="v2-alert-dismiss" onclick="dismissV2Alert('${a.hwId}','${a.field}')">Dispensar</button>
      </div>
    </div>
  `).join('');
}

// --- Estado da Aplicação ---
let DB = [];
let selectedClient = null;
let cloudStatuses = {};
let currentPage = 'dashboard';
// Hardware IDs cujo campo de nome/número está aberto pra edição no momento
// (só em memória - fecha sozinho depois de salvar ou ao trocar de página).
let editingNameFor = new Set();

// Controle de Força Bruta no PIN
let failedPinAttempts = 0;
let pinLockoutUntil = 0;
let pinLockoutTimer = null;

// ============================================
// Licenciamento e Comandos Remotos (via Edge Function)
// ============================================
// A chave de ativação agora é gerada e assinada no servidor — o segredo
// nunca chega ao navegador. Chamar isto também persiste a licença no banco.
async function getActivationKey(hardwareId, expirationDate) {
  const api = isV2Machine(hardwareId) ? callLicenseApiV2 : callLicenseApi;
  const result = await api('activate', {
    hardware_id: hardwareId,
    expiration_date: expirationDate,
    admin_token: getAdminToken()
  });
  if (result.error) showToast(`Erro ao gerar chave: ${result.error}`, 'error');
  return result.chave_ativacao || '';
}

async function fetchCloudStatuses() {
  const result = await callLicenseApi('admin-sync', { admin_token: getAdminToken() });
  if (result.error) return;
  cloudStatuses = {};
  (result.statuses || []).forEach(r => { cloudStatuses[r.hardware_id] = r; });
}

// Decide se uma máquina já está rodando o Área Segura 2 - mesma regra de
// "quem falou com o servidor por último" usada no card da lista
// (renderMachineList). Comandos (Congelar/Descongelar/Revogar/Desinstalar)
// e renovação de licença têm que ir pro backend certo: uma máquina já
// migrada só lê comando_remoto/chave da tabela nova (licencas2, via
// license-api-v2) - mandar pra tabela antiga (licencas) nunca chegava nela,
// mesmo a chamada "dando certo" e mostrando "enviado!" no Gerenciador.
function isV2Machine(hwId) {
  const v2Raw = window.__v2MachinesByHwId?.[hwId] || null;
  if (!v2Raw) return false;
  const cloud = cloudStatuses[hwId] || {};
  const v1LastSyncMs = cloud.ultima_sincronizacao ? new Date(cloud.ultima_sincronizacao).getTime() : NaN;
  const v2LastSyncMs = v2Raw.ultima_sincronizacao ? new Date(v2Raw.ultima_sincronizacao).getTime() : NaN;
  return isNaN(v1LastSyncMs) || (!isNaN(v2LastSyncMs) && v2LastSyncMs >= v1LastSyncMs);
}

// Retorna true/false - quem chama usa isso pra contar quantas máquinas
// realmente receberam o comando, em vez de sempre dizer "enviado!" mesmo
// quando a chamada falhou (token errado, offline etc.) sem avisar ninguém.
async function sendSupabaseCommand(hwId, cmd) {
  const api = isV2Machine(hwId) ? callLicenseApiV2 : callLicenseApi;
  const result = await api('command', { hardware_id: hwId, comando: cmd, admin_token: getAdminToken() });
  return !result.error;
}

// Dispara o mesmo comando pra várias máquinas e conta o que realmente deu
// certo - usado por todas as ações em lote (Congelar/Descongelar/Revogar/
// Desinstalar/Atualizar/Migrar) pra dar um retorno preciso, não genérico.
async function sendCommandToSelected(selected, cmd, successMsgFn) {
  startSyncWatch(selected);
  // Em lotes pequenos, não tudo de uma vez - com dezenas de máquinas
  // selecionadas, disparar tudo junto sobrecarregava a Edge Function e
  // fazia boa parte das chamadas falhar (visto primeiro na renovação de
  // licença em lote, mesmo problema aqui).
  const BATCH_SIZE = 6;
  const results = [];
  for (let i = 0; i < selected.length; i += BATCH_SIZE) {
    const batch = selected.slice(i, i + BATCH_SIZE);
    results.push(...await Promise.all(batch.map(hwId => sendSupabaseCommand(hwId, cmd))));
  }
  const okCount = results.filter(Boolean).length;
  const failCount = results.length - okCount;
  if (okCount > 0) { showToast(successMsgFn(okCount), 'success'); }
  if (failCount > 0) {
    showToast(`Não consegui enviar o comando pra ${failCount} máquina(s) - confira o token de administrador e a conexão, e tente de novo.`, 'error');
  }
}

// ============================================
// Banco de Dados Local & Nuvem
// ============================================
function loadDB() {
  const saved = localStorage.getItem('area_segura_db');
  if (saved) {
    try { DB = JSON.parse(saved); } catch (e) { DB = []; }
  }
  if (!Array.isArray(DB) || DB.length === 0) {
    // Só um placeholder local pra tela não ficar vazia enquanto o
    // syncFromCloud() ainda não respondeu. NUNCA salva na nuvem aqui —
    // fazer isso sobrescreveria os clientes reais com esse placeholder
    // sempre que o app abrisse com o armazenamento local vazio (foi
    // exatamente isso que apagou o Teste2 e o Casa).
    DB = [
      {
        "Id": "83089473-cad9-48aa-af20-c06fa6b0b693",
        "Instituicao": "Laboratório Modelo",
        "Responsavel": "Administrador",
        "Localidade": "Sede Principal",
        "Contato": "(81) 99999-9999",
        "Ambientes": ["Lab Principal"],
        "Maquinas": [],
        "NomeExibicao": "Laboratório Modelo",
        "CorAlerta": "White"
      }
    ];
    localStorage.setItem('area_segura_db', JSON.stringify(DB));
  }
}

// Enquanto a primeira sincronização com a nuvem não termina, o DB local pode
// estar incompleto (placeholder ou versão antiga) — esperar evita que um
// save nesse meio-tempo sobrescreva os clientes reais na nuvem.
let initialSyncPromise = null;

// Retorna true/false pra quem chama poder saber se REALMENTE terminou de
// salvar na nuvem antes de dizer "sucesso" pro usuário - sem isso, uma ação
// podia mostrar "salvo!" mesmo quando a sincronização falhou por trás
// (offline, token errado etc.), e a mudança sumia depois sem explicação.
async function saveDB() {
  if (initialSyncPromise) {
    await initialSyncPromise;
    initialSyncPromise = null;
  }
  localStorage.setItem('area_segura_db', JSON.stringify(DB));

  // Sincronizar banco de dados para a nuvem (só admin, via Edge Function)
  const result = await callLicenseApi('admin-save-db', { db: DB, admin_token: getAdminToken() });
  if (result.error) {
    console.error('Erro ao salvar backup na nuvem:', result.error);
    if (result.error !== 'não autorizado') {
      showToast('Não foi possível sincronizar com a nuvem (offline?). A alteração ficou salva só neste aparelho por enquanto.', 'warning');
    }
    return false;
  }
  return true;
}

async function syncFromCloud() {
  const result = await callLicenseApi('admin-sync', { admin_token: getAdminToken() });
  if (result.error) return;

  const cloudDB = result.db_backup;
  if (Array.isArray(cloudDB) && cloudDB.length > 0) {
    if (DB.length === 0 || JSON.stringify(DB) !== JSON.stringify(cloudDB)) {
      DB = cloudDB;
      localStorage.setItem('area_segura_db', JSON.stringify(DB));
      if (currentPage === 'dashboard') renderDashboard();
      else if (currentPage === 'clients') renderClientList();
    }
  }

  // Carregar status reais das máquinas
  cloudStatuses = {};
  (result.statuses || []).forEach(r => {
    cloudStatuses[r.hardware_id] = r;
  });
  // Máquinas novas (hardware_id que ainda não está em nenhum cliente) NÃO são
  // mais anexadas automaticamente a nenhum cliente - isso ficava jogando pro
  // primeiro cliente da lista, o que embaralha o controle quando existe mais
  // de um cliente. Elas ficam "soltas" e aparecem no banner de pendentes pra
  // o admin escolher manualmente pra qual cliente cada uma vai (ver
  // renderPendingMachinesBanner / authorizeAndActivate).

  if (currentPage === 'dashboard') renderDashboard();
  else if (currentPage === 'machines') renderMachineList();
}

// ============================================
// Navegação
// ============================================
function navigateTo(page, data) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');

  const backBtn = document.querySelector('.header-back');
  if (page === 'detail' || page === 'machines') {
    backBtn.classList.add('active');
  } else {
    backBtn.classList.remove('active');
  }

  if (page === 'dashboard') renderDashboard();
  else if (page === 'clients') renderClientList();
  else if (page === 'detail') {
    if (data) selectedClient = data;
    renderClientDetail();
  }
  else if (page === 'machines') {
    if (data) selectedClient = data;
    renderMachines();
  }
  else if (page === 'expiring') renderExpiringReport();
  else if (page === 'settings') renderSettings();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goBack() {
  if (currentPage === 'machines') {
    navigateTo('detail');
  } else if (currentPage === 'detail') {
    navigateTo('clients');
  } else {
    navigateTo('dashboard');
  }
}

// ============================================
// Renderizar Dashboard
// ============================================
function getDashboardStats() {
  let totalClients = DB.length;
  let totalMachines = 0;
  let expiringMachines = 0;
  let okMachines = 0;

  const now = new Date();
  const thirtyDaysAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  DB.forEach(c => {
    if (c.Maquinas && Array.isArray(c.Maquinas)) {
      totalMachines += c.Maquinas.length;
      c.Maquinas.forEach(m => {
        if (m.DataExpiracao) {
          const exp = new Date(m.DataExpiracao);
          if (exp <= thirtyDaysAhead) {
            expiringMachines++;
          } else {
            okMachines++;
          }
        }
      });
    }
  });

  return { totalClients, totalMachines, expiringMachines, okMachines };
}

function renderDashboard() {
  const stats = getDashboardStats();
  document.getElementById('stat-clients').textContent = stats.totalClients;
  document.getElementById('stat-machines').textContent = stats.totalMachines;
  document.getElementById('stat-expiring').textContent = stats.expiringMachines;
  document.getElementById('stat-ok').textContent = stats.okMachines;

  renderPendingMachinesBanner();

  const recentList = document.getElementById('recent-clients');
  if (!recentList) return;
  recentList.innerHTML = '';

  const recent = DB.slice(0, 5);
  if (recent.length === 0) {
    recentList.innerHTML = '<div class="empty-state"><div class="empty-state-text">Nenhum cliente cadastrado ainda.</div></div>';
    return;
  }

  recent.forEach(c => {
    const card = document.createElement('div');
    card.className = 'client-card';
    const totalMaq = c.Maquinas ? c.Maquinas.length : 0;
    card.innerHTML = `
      <div class="client-card-header">
        <span class="client-card-name">${escapeHtml(c.Instituicao || 'Sem Nome')}</span>
        <span class="client-card-tag">${totalMaq} máquina(s)</span>
      </div>
      <div class="client-card-meta">
        <span><svg class="icon"><use href="#icon-map-pin"/></svg> ${escapeHtml(c.Localidade || 'Não informada')}</span>
        <span><svg class="icon"><use href="#icon-user"/></svg> ${escapeHtml(c.Responsavel || 'Não informado')}</span>
      </div>
    `;
    card.onclick = () => navigateTo('detail', c);
    recentList.appendChild(card);
  });
}

// Acha em qual cliente (se algum) uma máquina já está cadastrada.
function findClientOwning(hwId) {
  return DB.find(c => c.Maquinas && c.Maquinas.some(m => m.HardwareID === hwId)) || null;
}

// Banner de Novas Máquinas Detectadas
function renderPendingMachinesBanner() {
  const banner = document.getElementById('pending-machines-banner');
  if (!banner) return;

  const pendingHwIds = Object.keys(cloudStatuses).filter(hwId => {
    const st = cloudStatuses[hwId];
    return st && st.status_protecao === 'PENDENTE';
  });

  if (pendingHwIds.length === 0) {
    banner.innerHTML = '';
    return;
  }

  // Máquina nova não pertence a nenhum cliente até o admin escolher - por
  // isso cada linha tem um seletor de cliente (pré-marcado com o cliente
  // aberto na tela, se houver um, mas trocável). "Autorizar e Ativar" só
  // gera a chave DEPOIS de garantir que a máquina está anexada ao cliente
  // escolhido - nunca mais cai sozinha no primeiro cliente da lista.
  const defaultExp = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const clientOptions = DB.map(c =>
    `<option value="${escapeHtml(c.Id)}" ${selectedClient && selectedClient.Id === c.Id ? 'selected' : ''}>${escapeHtml(c.Instituicao || 'Sem Nome')}</option>`
  ).join('');

  const rows = pendingHwIds.map(hwId => {
    const inputId = `pending-exp-${hwId.replace(/[^a-zA-Z0-9]/g, '')}`;
    const selectId = `pending-client-${hwId.replace(/[^a-zA-Z0-9]/g, '')}`;
    const owner = findClientOwning(hwId);

    const clientPicker = owner
      ? `<span style="font-size:11px; color:var(--text-secondary);">Cliente: <strong>${escapeHtml(owner.Instituicao || 'Sem Nome')}</strong></span>`
      : DB.length > 0
        ? `<select id="${selectId}" class="detail-input" style="padding:4px 6px; font-size:12px; width:auto;">${clientOptions}</select>`
        : `<span style="font-size:11px; color:var(--accent-orange);">Cadastre um cliente antes de autorizar</span>`;

    return `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0; border-top:1px solid rgba(245, 158, 11, 0.25); flex-wrap:wrap;">
      <code style="font-size:12px; color:var(--text-primary);">${escapeHtml(hwId)}</code>
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        ${clientPicker}
        <input type="date" id="${inputId}" value="${defaultExp}" class="detail-input" style="padding:4px 6px; font-size:12px; width:auto;">
        <button class="btn-small-action" style="background:var(--accent-orange); color:#0F172A; font-weight:700; flex-shrink:0;" ${DB.length === 0 ? 'disabled' : ''} onclick="authorizeAndActivate('${escapeHtml(hwId)}', '${inputId}', ${owner ? 'null' : `'${selectId}'`})">
          <svg class="icon"><use href="#icon-check-circle"/></svg> Autorizar e Ativar
        </button>
      </div>
    </div>
  `;
  }).join('');

  banner.innerHTML = `
    <div class="pending-alert-card" style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 10px; padding: 14px; margin-bottom: 16px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
        <span style="font-weight:700; color:var(--accent-orange); font-size:13px; display:inline-flex; align-items:center; gap:6px;"><svg class="icon"><use href="#icon-alert-triangle"/></svg> ${pendingHwIds.length} Novo(s) Computador(es) Detectado(s)</span>
      </div>
      <p style="font-size:12px; color:var(--text-secondary); margin-bottom:4px;">Escolha o cliente, a validade, e autorize - com internet, o computador ativa sozinho:</p>
      ${rows}
    </div>
  `;
}

// ============================================
// Lista de Clientes
// ============================================
function renderClientList(query = '') {
  const container = document.getElementById('client-list-container');
  if (!container) return;
  container.innerHTML = '';

  const q = query.toLowerCase().trim();
  const filtered = DB.filter(c => {
    if (!q) return true;
    return (
      (c.Instituicao && c.Instituicao.toLowerCase().includes(q)) ||
      (c.Localidade && c.Localidade.toLowerCase().includes(q)) ||
      (c.Responsavel && c.Responsavel.toLowerCase().includes(q)) ||
      (c.Contato && c.Contato.toLowerCase().includes(q))
    );
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-text">Nenhum cliente encontrado.</div></div>';
    return;
  }

  filtered.forEach(c => {
    const card = document.createElement('div');
    card.className = 'client-card';
    const totalMaq = c.Maquinas ? c.Maquinas.length : 0;
    card.innerHTML = `
      <div class="client-card-header">
        <span class="client-card-name">${escapeHtml(c.Instituicao || 'Sem Nome')}</span>
        <span class="client-card-tag">${totalMaq} máquina(s)</span>
      </div>
      <div class="client-card-meta">
        <span><svg class="icon"><use href="#icon-map-pin"/></svg> ${escapeHtml(c.Localidade || 'Não informada')}</span>
        <span><svg class="icon"><use href="#icon-user"/></svg> ${escapeHtml(c.Responsavel || 'Não informado')}</span>
        ${c.Contato ? `<span><svg class="icon"><use href="#icon-phone"/></svg> ${escapeHtml(c.Contato)}</span>` : ''}
      </div>
    `;
    card.onclick = () => navigateTo('detail', c);
    container.appendChild(card);
  });
}

// ============================================
// Detalhes do Cliente & Portal Exclusivo
// ============================================
function renderClientDetail() {
  if (!selectedClient) return;

  const instInput = document.getElementById('detail-instituicao');
  const locInput = document.getElementById('detail-localidade');
  const respInput = document.getElementById('detail-responsavel');
  const contInput = document.getElementById('detail-contato');

  if (instInput) instInput.value = selectedClient.Instituicao || '';
  if (locInput) locInput.value = selectedClient.Localidade || '';
  if (respInput) respInput.value = selectedClient.Responsavel || '';
  if (contInput) contInput.value = selectedClient.Contato || '';

  // Portal do Cliente
  const pUserInput = document.getElementById('detail-portal-user');
  const pPassInput = document.getElementById('detail-portal-pass');
  const pLinkInput = document.getElementById('detail-portal-link');
  const pBadge = document.getElementById('portal-status-badge');

  if (pUserInput) pUserInput.value = selectedClient.PortalUser || '';
  if (pPassInput) pPassInput.value = selectedClient.PortalPass || '';

  // Portal roda num projeto Cloudflare separado, com domínio próprio, sem
  // nenhum código nem dado do Gerenciador admin junto — não tem "meu link"
  // pra ninguém achar apagando parte da URL.
  const PORTAL_BASE_URL = 'https://acesso-portal.joelson217.workers.dev';
  const portalKey = selectedClient.PortalUser || selectedClient.Id;
  const portalUrl = `${PORTAL_BASE_URL}/?u=${encodeURIComponent(portalKey)}`;
  if (pLinkInput) pLinkInput.value = portalUrl;

  if (pBadge) {
    pBadge.style.display = selectedClient.PortalUser ? 'inline-block' : 'none';
  }

  // Ambientes / Laboratórios
  renderAmbientes();

  // Contador de máquinas
  const maqCountEl = document.getElementById('detail-maq-count');
  const total = selectedClient.Maquinas ? selectedClient.Maquinas.length : 0;
  if (maqCountEl) maqCountEl.textContent = `${total} máquina(s) cadastrada(s)`;
}

function toggleClientAccordion() {
  const content = document.getElementById('client-accordion-content');
  const chevron = document.getElementById('client-accordion-chevron');
  if (!content) return;
  
  if (content.style.display === 'none') {
    content.style.display = 'block';
    if (chevron) chevron.textContent = '▲';
  } else {
    content.style.display = 'none';
    if (chevron) chevron.textContent = '▼';
  }
}

async function saveClientDetails() {
  if (!selectedClient) return;

  selectedClient.Instituicao = document.getElementById('detail-instituicao')?.value.trim() || selectedClient.Instituicao;
  selectedClient.Localidade = document.getElementById('detail-localidade')?.value.trim() || '';
  selectedClient.Responsavel = document.getElementById('detail-responsavel')?.value.trim() || '';
  selectedClient.Contato = document.getElementById('detail-contato')?.value.trim() || '';

  const pUser = document.getElementById('detail-portal-user')?.value.trim().toLowerCase().replace(/\s+/g, '_') || '';
  const pPass = document.getElementById('detail-portal-pass')?.value.trim() || '';

  selectedClient.PortalUser = pUser;
  selectedClient.PortalPass = pPass;

  if (await saveDB()) { showToast('Dados do cliente atualizados com sucesso!', 'success'); }
  renderClientDetail();
}

function copyClientPortalLink() {
  const linkInput = document.getElementById('detail-portal-link');
  if (linkInput && linkInput.value) {
    navigator.clipboard.writeText(linkInput.value).then(() => {
      showToast('Link do portal copiado!', 'success');
    }).catch(() => {
      linkInput.select();
      document.execCommand('copy');
      showToast('Link copiado!', 'success');
    });
  }
}

function shareClientPortalWhatsApp() {
  if (!selectedClient) return;
  const link = document.getElementById('detail-portal-link')?.value || '';
  const pass = selectedClient.PortalPass || 'Sem senha definida';
  const user = selectedClient.PortalUser || selectedClient.Id;

  const msg = `🔐 *ÁREA SEGURA PRO - ACESSO AO PORTAL*\n\nOlá! Segue seu link de acesso exclusivo para gerenciamento das máquinas do laboratório *${selectedClient.Instituicao}*:\n\n🔗 *Link Direto:* ${link}\n👤 *Usuário:* ${user}\n🔑 *Senha:* ${pass}\n\nGuarde estas credenciais com segurança.`;
  const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}

// Ambientes / Laboratórios
function renderAmbientes() {
  const container = document.getElementById('detail-ambientes-container');
  if (!container || !selectedClient) return;
  container.innerHTML = '';

  const ambientes = selectedClient.Ambientes || ['Lab Principal'];
  const grid = document.createElement('div');
  grid.style.display = 'flex';
  grid.style.flexWrap = 'wrap';
  grid.style.gap = '8px';

  ambientes.forEach(amb => {
    const count = (selectedClient.Maquinas || []).filter(m => m.Laboratorio === amb).length;
    const tag = document.createElement('div');
    tag.className = 'client-card-tag';
    tag.style.padding = '6px 12px';
    tag.style.display = 'flex';
    tag.style.alignItems = 'center';
    tag.style.gap = '6px';
    tag.innerHTML = `
      <span><svg class="icon"><use href="#icon-building"/></svg> ${escapeHtml(amb)}</span>
      <strong style="color:var(--accent-blue);">(${count} PCs)</strong>
      <button class="btn-small-action" style="padding:4px 10px; background:var(--accent-red-bg); border:1px solid var(--accent-red); color:var(--accent-red); border-radius:6px; display:flex; align-items:center; gap:4px;" onclick="deleteAmbiente('${escapeHtml(amb).replace(/'/g, "\\'")}')" title="Excluir ambiente" aria-label="Excluir ambiente">
        <svg class="icon" style="width:1em; height:1em;"><use href="#icon-trash"/></svg> Excluir
      </button>
    `;
    grid.appendChild(tag);
  });

  container.appendChild(grid);
}

async function showAddAmbienteModal() {
  const name = await showPromptModal('Digite o nome do novo Ambiente / Laboratório (ex: Lab 02, Biblioteca, Sala 10):', '', 'Novo Ambiente');
  if (name) {
    if (!selectedClient.Ambientes) selectedClient.Ambientes = ['Lab Principal'];
    if (!selectedClient.Ambientes.includes(name)) {
      selectedClient.Ambientes.push(name);
      if (await saveDB()) { showToast(`Ambiente "${name}" adicionado!`, 'success'); }
      renderAmbientes();
    } else {
      showToast(`Já existe um ambiente chamado "${name}".`, 'warning');
    }
  }
}

async function deleteAmbiente(amb) {
  if (!selectedClient) return;
  const count = (selectedClient.Maquinas || []).filter(m => m.Laboratorio === amb).length;
  if (count > 0) {
    showToast(`Não é possível excluir: ${count} máquina(s) ainda estão em "${amb}". Mova-as para outro ambiente primeiro.`, 'warning');
    return;
  }
  if (await showConfirmModal(`Excluir o ambiente "${amb}"?`, 'Excluir Ambiente')) {
    selectedClient.Ambientes = (selectedClient.Ambientes || []).filter(a => a !== amb);
    if (selectedClient.Ambientes.length === 0) selectedClient.Ambientes = ['Lab Principal'];
    if (await saveDB()) { showToast(`Ambiente "${amb}" excluído!`, 'success'); }
    renderAmbientes();
  }
}

// ============================================
// Gerenciamento de Máquinas
// ============================================
function renderMachines() {
  if (!selectedClient) return;

  // Atualizar filtro de ambientes
  const filterSelect = document.getElementById('filter-ambiente');
  if (filterSelect) {
    filterSelect.innerHTML = '<option value="">Todos os Ambientes</option>';
    const ambientes = selectedClient.Ambientes || ['Lab Principal'];
    ambientes.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      filterSelect.appendChild(opt);
    });
  }

  renderMachineList();
}

// O agente v1 avisa o servidor a cada ~5s enquanto está rodando (ver o timer
// de fundo no AreaSegura.ps1) - então 3 minutos sem notícia já é um sinal
// forte de que ele não está mais respondendo (computador desligado, sem
// internet, ou o programa não existe mais na máquina). Sem isso, o card só
// repetia o último status conhecido pra sempre - podia dizer "Congelado,
// Protegido" de uma máquina que na verdade não tem mais nada rodando.
const MACHINE_STALE_MS = 3 * 60 * 1000;

function formatRelativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (isNaN(then.getTime())) return null;
  const diffMs = Date.now() - then.getTime();
  if (diffMs < 60000) return 'agora mesmo';
  const m = Math.floor(diffMs / 60000);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  return `há ${d} dia${d > 1 ? 's' : ''}`;
}

function renderMachineList() {
  const container = document.getElementById('machines-list');
  if (!container || !selectedClient) return;
  // A sincronização automática (a cada 15s) chama esta função de novo -
  // sem isto, o innerHTML = '' abaixo recria os checkboxes zerados e
  // qualquer máquina marcada pelo admin "desmarcava sozinha" alguns
  // segundos depois, no meio de uma ação.
  const previouslySelected = new Set(getSelectedHwIds());
  // Mesmo motivo do previouslySelected acima: preserva o que o admin ainda
  // está digitando no campo de nome/número da máquina caso a sincronização
  // automática (15s) recrie a lista no meio da digitação.
  const previousNameDrafts = {};
  container.querySelectorAll('.machine-name-input').forEach(inp => {
    previousNameDrafts[inp.dataset.hwid] = inp.value;
  });
  container.innerHTML = '';

  const filterAmb = document.getElementById('filter-ambiente')?.value || '';
  const searchQ = (document.getElementById('search-machine')?.value || '').toLowerCase().trim();

  const machines = (selectedClient.Maquinas || []).filter(m => {
    if (filterAmb && m.Laboratorio !== filterAmb) return false;
    if (searchQ && !m.HardwareID.toLowerCase().includes(searchQ) && !(m.NomeExibicao || '').toLowerCase().includes(searchQ)) return false;
    return true;
  });

  if (machines.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-text">Nenhuma máquina encontrada neste ambiente.</div></div>';
    updateSelectCount();
    return;
  }

  const syncWatch = getSyncWatch();

  machines.forEach(m => {
    const cloud = cloudStatuses[m.HardwareID] || {};
    const v2MachineRaw = window.__v2MachinesByHwId?.[m.HardwareID] || null;

    // "V2 existe" não quer dizer "V2 é quem está rodando agora" - se a
    // máquina foi reinstalada com o Área Segura antigo depois de uma
    // tentativa de migração anterior (com ou sem sucesso), o registro v2
    // pode ser um resto velho enquanto o v1 está de novo vivo e mandando
    // notícia fresca. Decide pelo que falou com o servidor por ÚLTIMO, não
    // por "qual tabela tem uma linha" - senão o card fica preso mostrando
    // um fantasma de uma tentativa antiga e escondendo o progresso real.
    const v1LastSyncMs = cloud.ultima_sincronizacao ? new Date(cloud.ultima_sincronizacao).getTime() : NaN;
    const v2LastSyncMsRaw = v2MachineRaw?.ultima_sincronizacao ? new Date(v2MachineRaw.ultima_sincronizacao).getTime() : NaN;
    const v2Machine = (v2MachineRaw && (isNaN(v1LastSyncMs) || (!isNaN(v2LastSyncMsRaw) && v2LastSyncMsRaw >= v1LastSyncMs))) ? v2MachineRaw : null;

    let badgeClass, statusIcon, statusLabel;

    if (v2Machine) {
      // Assim que uma máquina aparece na tabela v2 (primeiro check-in do
      // serviço novo, depois do reinício), o card passa a mostrar o status
      // dela, não mais o do Área Segura antigo - que a essa altura já foi
      // removido de propósito e nunca mais vai falar com este sistema.
      const v2Status = v2Machine.status_protecao || 'DESCONHECIDO';
      const v2LastSync = v2Machine.ultima_sincronizacao || null;
      const v2LastSyncMs = v2LastSync ? new Date(v2LastSync).getTime() : NaN;
      const v2Stale = !isNaN(v2LastSyncMs) && (Date.now() - v2LastSyncMs) > MACHINE_STALE_MS;

      if (v2Stale) {
        badgeClass = 'status-error';
        statusIcon = 'icon-alert-triangle';
        statusLabel = `Área Segura 2 - sem contato ${formatRelativeTime(v2LastSync)}`;
      } else if (v2Status === 'CONGELADO') {
        badgeClass = 'status-v2';
        statusIcon = 'icon-snowflake';
        statusLabel = 'Área Segura 2 - Protegido (Congelado)';
      } else if (v2Status === 'PENDENTE') {
        badgeClass = 'status-pending';
        statusIcon = 'icon-hourglass';
        statusLabel = 'Área Segura 2 - Pendente de Ativação';
      } else if (v2Status.startsWith('ATUALIZACAO_ERRO')) {
        badgeClass = 'status-error';
        statusIcon = 'icon-alert-triangle';
        statusLabel = `Falha ao atualizar o Área Segura 2: ${escapeHtml(v2Status.replace('ATUALIZACAO_ERRO:', '').trim())}`;
      } else if (v2Status.startsWith('ATUALIZANDO2:')) {
        badgeClass = 'status-pending';
        statusIcon = 'icon-hourglass';
        statusLabel = `Atualizando Área Segura 2: ${escapeHtml(v2Status.replace('ATUALIZANDO2:', '').trim())}`;
      } else if (v2Status === 'DESCONGELADO') {
        // Cor diferente do "Protegido" de propósito - descongelado precisa
        // saltar aos olhos igual já acontece pro Área Segura antigo, senão
        // parece que está tudo protegido igual quando na verdade não está.
        badgeClass = 'status-thawed';
        statusIcon = 'icon-flame';
        statusLabel = 'Área Segura 2 - Descongelado';
      } else {
        badgeClass = 'status-v2';
        statusIcon = 'icon-check-circle';
        statusLabel = `Área Segura 2 - ${escapeHtml(v2Status)}`;
      }
    } else {

    const status = cloud.status_protecao || 'DESCONHECIDO';
    const isFrozen = status === 'CONGELADO';
    const isPending = status === 'PENDENTE';
    const isUnavailable = status === 'INDISPONIVEL';
    // Vem do AreaSegura.ps1 (agente antigo, ao receber o comando) e depois do
    // Instalar2.exe -Silent (que assume a partir de "iniciando instalador") -
    // reporta cada etapa da migração pro Gerenciador, exatamente pra não
    // ficar cega em qual passo travou (ver Sync-StatusToCloud/MIGRATE2 no
    // AreaSegura.ps1 e Sync-MigrationStatus no Instalar2.ps1).
    const isMigrationError = status.startsWith('MIGRACAO2:ERRO');
    const isMigrated = status.startsWith('MIGRACAO2:CONCLUIDA');
    const isMigrating = status.startsWith('MIGRACAO2:') && !isMigrationError && !isMigrated;
    // Mesma lógica pro comando "Atualizar Executável" - antes uma falha aqui
    // (rede, antivírus segurando o arquivo) não aparecia em lugar nenhum.
    const isUpdateError = status.startsWith('ATUALIZACAO_ERRO');
    // "Sem contato" pesa mais que o status congelado/descongelado antigo -
    // ver MACHINE_STALE_MS acima. Não se aplica a uma migração concluída:
    // depois que uma máquina migra pro Área Segura 2 com sucesso, é normal
    // e esperado ela nunca mais falar com este sistema antigo de novo.
    const lastSyncIso = cloud.ultima_sincronizacao || null;
    const lastSyncMs = lastSyncIso ? new Date(lastSyncIso).getTime() : NaN;
    const isStale = !isMigrated && !isNaN(lastSyncMs) && (Date.now() - lastSyncMs) > MACHINE_STALE_MS;

    badgeClass = 'status-thawed';
    statusIcon = 'icon-flame';
    statusLabel = 'Descongelado';
    if (isUpdateError) {
      badgeClass = 'status-error';
      statusIcon = 'icon-alert-triangle';
      statusLabel = `Falha ao atualizar o executável: ${escapeHtml(status.replace('ATUALIZACAO_ERRO:', '').trim())}`;
    } else if (isMigrationError) {
      badgeClass = 'status-error';
      statusIcon = 'icon-alert-triangle';
      statusLabel = `Falha na migração p/ Área Segura 2: ${escapeHtml(status.replace('MIGRACAO2:', '').trim())}`;
    } else if (isMigrating) {
      badgeClass = 'status-pending';
      statusIcon = 'icon-hourglass';
      statusLabel = `Migrando p/ Área Segura 2: ${escapeHtml(status.replace('MIGRACAO2:', '').trim())}`;
    } else if (isMigrated) {
      badgeClass = 'status-frozen';
      statusIcon = 'icon-check-circle';
      statusLabel = 'Migrado para o Área Segura 2 - aguardando reiniciar';
    } else if (isStale) {
      badgeClass = 'status-error';
      statusIcon = 'icon-alert-triangle';
      statusLabel = `Sem contato ${formatRelativeTime(lastSyncIso)} - status pode estar desatualizado`;
    } else if (isFrozen) {
      badgeClass = 'status-frozen';
      statusIcon = 'icon-snowflake';
      statusLabel = 'Protegido (Congelado)';
    } else if (isPending) {
      badgeClass = 'status-pending';
      statusIcon = 'icon-hourglass';
      statusLabel = 'Pendente de Ativação';
    } else if (isUnavailable) {
      badgeClass = 'status-pending';
      statusIcon = 'icon-alert-triangle';
      statusLabel = 'Proteção Indisponível (edição do Windows)';
    }

    } // fim do else (máquina ainda não migrada / sem registro v2)

    const syncState = isSyncConfirmed(m.HardwareID, syncWatch);
    const syncBadge = syncState === null ? '' :
      syncState
        ? `<span class="machine-status-badge status-frozen"><svg class="icon"><use href="#icon-check-circle"/></svg> Confirmou</span>`
        : `<span class="machine-status-badge status-pending"><svg class="icon"><use href="#icon-hourglass"/></svg> Aguardando</span>`;

    const card = document.createElement('div');
    card.className = 'machine-card';
    card.innerHTML = `
      <div class="machine-card-header">
        <div class="machine-card-header-left">
          <input type="checkbox" class="machine-checkbox" data-hwid="${escapeHtml(m.HardwareID)}" onchange="updateSelectCount()" ${previouslySelected.has(m.HardwareID) ? 'checked' : ''}>
          <span class="machine-card-title">${escapeHtml(m.NomeExibicao || m.HardwareID)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
          <span class="machine-status-badge ${badgeClass}"><svg class="icon"><use href="#${statusIcon}"/></svg> ${statusLabel}</span>
          ${syncBadge}
        </div>
      </div>
      <div class="machine-name-row" style="margin:8px 0; display:flex; align-items:center; gap:8px;">
        ${(() => {
          const hwId = m.HardwareID;
          const currentName = (m.NomeExibicao && m.NomeExibicao !== hwId) ? m.NomeExibicao : '';
          if (editingNameFor.has(hwId)) {
            const draft = previousNameDrafts[hwId] !== undefined ? previousNameDrafts[hwId] : currentName;
            const inputId = `name-input-${hwId.replace(/[^a-zA-Z0-9]/g, '')}`;
            return `<input type="text" class="detail-input machine-name-input" id="${inputId}" data-hwid="${escapeHtml(hwId)}"
              placeholder="Nome ou número da máquina (ex: PC-12, Sala 2)"
              value="${escapeHtml(draft)}"
              onkeydown="if(event.key==='Enter') updateMachineName('${escapeHtml(hwId)}', this.value)">
              <button class="btn-small-action" style="background:var(--accent-blue); color:#fff; flex-shrink:0;" onclick="updateMachineName('${escapeHtml(hwId)}', document.getElementById('${inputId}').value)">
                <svg class="icon"><use href="#icon-save"/></svg> Salvar
              </button>`;
          }
          if (currentName) {
            return `<span style="font-size:13px; color:var(--text-primary); font-weight:600;">${escapeHtml(currentName)}</span>
              <button class="btn-small-action" onclick="startEditName('${escapeHtml(hwId)}')"><svg class="icon"><use href="#icon-pencil"/></svg> Renomear</button>`;
          }
          return `<button class="btn-small-action" onclick="startEditName('${escapeHtml(hwId)}')"><svg class="icon"><use href="#icon-pencil"/></svg> Adicionar nome/número</button>`;
        })()}
      </div>
      ${v2Machine ? `
      <div class="machine-category-row" style="margin:8px 0; display:flex; flex-wrap:wrap; gap:12px; font-size:12px; color:var(--text-secondary);">
        <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
          <input type="checkbox" ${v2Machine.block_instaladores !== false ? 'checked' : ''} onchange="setMachineCategory('${escapeHtml(m.HardwareID)}', 'INSTALADORES', this)"> Instalação de programas
        </label>
        <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
          <input type="checkbox" ${v2Machine.block_adulto !== false ? 'checked' : ''} onchange="setMachineCategory('${escapeHtml(m.HardwareID)}', 'ADULTO', this)"> Sites adultos
        </label>
        <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
          <input type="checkbox" ${v2Machine.block_jogos !== false ? 'checked' : ''} onchange="setMachineCategory('${escapeHtml(m.HardwareID)}', 'JOGOS', this)"> Jogos
        </label>
      </div>
      <div style="margin:8px 0;">
        <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; font-size:12px; font-weight:600; padding:5px 10px; border-radius:8px; background:rgba(139,92,246,0.12); border:1px solid var(--accent-purple); color:var(--accent-purple);">
          <input type="checkbox" ${v2Machine.admin_bypass === true ? 'checked' : ''} onchange="setMachineCategory('${escapeHtml(m.HardwareID)}', 'ADMIN', this)">
          🔓 Liberar Administrador
        </label>
        <div style="font-size:11px; color:var(--text-secondary); margin-top:3px;">Quando a conta usada no PC for Administrador do Windows, libera tudo automaticamente. A conta do aluno continua bloqueada normalmente.</div>
      </div>` : ''}
      <div class="machine-card-body">
        <div><strong>HWID:</strong> <code>${escapeHtml(m.HardwareID)}</code></div>
        ${v2Machine && v2Machine.hostname ? `<div><strong>Nome do Windows:</strong> ${escapeHtml(v2Machine.hostname)}</div>` : ''}
        <div><strong>Ambiente:</strong> ${escapeHtml(m.Laboratorio || 'Lab Principal')}</div>
        <div><strong>Validade:</strong> ${(!m.DataExpiracao || m.DataExpiracao === '1970-01-01') ? 'Aguardando autorização (ainda não ativada)' : m.DataExpiracao}</div>
        ${cloud.pasta_persistente && cloud.pasta_persistente !== 'Nenhuma' ? `<div><strong>Pasta Persistente:</strong> ${escapeHtml(cloud.pasta_persistente)}</div>` : ''}
        ${(() => {
          const resumo = v2Machine && v2Machine.eventos_resumo;
          if (!resumo) return '';
          const chips = [];
          if (resumo.SENHA_ADMIN) chips.push(`⚠️ ${resumo.SENHA_ADMIN} tentativa(s) de senha (7 dias)`);
          if (resumo.INSTALADOR) chips.push(`⚠️ ${resumo.INSTALADOR} instalação(ões) bloqueada(s) (7 dias)`);
          if (resumo.SITE_ADULTO) chips.push(`⚠️ ${resumo.SITE_ADULTO} tentativa(s) de site bloqueado (7 dias)`);
          if (!chips.length) return '';
          return `<div style="margin-top:6px; display:flex; flex-direction:column; gap:3px; font-size:12px; color:#b45309;">${chips.map(c => `<span>${c}</span>`).join('')}</div>`;
        })()}
      </div>
      <div class="machine-card-footer">
        <span title="${escapeHtml(cloud.ultima_sincronizacao || '')}">Último contato: ${cloud.ultima_sincronizacao ? escapeHtml(formatRelativeTime(cloud.ultima_sincronizacao)) : 'Sem dados recentes'}</span>
        <button class="btn-small-action" onclick="copyMachineKey('${escapeHtml(m.HardwareID)}', '${escapeHtml(m.DataExpiracao)}')"><svg class="icon"><use href="#icon-copy"/></svg> Copiar Chave</button>
        <button class="btn-small-action" onclick="showMachineKeyQr('${escapeHtml(m.HardwareID)}', '${escapeHtml(m.DataExpiracao)}')"><svg class="icon"><use href="#icon-qr-code"/></svg> QR</button>
        ${v2Machine ? `<button class="btn-small-action" onclick="identifyMachine('${escapeHtml(m.HardwareID)}')"><svg class="icon"><use href="#icon-monitor"/></svg> Identificar</button>` : ''}
        ${v2Machine ? `<button class="btn-small-action" onclick="showMachineEventsModal('${escapeHtml(m.HardwareID)}')"><svg class="icon"><use href="#icon-history"/></svg> Ver detalhes</button>` : ''}
      </div>
    `;
    container.appendChild(card);
  });

  updateSelectCount();
  renderSyncWatchStatus();
}

function getSelectedHwIds() {
  const checkboxes = document.querySelectorAll('.machine-checkbox:checked');
  return Array.from(checkboxes).map(cb => cb.dataset.hwid);
}

function updateSelectCount() {
  const selected = getSelectedHwIds();
  const countEl = document.getElementById('select-count');
  if (countEl) countEl.textContent = `${selected.length} selecionada(s)`;
}

// Nome/número que o admin dá pra máquina só pra reconhecer ela fisicamente
// no laboratório (ex: "PC-12") - não é enviado pro computador, fica só aqui
// no Gerenciador. Em branco, volta a mostrar o Hardware ID como título.
function startEditName(hwId) {
  editingNameFor.add(hwId);
  renderMachineList();
  // Foca o campo assim que ele aparecer na tela (o innerHTML acabou de ser
  // recriado, então o elemento antigo não existe mais).
  setTimeout(() => {
    const input = document.querySelector(`.machine-name-input[data-hwid="${CSS.escape(hwId)}"]`);
    if (input) { input.focus(); input.select(); }
  }, 0);
}

async function updateMachineName(hwId, value) {
  if (!selectedClient || !selectedClient.Maquinas) return;
  const maq = selectedClient.Maquinas.find(m => m.HardwareID === hwId);
  if (!maq) return;
  const clean = value.trim();
  maq.NomeExibicao = clean || hwId;
  const dbOk = await saveDB();
  editingNameFor.delete(hwId);
  renderMachineList();

  // Manda pro servidor também - é o que o Área Segura instalado no PC lê no
  // check-in pra mostrar o mesmo nome no painel dele (ver handleSetName).
  const result = await callLicenseApi('set-name', { hardware_id: hwId, nome_maquina: clean, admin_token: getAdminToken() });
  if (dbOk && !result.error) {
    showToast('Nome da máquina salvo!', 'success');
  } else if (result.error && result.error !== 'não autorizado') {
    showToast('Nome salvo no Gerenciador, mas não consegui avisar a máquina ainda - ela vai receber no próximo contato com a internet.', 'warning');
  }
}

function toggleSelectAll(checked) {
  document.querySelectorAll('.machine-checkbox').forEach(cb => {
    cb.checked = checked;
  });
  updateSelectCount();
}

// Mostra a chave em texto + QR Code - pensado pra máquinas sem internet:
// em vez de digitar a chave inteira no computador do cliente, um leitor de
// código de barras/QR USB (comum em labs/escolas) escaneia a tela e
// "digita" a chave sozinho, direto no campo de ativação do Área Segura.
function showActivationKeyModal(key) {
  const modal = document.getElementById('modal-activation-key');
  const textInput = document.getElementById('activation-key-modal-text');
  const qrContainer = document.getElementById('activation-key-modal-qr');
  if (!modal || !textInput || !qrContainer) return;
  textInput.value = key;
  qrContainer.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(key);
    qr.make();
    qrContainer.innerHTML = qr.createSvgTag(6, 8);
  } catch (e) {
    qrContainer.innerHTML = '<span style="color:#333;">QR indisponível</span>';
  }
  modal.style.display = 'flex';
}

// Autoriza (gera a chave real no servidor) e já ativa a máquina pendente
// com a validade escolhida pelo admin - se o computador do cliente tiver
// internet, ele mesmo detecta isso sozinho na próxima checagem, sem
// precisar copiar/colar nada.
async function authorizeAndActivate(hwId, inputId, clientSelectId) {
  const input = document.getElementById(inputId);
  const expDate = input?.value;
  if (!expDate) {
    showToast('Escolha uma data de validade.', 'warning');
    return;
  }

  // Anexa a máquina ao cliente escolhido no seletor da linha - antes disso
  // ela não pertence a nenhum cliente (ver syncFromCloud). Se já pertence a
  // algum (clientSelectId vem null), não mexe em nada.
  if (clientSelectId) {
    const select = document.getElementById(clientSelectId);
    const clientId = select?.value;
    const targetClient = DB.find(c => c.Id === clientId);
    if (!targetClient) {
      showToast('Escolha o cliente antes de autorizar.', 'warning');
      return;
    }
    if (!targetClient.Maquinas) targetClient.Maquinas = [];
    targetClient.Maquinas.push({
      Id: generateId(),
      Laboratorio: 'Lab Principal',
      HardwareID: hwId,
      DataExpiracao: expDate,
      NomeExibicao: hwId
    });
    await saveDB();
  }

  const key = await getActivationKey(hwId, expDate);
  if (!key) {
    showToast('Erro ao autorizar. Tente novamente.', 'error');
    return;
  }
  showToast(`Máquina autorizada até ${expDate}! Se estiver online, ativa sozinha em instantes.`, 'success');
  fetchCloudStatuses().then(() => {
    if (currentPage === 'machines') renderMachineList();
    renderPendingMachinesBanner();
  });
}

async function copyMachineKey(hwId, expDate) {
  // Máquinas pendentes chegam com DataExpiracao "1970-01-01" (marcador de
  // "ainda não ativada") - gerar a chave com essa data cria uma chave já
  // expirada, que o cliente não consegue usar. Nesse caso usa 1 ano a partir
  // de hoje como padrão.
  const exp = (expDate && expDate !== '1970-01-01') ? expDate : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const key = await getActivationKey(hwId, exp);
  navigator.clipboard.writeText(key).then(() => {
    showToast(`Chave copiada: ${key}`, 'success');
  }).catch(() => {
    showActivationKeyModal(key);
  });
}

async function showMachineKeyQr(hwId, expDate) {
  const exp = (expDate && expDate !== '1970-01-01') ? expDate : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const key = await getActivationKey(hwId, exp);
  showActivationKeyModal(key);
}

// Ações Remotas em Lote
async function freezeSelected() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina.', 'warning');
    return;
  }
  if (await showConfirmModal(`Deseja CONGELAR e proteger as ${selected.length} máquina(s) selecionada(s)? O sistema será bloqueado contra alterações.`, 'Congelar Máquinas')) {
    await sendCommandToSelected(selected, 'FREEZE|MANTER', n => `Comando de congelamento enviado para ${n} máquina(s)!`);
    refreshAll();
  }
}

async function thawSelected() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina.', 'warning');
    return;
  }
  if (await showConfirmModal(`Deseja DESCONGELAR as ${selected.length} máquina(s) selecionada(s)? As alterações serão mantidas.`, 'Descongelar Máquinas')) {
    await sendCommandToSelected(selected, 'THAW', n => `Comando de descongelamento enviado para ${n} máquina(s)!`);
    refreshAll();
  }
}

async function revokeSelected() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina.', 'warning');
    return;
  }
  if (await showConfirmModal(`ATENÇÃO: Deseja REVOGAR a licença das ${selected.length} máquina(s)? Elas perderão a ativação imediatamente.`, 'Revogar Licença')) {
    await sendCommandToSelected(selected, 'REVOKE', n => `Licença revogada em ${n} máquina(s)!`);
    refreshAll();
  }
}

async function uninstallSelected() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina.', 'warning');
    return;
  }
  if (await showConfirmModal(`PERIGO: Deseja DESINSTALAR COMPLETAMENTE o Área Segura nas ${selected.length} máquina(s)? Esta ação é irreversível e reiniciará os computadores.`, 'Desinstalar')) {
    await sendCommandToSelected(selected, 'UNINSTALL', n => `Comando de desinstalação enviado para ${n} máquina(s)!`);
    refreshAll();
  }
}

async function showRenewModal() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina para renovar.', 'warning');
    return;
  }

  const expDate = await showPromptModal('Digite a nova data de validade da licença (AAAA-MM-DD):', '2027-08-15', 'Renovar Licença');
  if (expDate && /^\d{4}-\d{2}-\d{2}$/.test(expDate)) {
    const cleanDate = expDate;

    // Guarda o "antes" de cada máquina (última sincronização atual) pra depois
    // saber quais já se conectaram e pegaram a validade nova, e quais ainda
    // não ligaram/não têm internet - ver renderSyncWatchStatus().
    startSyncWatch(selected);

    // Manda em lotes pequenos (não todas de uma vez) - com 36+ máquinas
    // selecionadas, disparar tudo junto (Promise.all sem limite) sobrecarrega
    // a Edge Function e boa parte das chamadas falhava silenciosamente: o
    // código sempre mostrava "Licenças renovadas!" no final, mesmo quando só
    // 1 ou 2 máquinas realmente tinham recebido a validade nova, porque não
    // conferia se cada chamada individual deu certo. Agora conta de verdade.
    const BATCH_SIZE = 6;
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async hwId => {
        const chave = await getActivationKey(hwId, cleanDate); // já persiste a licença no servidor
        if (!chave) { failCount++; return; }
        okCount++;

        // Atualizar local
        if (selectedClient && selectedClient.Maquinas) {
          const maq = selectedClient.Maquinas.find(m => m.HardwareID === hwId);
          if (maq) {
            maq.DataExpiracao = cleanDate;
            maq.ChaveGerada = chave;
          }
        }
      }));
    }

    await saveDB();
    if (okCount > 0) { showToast(`Licença renovada até ${cleanDate} em ${okCount} máquina(s)!`, 'success'); }
    if (failCount > 0) { showToast(`Falha ao renovar ${failCount} máquina(s) - confira o token e a conexão, e tente de novo nelas.`, 'error'); }
    renderMachineList();
  }
}

// ============================================
// RASTREIO DE CONFIRMAÇÃO (quem já ligou/conectou e recebeu o comando)
// ------------------------------------------------------------------
// O servidor aplica a mudança (renovação, congelar, etc.) na hora, mas cada
// máquina só "sabe" disso na próxima vez que ligar e conectar - não dá pra
// saber isso olhando só a data gravada no servidor (ela já mudou pra todas,
// ligadas ou não). O sinal real é "ultima_sincronizacao" avançar: se esse
// horário mudou depois que a gente marcou o início do rastreio, é porque a
// máquina ligou, conectou e falou com o servidor de novo nesse meio tempo.
// Guardado no localStorage (só neste navegador) porque é só um apoio visual
// pro admin acompanhar, não faz parte do controle de verdade das máquinas.
// ============================================
const SYNC_WATCH_KEY = 'areaSeguraSyncWatch';

function getSyncWatch() {
  try { return JSON.parse(localStorage.getItem(SYNC_WATCH_KEY) || 'null'); } catch (e) { return null; }
}

function saveSyncWatch(watch) {
  try { localStorage.setItem(SYNC_WATCH_KEY, JSON.stringify(watch)); } catch (e) {}
}

function clearSyncWatch() {
  try { localStorage.removeItem(SYNC_WATCH_KEY); } catch (e) {}
  renderSyncWatchStatus();
}

// Mesma máquina pode estar reportando por dois lugares diferentes (tabela
// antiga via cloudStatuses, tabela nova via __v2MachinesByHwId) - olhar
// sempre o de v1 aqui fazia o rastreio nunca "confirmar" numa máquina já
// migrada pro Área Segura 2, porque ela parou de gravar na tabela antiga há
// tempos (ficava "aguardando" pra sempre mesmo com o comando já aplicado).
function getLastSyncIso(hwId) {
  if (isV2Machine(hwId)) {
    return window.__v2MachinesByHwId?.[hwId]?.ultima_sincronizacao || null;
  }
  return (cloudStatuses[hwId] && cloudStatuses[hwId].ultima_sincronizacao) || null;
}

function startSyncWatch(hwIds) {
  const baseline = {};
  hwIds.forEach(hwId => {
    baseline[hwId] = getLastSyncIso(hwId);
  });
  saveSyncWatch({ startedAt: new Date().toISOString(), baseline });
  renderSyncWatchStatus();
}

// Botão manual: começa (ou reinicia) o rastreio pras máquinas selecionadas,
// ou pra todas do cliente atual se nada estiver marcado - útil pra rastrear
// uma mudança que já foi feita antes de existir esse recurso.
function startSyncWatchManual() {
  let hwIds = getSelectedHwIds();
  if (hwIds.length === 0) {
    if (!selectedClient || !(selectedClient.Maquinas || []).length) {
      showToast('Nenhuma máquina neste cliente para rastrear.', 'warning');
      return;
    }
    hwIds = selectedClient.Maquinas.map(m => m.HardwareID);
  }
  startSyncWatch(hwIds);
  showToast(`Rastreando confirmação em ${hwIds.length} máquina(s). Vá ligando/conectando as máquinas e acompanhe aqui.`, 'success');
}

function isSyncConfirmed(hwId, watch) {
  if (!watch || !(hwId in watch.baseline)) return null; // não está sendo rastreada
  const current = getLastSyncIso(hwId);
  if (!current) return false;
  return current !== watch.baseline[hwId];
}

function renderSyncWatchStatus() {
  const box = document.getElementById('sync-watch-summary');
  if (!box) return;
  const watch = getSyncWatch();
  if (!watch || !selectedClient) { box.style.display = 'none'; return; }

  const hwIds = Object.keys(watch.baseline).filter(id =>
    (selectedClient.Maquinas || []).some(m => m.HardwareID === id)
  );
  if (hwIds.length === 0) { box.style.display = 'none'; return; }

  const confirmed = hwIds.filter(id => isSyncConfirmed(id, watch)).length;
  const pending = hwIds.length - confirmed;

  box.style.display = 'block';
  box.innerHTML = `
    <div class="sync-watch-box">
      <span><svg class="icon"><use href="#icon-cloud"/></svg>
        Rastreio ativo: <strong>${confirmed} de ${hwIds.length}</strong> máquina(s) já confirmaram (ligaram e conectaram)
        - <strong>${pending}</strong> ainda esperando ligar/conectar na internet.
      </span>
      <button class="btn-small-action" onclick="clearSyncWatch()">Encerrar rastreio</button>
    </div>
  `;
}

// Versão atual publicada de cada agente - mandada junto no comando de
// atualização pra máquina decidir sozinha se já está em dia (ver
// UPDATE|versaoAlvo|url em AreaSegura.ps1). Atualizar aqui toda vez que uma
// versão nova for publicada - sem isso, mandar "Atualizar" de novo pra
// pegar quem ainda não recebeu reiniciaria TAMBÉM quem já está certo.
const AREA_SEGURA_V1_VERSION = '2.7.0';
// NÃO bumpar isto até o Joelson confirmar, na máquina de teste, que a
// versão beta (categorias/descongelar restrito/identificar) está tudo certo
// - só depois disso o build vira "estável" de verdade e este número sobe
// pra igualar o AREA_SEGURA_V2_BETA_VERSION, liberando o "Atualizar" em
// massa pras 44 máquinas. Até lá, continua sendo o build antigo (1.21.0),
// sem essas novidades ainda.
const AREA_SEGURA_V2_VERSION = '1.21.0';
// Versão de teste (Testar Versão (Beta)) - sempre um número ACIMA da
// estável acima, pra uma máquina em teste nunca ser sobrescrita à toa por um
// "Atualizar" em massa mandado pra todo mundo enquanto o teste ainda roda.
const AREA_SEGURA_V2_BETA_VERSION = '1.30.0';

async function showUpdateModal() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina para atualizar o executável.', 'warning');
    return;
  }

  const defaultUrl = 'https://raw.githubusercontent.com/joelson217/Gerenciador_Area_Segura/main/AreaSegura.exe';
  const url = await showPromptModal(`URL do novo executável AreaSegura.exe (versão ${AREA_SEGURA_V1_VERSION}):`, defaultUrl, 'Atualizar Executável');
  if (url && url.startsWith('http')) {
    await sendCommandToSelected(selected, `UPDATE|${AREA_SEGURA_V1_VERSION}|${url}`, n => `Comando de atualização enviado para ${n} máquina(s) - quem já estiver na v${AREA_SEGURA_V1_VERSION} não reinicia à toa.`);
  }
}

// Testar uma versão em andamento (beta) numa ÚNICA máquina, depois que ela
// já foi atualizada normalmente pelo botão "Atualizar Área Segura 2" - fluxo
// pedido pelo Joelson pra validar uma correção nova numa máquina de teste
// antes de mandar pra todo mundo. Reaproveita o mesmo canal UPDATE2 de
// sempre, só que apontando pro pacote/versão beta (sempre um número acima da
// estável, ver AREA_SEGURA_V2_BETA_VERSION) em vez do estável.
// Antes desta função existia MIGRATE2 (migração do Área Segura antigo pro
// Área Segura 2) - não faz mais sentido hoje porque todas as máquinas já
// foram migradas e o Área Segura antigo não é mais instalado em lugar
// nenhum.
async function showTestVersionModal() {
  const selected = getSelectedHwIds();
  if (selected.length !== 1) {
    showToast('Selecione exatamente 1 máquina para testar uma versão em andamento - essa função é pra validar numa máquina só antes de mandar pra todo mundo.', 'warning');
    return;
  }
  const aviso = 'Isso vai instalar a versão de TESTE (beta) do Área Segura 2 nesta máquina, mantendo senha e proteção como estão. Ela vai reiniciar sozinha ao final. Use só na sua máquina de teste, depois de já ter atualizado ela normalmente. Confirma?';
  if (!(await showConfirmModal(aviso, 'Testar Versão (Beta)'))) return;

  const zipUrl = 'https://raw.githubusercontent.com/joelson217/Gerenciador_Area_Segura/main/AreaSegura2-beta.zip';
  // Com versão de volta no comando - já confirmado que o programa instalado
  // entende esse formato, então quem já estiver na v${AREA_SEGURA_V2_BETA_VERSION}
  // não reinstala/reinicia à toa de novo.
  await sendCommandToSelected(selected, `UPDATE2|${AREA_SEGURA_V2_BETA_VERSION}|${zipUrl}`, n => `Comando de teste enviado - quem já estiver na v${AREA_SEGURA_V2_BETA_VERSION} não reinicia à toa.`);
  refreshAll();
}

// Atualiza o Área Segura 2 já instalado (não migração - a máquina já é v2).
// Antes disso não existia jeito nenhum de corrigir um bug já instalado sem
// reinstalar fisicamente; agora reaproveita o mesmo pacote/instalador da
// migração (UPDATE2, que o AreaSeguraService.exe 1.19+ sabe processar),
// que preserva senha/estado da máquina em vez de resetar pro padrão.
async function showUpdateV2Modal() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina para atualizar.', 'warning');
    return;
  }
  const aviso = selected.length === 1
    ? 'Isso vai atualizar o Área Segura 2 já instalado nesta máquina para a versão mais recente, mantendo senha e proteção como estão. Ela vai reiniciar sozinha ao final. Confirma?'
    : `Isso vai atualizar o Área Segura 2 em ${selected.length} máquinas para a versão mais recente, mantendo senha e proteção como estão. Todas vão reiniciar sozinhas ao final. Confirma?`;
  if (!(await showConfirmModal(aviso, 'Atualizar Área Segura 2'))) return;

  const zipUrl = 'https://raw.githubusercontent.com/joelson217/Gerenciador_Area_Segura/main/AreaSegura2.zip';
  // SEM o número de versão de propósito, por enquanto: o programa que está
  // instalado em campo hoje é de ANTES de existir a checagem de versão
  // (UPDATE2|versão|url) - mandando nesse formato novo, ele lê a versão como
  // se fosse parte do endereço do arquivo e trava ("URI inválido"). Sem a
  // versão, ele entende do jeito antigo (só a URL) e funciona em qualquer
  // instalação atual, nova ou velha. Assim que TODAS as máquinas confirmarem
  // rodando essa atualização, dá pra voltar a mandar com versão (reduz
  // reinício à toa em atualizações futuras).
  await sendCommandToSelected(selected, `UPDATE2|${zipUrl}`, n => `Comando de atualização enviado para ${n} máquina(s).`);
  refreshAll();
}

// Liga/desliga uma categoria de bloqueio (Jogos/Sites adultos/Instalação de
// programas) ou o "Liberar Administrador" (categoria ADMIN) numa máquina v2
// na hora, sem descongelar a máquina inteira nem reiniciar - ver comando
// SETCAT em AreaSeguraService.ps1.
async function setMachineCategory(hwId, categoria, checkboxEl) {
  const ligado = checkboxEl.checked;
  checkboxEl.disabled = true;
  const ok = await sendSupabaseCommand(hwId, `SETCAT|${categoria}|${ligado ? '1' : '0'}`);
  checkboxEl.disabled = false;
  if (!ok) {
    checkboxEl.checked = !ligado;
    showToast('Não consegui avisar a máquina agora - confira a conexão e tente de novo.', 'error');
    return;
  }
  showToast('Categoria atualizada!', 'success');
  refreshAll();
}

// Pede pra máquina mostrar um aviso em tela cheia por alguns segundos - jeito
// de reconhecer fisicamente qual computador do laboratório é este card, sem
// precisar visitar cada máquina e ler o ID pela tecla de atalho.
async function identifyMachine(hwId) {
  const ok = await sendSupabaseCommand(hwId, 'IDENTIFY');
  if (ok) {
    showToast('Comando enviado - a tela dessa máquina vai piscar um aviso em poucos segundos (se ela estiver ligada e conectada).', 'success');
  } else {
    showToast('Não consegui avisar a máquina agora - confira a conexão e tente de novo.', 'error');
  }
}

// Abre o histórico completo de tentativas suspeitas (senha errada,
// instalador bloqueado, site adulto bloqueado) de uma máquina - o card só
// mostra um resumo dos últimos 7 dias, esse botão traz tudo.
let currentEventsModalHwId = null;

async function showMachineEventsModal(hwId) {
  const modal = document.getElementById('modal-machine-events');
  const list = document.getElementById('machine-events-modal-list');
  if (!modal || !list) return;
  currentEventsModalHwId = hwId;
  list.innerHTML = '<p style="color:var(--text-secondary); font-size:13px;">Carregando...</p>';
  modal.style.display = 'flex';

  const result = await callLicenseApiV2('list-events', { hardware_id: hwId, admin_token: getAdminToken() });
  const eventos = result?.eventos || [];
  if (!eventos.length) {
    list.innerHTML = '<p style="color:var(--text-secondary); font-size:13px;">Nenhuma tentativa registrada.</p>';
    return;
  }
  const labels = { SENHA_ADMIN: '🔒 Tentativa de senha errada', INSTALADOR: '📦 Instalador bloqueado', SITE_ADULTO: '🔞 Site adulto bloqueado' };
  list.innerHTML = eventos.map(ev => `
    <div style="border-bottom:1px solid var(--border-color, #eee); padding-bottom:6px; font-size:13px;">
      <div><strong>${escapeHtml(labels[ev.tipo] || ev.tipo)}</strong>${ev.detalhe ? ` — ${escapeHtml(ev.detalhe)}` : ''}</div>
      <div style="color:var(--text-secondary); font-size:12px;">${new Date(ev.criado_em).toLocaleString('pt-BR')}</div>
    </div>
  `).join('');
}

async function clearMachineEvents() {
  const hwId = currentEventsModalHwId;
  if (!hwId) return;
  if (!(await showConfirmModal('Deseja apagar todo o histórico de tentativas dessa máquina? Não dá pra desfazer.', 'Limpar Histórico'))) return;
  const result = await callLicenseApiV2('clear-events', { hardware_id: hwId, admin_token: getAdminToken() });
  if (result?.ok) {
    showToast('Histórico apagado.', 'success');
    await showMachineEventsModal(hwId);
    checkV2SecurityAlerts();
  } else {
    showToast('Não consegui apagar o histórico agora - confira a conexão e tente de novo.', 'error');
  }
}

async function showAddMachineModal() {
  const hwId = await showPromptModal('Digite o Hardware ID da nova máquina (ex: AS-A1B2C3D4):', '', 'Nova Máquina');
  if (hwId) {
    const cleanHw = hwId.toUpperCase();
    const amb = (await showPromptModal('Ambiente / Laboratório:', (selectedClient.Ambientes && selectedClient.Ambientes[0]) || 'Lab Principal', 'Nova Máquina')) || 'Lab Principal';
    const exp = (await showPromptModal('Data de Expiração (AAAA-MM-DD):', '2027-08-15', 'Nova Máquina')) || '2027-08-15';

    if (!selectedClient.Maquinas) selectedClient.Maquinas = [];
    selectedClient.Maquinas.push({
      Id: generateId(),
      Laboratorio: amb,
      HardwareID: cleanHw,
      DataExpiracao: exp,
      NomeExibicao: cleanHw
    });

    const chave = await getActivationKey(cleanHw, exp); // já persiste a licença no servidor
    if (chave && (await saveDB())) { showToast(`Máquina ${cleanHw} cadastrada com sucesso!`, 'success'); }
    else if (!chave) { showToast('Máquina salva no cadastro, mas não consegui gerar a chave de ativação agora - tente Renovar depois.', 'warning'); }
    renderMachineList();
  }
}

async function deleteSelectedMachines() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina para excluir do cadastro.', 'warning');
    return;
  }
  if (await showConfirmModal(`Excluir as ${selected.length} máquina(s) do cadastro deste cliente?`, 'Excluir Máquinas')) {
    selectedClient.Maquinas = (selectedClient.Maquinas || []).filter(m => !selected.includes(m.HardwareID));
    if (await saveDB()) { showToast(`${selected.length} máquina(s) removida(s) do cadastro!`, 'success'); }
    renderMachineList();
  }
}

async function showDeleteClientModal() {
  if (!selectedClient) return;
  if (await showConfirmModal(`Tem certeza de que deseja EXCLUIR o cliente "${selectedClient.Instituicao}" e todas as suas máquinas?`, 'Excluir Cliente')) {
    DB = DB.filter(c => c.Id !== selectedClient.Id);
    if (await saveDB()) { showToast('Cliente excluído com sucesso!', 'success'); }
    navigateTo('clients');
  }
}

// ============================================
// Confirmação e Prompt customizados (substituem confirm()/prompt() nativos,
// que abrem no estilo padrão do navegador e destoam do resto do app)
// ============================================
function showConfirmModal(message, title = 'Confirmar') {
  return new Promise(resolve => {
    const modal = document.getElementById('modal-confirm');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-message').textContent = message;
    const btnOk = document.getElementById('confirm-modal-ok');
    const btnCancel = document.getElementById('confirm-modal-cancel');
    const cleanup = (result) => {
      modal.style.display = 'none';
      btnOk.onclick = null;
      btnCancel.onclick = null;
      resolve(result);
    };
    btnOk.onclick = () => cleanup(true);
    btnCancel.onclick = () => cleanup(false);
    modal.style.display = 'flex';
  });
}

function showPromptModal(message, defaultValue = '', title = 'Digite') {
  return new Promise(resolve => {
    const modal = document.getElementById('modal-prompt');
    document.getElementById('prompt-modal-title').textContent = title;
    document.getElementById('prompt-modal-message').textContent = message;
    const input = document.getElementById('prompt-modal-input');
    input.value = defaultValue;
    const btnOk = document.getElementById('prompt-modal-ok');
    const btnCancel = document.getElementById('prompt-modal-cancel');
    const cleanup = (result) => {
      modal.style.display = 'none';
      btnOk.onclick = null;
      btnCancel.onclick = null;
      input.onkeydown = null;
      resolve(result);
    };
    btnOk.onclick = () => cleanup(input.value.trim());
    btnCancel.onclick = () => cleanup(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') cleanup(input.value.trim()); };
    modal.style.display = 'flex';
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

function showNewClientModal() {
  ['new-client-instituicao', 'new-client-responsavel', 'new-client-localidade', 'new-client-contato'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const modal = document.getElementById('modal-new-client');
  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('new-client-instituicao')?.focus(), 50);
  }
}

function closeNewClientModal() {
  const modal = document.getElementById('modal-new-client');
  if (modal) modal.style.display = 'none';
}

async function confirmNewClient() {
  const name = document.getElementById('new-client-instituicao')?.value.trim() || '';
  if (!name) {
    showToast('Digite o nome da instituição.', 'warning');
    document.getElementById('new-client-instituicao')?.focus();
    return;
  }
  const newClient = {
    Id: generateId(),
    Instituicao: name,
    Responsavel: document.getElementById('new-client-responsavel')?.value.trim() || '',
    Localidade: document.getElementById('new-client-localidade')?.value.trim() || '',
    Contato: document.getElementById('new-client-contato')?.value.trim() || '',
    Ambientes: ['Lab Principal'],
    Maquinas: [],
    NomeExibicao: name
  };
  DB.unshift(newClient);
  const ok = await saveDB();
  closeNewClientModal();
  if (ok) { showToast(`Cliente "${newClient.Instituicao}" criado!`, 'success'); }
  navigateTo('detail', newClient);
}

// ============================================
// Relatório de Expirando
// ============================================
function renderExpiringReport() {
  const container = document.getElementById('expiring-list');
  if (!container) return;
  container.innerHTML = '';

  const now = new Date();
  const thirtyDaysAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const expiringList = [];
  DB.forEach(c => {
    (c.Maquinas || []).forEach(m => {
      if (m.DataExpiracao) {
        const exp = new Date(m.DataExpiracao);
        if (exp <= thirtyDaysAhead) {
          expiringList.push({ client: c, machine: m, expDate: exp });
        }
      }
    });
  });

  if (expiringList.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-text"><svg class="icon"><use href="#icon-check-circle"/></svg> Todas as máquinas estão com licenças regulares em dia!</div></div>';
    return;
  }

  expiringList.sort((a, b) => a.expDate - b.expDate);

  expiringList.forEach(item => {
    const isExpired = item.expDate < now;
    const diffDays = Math.ceil((item.expDate - now) / (1000 * 60 * 60 * 24));
    
    const card = document.createElement('div');
    card.className = `client-card ${isExpired ? 'expired-card' : ''}`;
    card.style.borderLeft = `4px solid ${isExpired ? 'var(--accent-red)' : 'var(--accent-orange)'}`;
    card.innerHTML = `
      <div class="client-card-header">
        <span class="client-card-name">${escapeHtml(item.client.Instituicao)}</span>
        <span class="client-card-tag" style="color:${isExpired ? 'var(--accent-red)' : 'var(--accent-orange)'};">
          ${isExpired ? 'VENCIDA' : `${diffDays} dia(s) restante(s)`}
        </span>
      </div>
      <div class="client-card-meta">
        <span><svg class="icon"><use href="#icon-monitor"/></svg> ${escapeHtml(item.machine.NomeExibicao || item.machine.HardwareID)}</span>
        <span><svg class="icon"><use href="#icon-calendar"/></svg> Vence em: ${item.machine.DataExpiracao}</span>
      </div>
    `;
    card.onclick = () => navigateTo('machines', item.client);
    container.appendChild(card);
  });
}

// ============================================
// Segurança: PIN com Salt, Anti-Força Bruta e Biometria
// ============================================
let pinCode = '';
let lockScreenMode = 'unlock';
let tempSetupPin = '';
let biometricsAvailable = false;

async function hashPIN(pin) {
  const saltedMsg = new TextEncoder().encode(pin + PIN_SALT);
  const hashBuffer = await crypto.subtle.digest('SHA-256', saltedMsg);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function showLockScreen(mode = 'unlock') {
  lockScreenMode = mode;
  pinCode = '';
  updatePinDots();
  
  const lockEl = document.getElementById('lock-screen');
  const msgEl = document.getElementById('lock-message');
  
  if (Date.now() < pinLockoutUntil) {
    startLockoutCountdown();
  } else {
    if (mode === 'setup') {
      if (msgEl) msgEl.textContent = 'Crie seu novo PIN de 6 dígitos';
    } else if (mode === 'confirm') {
      if (msgEl) msgEl.textContent = 'Confirme o novo PIN de 6 dígitos';
    } else {
      if (msgEl) msgEl.textContent = 'Digite seu PIN de 6 dígitos';
      if (localStorage.getItem('security_bio_enabled') === 'true' && biometricsAvailable) {
        setTimeout(triggerBiometricAuth, 400);
      }
    }
  }

  if (lockEl) lockEl.classList.add('active');
}

function hideLockScreen() {
  const lockEl = document.getElementById('lock-screen');
  if (lockEl) lockEl.classList.remove('active');
  pinCode = '';
}

function pressPinNum(num) {
  if (Date.now() < pinLockoutUntil) return;
  if (pinCode.length < 6) {
    pinCode += num;
    updatePinDots();
    if (pinCode.length === 6) {
      setTimeout(processPinEntry, 150);
    }
  }
}

function deletePinDigit() {
  if (Date.now() < pinLockoutUntil) return;
  if (pinCode.length > 0) {
    pinCode = pinCode.slice(0, -1);
    updatePinDots();
  }
}

function updatePinDots(isError = false) {
  const dots = document.querySelectorAll('.pin-dots .dot');
  dots.forEach((dot, index) => {
    if (isError) {
      dot.className = 'dot error';
    } else if (index < pinCode.length) {
      dot.className = 'dot filled';
    } else {
      dot.className = 'dot';
    }
  });
}

async function processPinEntry() {
  const entered = pinCode;
  
  if (lockScreenMode === 'unlock') {
    const enteredHash = await hashPIN(entered);
    const savedHash = localStorage.getItem('security_pin_hash');

    if (savedHash && enteredHash === savedHash) {
      failedPinAttempts = 0;
      hideLockScreen();
      showToast('Acesso liberado com sucesso!', 'success');
    } else {
      failedPinAttempts++;
      triggerPinError();

      if (failedPinAttempts >= 5) {
        pinLockoutUntil = Date.now() + 60000;
        startLockoutCountdown();
      } else {
        const left = 5 - failedPinAttempts;
        document.getElementById('lock-message').textContent = `PIN incorreto! (${left} tentativa(s) restante(s))`;
      }
    }
  } else if (lockScreenMode === 'setup') {
    tempSetupPin = entered;
    pinCode = '';
    updatePinDots();
    lockScreenMode = 'confirm';
    document.getElementById('lock-message').textContent = 'Confirme o PIN novamente';
  } else if (lockScreenMode === 'confirm') {
    if (entered === tempSetupPin) {
      const hash = await hashPIN(entered);
      localStorage.setItem('security_pin_hash', hash);
      localStorage.setItem('security_pin_enabled', 'true');
      hideLockScreen();
      showToast('PIN de segurança configurado com sucesso!', 'success');
      renderSettings();
    } else {
      triggerPinError();
      document.getElementById('lock-message').textContent = 'Os PINs não coincidem. Tente novamente.';
      setTimeout(() => showLockScreen('setup'), 1000);
    }
  }
}

function triggerPinError() {
  updatePinDots(true);
  const container = document.querySelector('.lock-container');
  if (container) {
    container.classList.add('shake-animation');
    setTimeout(() => container.classList.remove('shake-animation'), 400);
  }
  setTimeout(() => {
    pinCode = '';
    updatePinDots();
  }, 600);
}

function startLockoutCountdown() {
  if (pinLockoutTimer) clearInterval(pinLockoutTimer);
  const msgEl = document.getElementById('lock-message');

  pinLockoutTimer = setInterval(() => {
    const remainingSec = Math.ceil((pinLockoutUntil - Date.now()) / 1000);
    if (remainingSec <= 0) {
      clearInterval(pinLockoutTimer);
      failedPinAttempts = 0;
      if (msgEl) msgEl.textContent = 'Digite seu PIN de 6 dígitos';
    } else {
      if (msgEl) msgEl.textContent = `Acesso bloqueado por tentativas incorretas (${remainingSec}s)`;
    }
  }, 1000);
}

// Biometria (WebAuthn Platform)
async function checkBiometricsSupport() {
  if (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) { return false; }
  }
  return false;
}

async function triggerBiometricAuth() {
  if (localStorage.getItem('security_bio_enabled') !== 'true') return;
  try {
    const credId = localStorage.getItem('security_bio_cred_id');
    if (!credId) return;

    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    // 5s (não 60s): se o rosto não aparecer logo, desiste sozinho e mostra
    // o que fazer em seguida, em vez de deixar o Windows Hello esperando
    // por até um minuto inteiro sem dar nenhuma pista de que dá pra digitar
    // o PIN em vez de continuar tentando o rosto.
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: challenge,
        timeout: 5000,
        userVerification: 'required'
      }
    });

    if (assertion) {
      failedPinAttempts = 0;
      hideLockScreen();
      showToast('Desbloqueado por Biometria!', 'success');
    }
  } catch (e) {
    console.log('Biometria cancelada ou não reconhecida.');
    if (lockScreenMode === 'unlock') {
      const msgEl = document.getElementById('lock-message');
      if (msgEl) msgEl.textContent = 'Não reconheci seu rosto. Toque no ícone pra tentar de novo, ou digite seu PIN.';
    }
  }
}

async function togglePinSecurity(enabled) {
  if (enabled) {
    showLockScreen('setup');
  } else {
    // O bloqueio por PIN agora é obrigatório (protege o acesso ao painel
    // inteiro) — não dá mais pra desativar por aqui, só trocar o código.
    showToast('O bloqueio por PIN é obrigatório neste painel. Use "Redefinir PIN" para trocar o código.', 'warning');
    renderSettings();
  }
}

async function toggleBioSecurity(enabled) {
  if (enabled) {
    try {
      const challenge = new Uint8Array(32);
      window.crypto.getRandomValues(challenge);
      const userId = new Uint8Array(16);
      window.crypto.getRandomValues(userId);

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: challenge,
          rp: { name: "Área Segura Pro", id: window.location.hostname || "localhost" },
          user: { id: userId, name: "admin@areasegura", displayName: "Administrador" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
          timeout: 60000
        }
      });

      if (credential) {
        const credentialId = btoa(String.fromCharCode.apply(null, new Uint8Array(credential.rawId)));
        localStorage.setItem('security_bio_cred_id', credentialId);
        localStorage.setItem('security_bio_enabled', 'true');
        showToast('Biometria ativada com sucesso!', 'success');
      }
    } catch (e) {
      showToast('Não foi possível ativar a biometria no dispositivo.', 'error');
    }
  } else {
    localStorage.removeItem('security_bio_enabled');
    showToast('Biometria desativada.', 'info');
  }
  renderSettings();
}

function startPinChange() {
  showLockScreen('setup');
}

function renderSettings() {
  renderAdminTokenStatus();
  const isPinEnabled = localStorage.getItem('security_pin_enabled') === 'true';
  const isBioEnabled = localStorage.getItem('security_bio_enabled') === 'true';

  const pinToggle = document.getElementById('setting-pin-enabled');
  const bioToggle = document.getElementById('setting-bio-enabled');

  if (pinToggle) {
    pinToggle.checked = isPinEnabled;
    pinToggle.disabled = isPinEnabled; // obrigatório: só pode ligar, nunca desligar
  }
  if (bioToggle) bioToggle.checked = isBioEnabled;

  const changePinRow = document.getElementById('change-pin-row');
  const bioSettingsItem = document.getElementById('biometric-settings-item');

  if (isPinEnabled) {
    if (changePinRow) changePinRow.style.display = 'block';
    if (biometricsAvailable && bioSettingsItem) bioSettingsItem.style.display = 'flex';
  } else {
    if (changePinRow) changePinRow.style.display = 'none';
    if (bioSettingsItem) bioSettingsItem.style.display = 'none';
  }
}

// ============================================
// Atualização de Versão e Limpeza de Cache Mobile
// ============================================
let currentAppVersion = '2.5.1';

async function checkAppVersion() {
  try {
    const res = await fetch(`./version.json?_t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.version) {
        currentAppVersion = data.version;
        const versionEl = document.getElementById('app-version-display');
        if (versionEl) versionEl.textContent = `v${data.version} Pro Enterprise`;

        const savedVersion = localStorage.getItem('area_segura_app_version');
        if (savedVersion && savedVersion !== data.version) {
          localStorage.setItem('area_segura_app_version', data.version);
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(registrations => {
              for (const reg of registrations) reg.update();
            });
          }
          showToast(`Aplicativo atualizado para a v${data.version}!`, 'success');
          setTimeout(() => { window.location.reload(); }, 1200);
        } else if (!savedVersion) {
          localStorage.setItem('area_segura_app_version', data.version);
        }
      }
    }
  } catch (e) {}
}

async function forceAppUpdate() {
  if (await showConfirmModal('Deseja forçar a atualização imediata e limpar todo o cache armazenado no celular?', 'Forçar Atualização')) {
    showToast('Limpando cache e atualizando versão...', 'info');
    
    // 1. Limpar caches do Service Worker
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }

    // 2. Desregistrar Service Workers existentes
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }
    }

    // 3. Atualizar carimbo de versão local
    localStorage.setItem('area_segura_app_version', '2.0.0');

    // 4. Recarregar do servidor com carimbo fresco
    setTimeout(() => {
      window.location.href = window.location.origin + window.location.pathname + `?_update=${Date.now()}`;
    }, 800);
  }
}

// ============================================
// Gerenciamento de Tema / Aparência
// ============================================
function initTheme() {
  const savedTheme = localStorage.getItem('gerenciador_theme') || 'cyber';
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  const tag = document.getElementById('current-theme-tag');
  if (theme === 'slate') {
    document.body.classList.add('theme-slate');
    if (tag) tag.textContent = 'Clean Slate (Executivo)';
    localStorage.setItem('gerenciador_theme', 'slate');
  } else {
    document.body.classList.remove('theme-slate');
    if (tag) tag.textContent = 'Cyber Dark';
    localStorage.setItem('gerenciador_theme', 'cyber');
  }
}

function toggleAppTheme() {
  const isSlate = document.body.classList.contains('theme-slate');
  const nextTheme = isSlate ? 'cyber' : 'slate';
  applyTheme(nextTheme);
  showToast(`Aparência: ${nextTheme === 'slate' ? 'Clean Slate (Executivo)' : 'Cyber Dark'}`, 'info');
}

// ============================================
// Importar / Exportar Banco
// ============================================
function exportDB() {
  const jsonStr = JSON.stringify(DB, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `AreaSegura_Clientes_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Banco de clientes exportado!', 'success');
}

function importDB() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (Array.isArray(imported)) {
          DB = imported;
          if (await saveDB()) { showToast(`${DB.length} cliente(s) importado(s) com sucesso!`, 'success'); }
          renderDashboard();
        } else {
          showToast('Formato de arquivo inválido.', 'error');
        }
      } catch (err) {
        showToast('Erro ao ler arquivo JSON.', 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ============================================
// Utilitários & Toast
// ============================================
function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let toastTimer = null;
function showToast(message, type = 'info') {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }

  toast.className = `toast show ${type}`;
  toast.textContent = message;

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, 3500);
}

async function refreshAll() {
  const refreshBtn = document.querySelector('.header-refresh');
  if (refreshBtn) refreshBtn.classList.add('spinning');

  await fetchCloudStatuses();
  await syncFromCloud();
  await checkAppVersion();

  setTimeout(() => {
    if (refreshBtn) refreshBtn.classList.remove('spinning');
    showToast('Dados sincronizados com a nuvem!', 'success');
  }, 600);
}

// ============================================
// Inicialização
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadDB();

  // Registrar Service Worker com tratamento de updates
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showToast('Nova versão detectada! Atualizando...', 'info');
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        }
      });
    }).catch(err => {
      console.warn('[SW] Erro ao registrar:', err);
    });
  }

  // Checar suporte biometria
  checkBiometricsSupport().then(supported => {
    biometricsAvailable = supported;
    renderSettings();
  });

  // Checagem de versão
  checkAppVersion();

  // Sincronização em segundo plano — só se este aparelho já foi ativado
  // com o Token de Administrador. Antes disso não faz sentido tentar (nem
  // mostrar o aviso de "configure o token"): quem ainda não passou pelo
  // portão de ativação vai ver essa tela primeiro, não o dashboard.
  if (localStorage.getItem('area_segura_admin_token')) {
    initialSyncPromise = syncFromCloud();
    fetchCloudStatuses();
    checkV2SecurityAlerts();
  }

  // Splash Screen e Rota Inicial
  setTimeout(() => {
    document.getElementById('splash-screen').classList.add('hidden');
    document.getElementById('app').classList.add('visible');

    // Ninguém entra neste painel sem antes provar que tem o Token de
    // Administrador (portão de ativação) — só depois disso o PIN local
    // (obrigatório, uma vez por aparelho) passa a proteger os acessos
    // seguintes. Isso fecha o buraco de qualquer pessoa "criar uma conta"
    // só de abrir a URL base do Gerenciador.
    if (!localStorage.getItem('area_segura_admin_token')) {
      document.getElementById('activation-screen')?.classList.add('active');
      setTimeout(() => document.getElementById('activation-token-input')?.focus(), 300);
    } else if (localStorage.getItem('security_pin_enabled') === 'true') {
      showLockScreen('unlock');
    } else {
      showLockScreen('setup');
    }
  }, 500);

  // Navegação Inferior
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.page);
    });
  });

  // Busca de clientes
  const searchInput = document.getElementById('search-clients');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      renderClientList(e.target.value);
    });
  }

  // Sincronização periódica a cada 15 segundos (só depois de ativado)
  setInterval(() => {
    if (!localStorage.getItem('area_segura_admin_token')) return;
    fetchCloudStatuses();
    checkV2SecurityAlerts();
    if (currentPage === 'machines') renderMachineList();
  }, 15000);

  // Checar novas versões a cada 60 segundos
  setInterval(() => {
    checkAppVersion();
  }, 60000);

  // Recarregar status quando a aba voltar ao foco
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (localStorage.getItem('area_segura_admin_token')) { fetchCloudStatuses(); checkV2SecurityAlerts(); }
      checkAppVersion();
    }
  });
});
