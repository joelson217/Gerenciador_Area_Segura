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

// --- Estado da Aplicação ---
let DB = [];
let selectedClient = null;
let cloudStatuses = {};
let currentPage = 'dashboard';

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
  const result = await callLicenseApi('activate', {
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

async function sendSupabaseCommand(hwId, cmd) {
  await callLicenseApi('command', { hardware_id: hwId, comando: cmd, admin_token: getAdminToken() });
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
      showToast('Não foi possível sincronizar com a nuvem (offline?).', 'warning');
    }
  }
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
  let dbUpdated = false;
  (result.statuses || []).forEach(r => {
    cloudStatuses[r.hardware_id] = r;

    if (DB.length > 0) {
      const found = DB.some(c => c.Maquinas && c.Maquinas.some(m => m.HardwareID === r.hardware_id));
      if (!found) {
        if (!DB[0].Maquinas) DB[0].Maquinas = [];
        DB[0].Maquinas.push({
          Id: generateId(),
          Laboratorio: 'Lab Principal',
          HardwareID: r.hardware_id,
          DataExpiracao: r.data_expiracao || '2027-08-15',
          ChaveGerada: r.chave_ativacao || '',
          NomeExibicao: r.hardware_id
        });
        dbUpdated = true;
      }
    }
  });

  if (dbUpdated) {
    localStorage.setItem('area_segura_db', JSON.stringify(DB));
  }

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

  banner.innerHTML = `
    <div class="pending-alert-card" style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 10px; padding: 14px; margin-bottom: 16px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
        <span style="font-weight:700; color:var(--accent-orange); font-size:13px; display:inline-flex; align-items:center; gap:6px;"><svg class="icon"><use href="#icon-alert-triangle"/></svg> ${pendingHwIds.length} Novo(s) Computador(es) Detectado(s)</span>
      </div>
      <p style="font-size:12px; color:var(--text-secondary); margin-bottom:10px;">Há terminais recém-instalados aguardando ativação de licença na nuvem.</p>
      <button class="btn-small-action" style="background:var(--accent-orange); color:#0F172A; font-weight:700; width:100%; padding:8px;" onclick="navigateTo('clients')">
        Ver Clientes e Ativar Terminais
      </button>
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

  // Link fica numa página separada (portal.html), sem nenhum código do
  // Gerenciador admin — assim ninguém "tira uma parte" do link do cliente
  // e chega no meu painel; é uma URL diferente desde o início.
  const portalKey = selectedClient.PortalUser || selectedClient.Id;
  const portalUrl = `${window.location.origin}/portal.html?u=${encodeURIComponent(portalKey)}`;
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

function saveClientDetails() {
  if (!selectedClient) return;

  selectedClient.Instituicao = document.getElementById('detail-instituicao')?.value.trim() || selectedClient.Instituicao;
  selectedClient.Localidade = document.getElementById('detail-localidade')?.value.trim() || '';
  selectedClient.Responsavel = document.getElementById('detail-responsavel')?.value.trim() || '';
  selectedClient.Contato = document.getElementById('detail-contato')?.value.trim() || '';
  
  const pUser = document.getElementById('detail-portal-user')?.value.trim().toLowerCase().replace(/\s+/g, '_') || '';
  const pPass = document.getElementById('detail-portal-pass')?.value.trim() || '';

  selectedClient.PortalUser = pUser;
  selectedClient.PortalPass = pPass;

  saveDB();
  showToast('Dados do cliente atualizados com sucesso!', 'success');
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
    `;
    grid.appendChild(tag);
  });

  container.appendChild(grid);
}

function showAddAmbienteModal() {
  const name = prompt('Digite o nome do novo Ambiente / Laboratório (ex: Lab 02, Biblioteca, Sala 10):');
  if (name && name.trim()) {
    if (!selectedClient.Ambientes) selectedClient.Ambientes = ['Lab Principal'];
    const clean = name.trim();
    if (!selectedClient.Ambientes.includes(clean)) {
      selectedClient.Ambientes.push(clean);
      saveDB();
      renderAmbientes();
      showToast(`Ambiente "${clean}" adicionado!`, 'success');
    }
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

function renderMachineList() {
  const container = document.getElementById('machines-list');
  if (!container || !selectedClient) return;
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

  machines.forEach(m => {
    const cloud = cloudStatuses[m.HardwareID] || {};
    const status = cloud.status_protecao || 'DESCONHECIDO';
    const isFrozen = status === 'CONGELADO';
    const isPending = status === 'PENDENTE';

    let badgeClass = 'status-thawed';
    let statusIcon = 'icon-flame';
    let statusLabel = 'Descongelado';
    if (isFrozen) {
      badgeClass = 'status-frozen';
      statusIcon = 'icon-snowflake';
      statusLabel = 'Protegido (Congelado)';
    } else if (isPending) {
      badgeClass = 'status-pending';
      statusIcon = 'icon-hourglass';
      statusLabel = 'Pendente de Ativação';
    }

    const card = document.createElement('div');
    card.className = 'machine-card';
    card.innerHTML = `
      <div class="machine-card-header">
        <div class="machine-card-header-left">
          <input type="checkbox" class="machine-checkbox" data-hwid="${escapeHtml(m.HardwareID)}" onchange="updateSelectCount()">
          <span class="machine-card-title">${escapeHtml(m.NomeExibicao || m.HardwareID)}</span>
        </div>
        <span class="machine-status-badge ${badgeClass}"><svg class="icon"><use href="#${statusIcon}"/></svg> ${statusLabel}</span>
      </div>
      <div class="machine-card-body">
        <div><strong>HWID:</strong> <code>${escapeHtml(m.HardwareID)}</code></div>
        <div><strong>Ambiente:</strong> ${escapeHtml(m.Laboratorio || 'Lab Principal')}</div>
        <div><strong>Validade:</strong> ${m.DataExpiracao || 'Indefinida'}</div>
        ${cloud.pasta_persistente && cloud.pasta_persistente !== 'Nenhuma' ? `<div><strong>Pasta Persistente:</strong> ${escapeHtml(cloud.pasta_persistente)}</div>` : ''}
      </div>
      <div class="machine-card-footer">
        <span>Última Sinc: ${cloud.ultima_sincronizacao || 'Sem dados recentes'}</span>
        <button class="btn-small-action" onclick="copyMachineKey('${escapeHtml(m.HardwareID)}', '${escapeHtml(m.DataExpiracao)}')"><svg class="icon"><use href="#icon-copy"/></svg> Copiar Chave</button>
      </div>
    `;
    container.appendChild(card);
  });

  updateSelectCount();
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

function toggleSelectAll(checked) {
  document.querySelectorAll('.machine-checkbox').forEach(cb => {
    cb.checked = checked;
  });
  updateSelectCount();
}

async function copyMachineKey(hwId, expDate) {
  const exp = expDate || '2027-08-15';
  const key = await getActivationKey(hwId, exp);
  navigator.clipboard.writeText(key).then(() => {
    showToast(`Chave copiada: ${key}`, 'success');
  }).catch(() => {
    prompt('Copie a chave de ativação:', key);
  });
}

// Ações Remotas em Lote
async function freezeSelected() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina.', 'warning');
    return;
  }
  if (confirm(`Deseja CONGELAR e proteger as ${selected.length} máquina(s) selecionada(s)? O sistema será bloqueado contra alterações.`)) {
    for (const hwId of selected) {
      await sendSupabaseCommand(hwId, 'FREEZE|MANTER');
    }
    showToast(`Comando de congelamento enviado para ${selected.length} máquina(s)!`, 'success');
    refreshAll();
  }
}

async function thawSelected() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina.', 'warning');
    return;
  }
  if (confirm(`Deseja DESCONGELAR as ${selected.length} máquina(s) selecionada(s)? As alterações serão mantidas.`)) {
    for (const hwId of selected) {
      await sendSupabaseCommand(hwId, 'THAW');
    }
    showToast(`Comando de descongelamento enviado para ${selected.length} máquina(s)!`, 'success');
    refreshAll();
  }
}

async function revokeSelected() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina.', 'warning');
    return;
  }
  if (confirm(`⚠️ ATENÇÃO: Deseja REVOGAR a licença das ${selected.length} máquina(s)? Elas perderão a ativação imediatamente.`)) {
    for (const hwId of selected) {
      await sendSupabaseCommand(hwId, 'REVOKE');
    }
    showToast(`Licença revogada em ${selected.length} máquina(s)!`, 'success');
    refreshAll();
  }
}

async function uninstallSelected() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina.', 'warning');
    return;
  }
  if (confirm(`🚨 PERIGO: Deseja DESINSTALAR COMPLETAMENTE o Área Segura nas ${selected.length} máquina(s)? Esta ação é irreversível e reiniciará os computadores.`)) {
    for (const hwId of selected) {
      await sendSupabaseCommand(hwId, 'UNINSTALL');
    }
    showToast(`Comando de desinstalação enviado para ${selected.length} máquina(s)!`, 'success');
    refreshAll();
  }
}

function showRenewModal() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina para renovar.', 'warning');
    return;
  }

  const expDate = prompt('Digite a nova data de validade da licença (AAAA-MM-DD):', '2027-08-15');
  if (expDate && /^\d{4}-\d{2}-\d{2}$/.test(expDate.trim())) {
    const cleanDate = expDate.trim();
    selected.forEach(async hwId => {
      const chave = await getActivationKey(hwId, cleanDate); // já persiste a licença no servidor

      // Atualizar local
      if (selectedClient && selectedClient.Maquinas) {
        const maq = selectedClient.Maquinas.find(m => m.HardwareID === hwId);
        if (maq) {
          maq.DataExpiracao = cleanDate;
          maq.ChaveGerada = chave;
        }
      }
    });

    saveDB();
    showToast(`Licenças renovadas até ${cleanDate}!`, 'success');
    renderMachineList();
  }
}

function showUpdateModal() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina para atualizar o executável.', 'warning');
    return;
  }

  const defaultUrl = 'https://raw.githubusercontent.com/joelson217/Gerenciador_Area_Segura/main/AreaSegura.exe';
  const url = prompt('URL do novo executável AreaSegura.exe:', defaultUrl);
  if (url && url.trim().startsWith('http')) {
    const cleanUrl = url.trim();
    selected.forEach(async hwId => {
      await sendSupabaseCommand(hwId, `UPDATE|${cleanUrl}`);
    });
    showToast(`Comando de atualização enviado para ${selected.length} máquina(s)!`, 'success');
  }
}

function showAddMachineModal() {
  const hwId = prompt('Digite o Hardware ID da nova máquina (ex: AS-A1B2C3D4):');
  if (hwId && hwId.trim()) {
    const cleanHw = hwId.trim().toUpperCase();
    const amb = prompt('Ambiente / Laboratório:', (selectedClient.Ambientes && selectedClient.Ambientes[0]) || 'Lab Principal') || 'Lab Principal';
    const exp = prompt('Data de Expiração (AAAA-MM-DD):', '2027-08-15') || '2027-08-15';

    if (!selectedClient.Maquinas) selectedClient.Maquinas = [];
    selectedClient.Maquinas.push({
      Id: generateId(),
      Laboratorio: amb,
      HardwareID: cleanHw,
      DataExpiracao: exp,
      NomeExibicao: cleanHw
    });

    getActivationKey(cleanHw, exp).then(chave => { // já persiste a licença no servidor
      saveDB();
      renderMachineList();
      showToast(`Máquina ${cleanHw} cadastrada com sucesso!`, 'success');
    });
  }
}

function deleteSelectedMachines() {
  const selected = getSelectedHwIds();
  if (selected.length === 0) {
    showToast('Selecione pelo menos uma máquina para excluir do cadastro.', 'warning');
    return;
  }
  if (confirm(`Excluir as ${selected.length} máquina(s) do cadastro deste cliente?`)) {
    selectedClient.Maquinas = (selectedClient.Maquinas || []).filter(m => !selected.includes(m.HardwareID));
    saveDB();
    renderMachineList();
    showToast(`${selected.length} máquina(s) removida(s) do cadastro!`, 'success');
  }
}

function showDeleteClientModal() {
  if (!selectedClient) return;
  if (confirm(`⚠️ Tem certeza de que deseja EXCLUIR o cliente "${selectedClient.Instituicao}" e todas as suas máquinas?`)) {
    DB = DB.filter(c => c.Id !== selectedClient.Id);
    saveDB();
    showToast('Cliente excluído com sucesso!', 'success');
    navigateTo('clients');
  }
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

function confirmNewClient() {
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
  saveDB();
  closeNewClientModal();
  showToast(`Cliente "${newClient.Instituicao}" criado!`, 'success');
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

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: challenge,
        timeout: 60000,
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
let currentAppVersion = '2.2.1';

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
  if (confirm('Deseja forçar a atualização imediata e limpar todo o cache armazenado no celular?')) {
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
    reader.onload = ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (Array.isArray(imported)) {
          DB = imported;
          saveDB();
          showToast(`${DB.length} cliente(s) importado(s) com sucesso!`, 'success');
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

  // Sincronização em segundo plano
  initialSyncPromise = syncFromCloud();
  fetchCloudStatuses();

  // Splash Screen e Rota Inicial
  setTimeout(() => {
    document.getElementById('splash-screen').classList.add('hidden');
    document.getElementById('app').classList.add('visible');

    // O bloqueio por PIN/biometria não é mais opcional: sem ele, bastava
    // abrir a URL base do Gerenciador (ex: apagando a parte "?u=..." do
    // link de um cliente) pra cair direto no painel admin sem senha
    // nenhuma. Agora, se ainda não existe PIN configurado neste aparelho,
    // o próprio app exige a criação de um antes de mostrar qualquer coisa.
    if (localStorage.getItem('security_pin_enabled') === 'true') {
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

  // Sincronização periódica a cada 15 segundos
  setInterval(() => {
    fetchCloudStatuses();
    if (currentPage === 'machines') renderMachineList();
  }, 15000);

  // Checar novas versões a cada 60 segundos
  setInterval(() => {
    checkAppVersion();
  }, 60000);

  // Recarregar status quando a aba voltar ao foco
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      fetchCloudStatuses();
      checkAppVersion();
    }
  });
});
