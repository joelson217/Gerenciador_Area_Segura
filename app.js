// ============================================
// ÁREA SEGURA - PWA Mobile App
// Lógica Principal
// ============================================

// --- Configuração Supabase ---
const SUPABASE_URL = 'https://inndgkbugwegrkbvogew.supabase.co/rest/v1';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlubmRna2J1Z3dlZ3JrYnZvZ2V3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNDQ2ODgsImV4cCI6MjA5NDYyMDY4OH0.8_ZW6I_XbG5UGMEMOKKoY51OA7P97FNdCiBqHs5e00E';
const HMAC_SECRET = 'AreaSegura@Joelson!2026';

const supaHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

// --- Estado da Aplicação ---
let DB = [];
let selectedClient = null;
let cloudStatuses = {};
let currentPage = 'dashboard';

// ============================================
// HMAC-SHA256 para Gerar Chaves de Ativação
// ============================================
async function hmacSHA256(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('').substring(0, 16).toUpperCase();
}

async function getActivationKey(hardwareId, expirationDate) {
  const dataToSign = `${hardwareId}|${expirationDate}`;
  const hashStr = await hmacSHA256(HMAC_SECRET, dataToSign);
  return `${expirationDate}-${hashStr}`;
}

// ============================================
// API Supabase
// ============================================
async function fetchCloudStatuses() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/licencas?select=hardware_id,status_protecao,pasta_persistente,comando_remoto,ultima_sincronizacao,chave_ativa`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return;
    const data = await res.json();
    cloudStatuses = {};
    data.forEach(r => { cloudStatuses[r.hardware_id] = r; });
  } catch (e) { /* offline */ }
}

async function syncSupabase(hwId, chave, dataExp) {
  try {
    await fetch(`${SUPABASE_URL}/licencas`, {
      method: 'POST',
      headers: { ...supaHeaders, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        hardware_id: hwId,
        chave_ativacao: chave,
        data_expiracao: dataExp,
        comando_remoto: 'NONE'
      })
    });
  } catch (e) { /* offline */ }
}

async function sendSupabaseCommand(hwId, cmd) {
  try {
    await fetch(`${SUPABASE_URL}/licencas?hardware_id=eq.${hwId}`, {
      method: 'PATCH',
      headers: supaHeaders,
      body: JSON.stringify({ comando_remoto: cmd })
    });
  } catch (e) { /* offline */ }
}

// ============================================
// Banco de Dados Local (LocalStorage)
// ============================================
function loadDB() {
  const saved = localStorage.getItem('area_segura_db');
  if (saved) {
    try { DB = JSON.parse(saved); } catch (e) { DB = []; }
  }
  if (!Array.isArray(DB) || DB.length === 0) {
    DB = [
      {
        "Id": "83089473-cad9-48aa-af20-c06fa6b0b693",
        "Instituicao": "Casa",
        "Responsavel": "Joelson",
        "Contato": "81-992781275",
        "Ambientes": ["Lab Principal"],
        "Maquinas": [],
        "NomeExibicao": "Casa",
        "CorAlerta": "White"
      }
    ];
    saveDB();
  }
}

async function saveDB() {
  localStorage.setItem('area_segura_db', JSON.stringify(DB));
  
  // Sincronizar banco de dados para a nuvem
  try {
    await fetch(`${SUPABASE_URL}/licencas`, {
      method: 'POST',
      headers: { ...supaHeaders, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        hardware_id: 'DB_BACKUP',
        chave_ativacao: JSON.stringify(DB),
        data_expiracao: '1970-01-01',
        status_protecao: 'BACKUP',
        pasta_persistente: 'Nenhuma',
        comando_remoto: 'NONE',
        ultima_sincronizacao: new Date().toLocaleString('pt-BR')
      })
    });
  } catch (e) { console.error('Erro ao salvar backup na nuvem:', e); }
}

// --- Sincronizar DB com Supabase (carregar licenças da nuvem) ---
async function syncFromCloud() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/licencas?select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return;
    const cloudData = await res.json();

    // Sincronizar o banco de dados dos clientes da nuvem se houver
    const backupRow = cloudData.find(r => r.hardware_id === 'DB_BACKUP');
    if (backupRow && backupRow.chave_ativacao) {
      try {
        const cloudDB = JSON.parse(backupRow.chave_ativacao);
        if (Array.isArray(cloudDB) && cloudDB.length > 0) {
          // Atualiza o local se estiver vazio ou se o da nuvem for mais recente/diferente
          if (DB.length === 0 || JSON.stringify(DB) !== JSON.stringify(cloudDB)) {
            DB = cloudDB;
            localStorage.setItem('area_segura_db', JSON.stringify(DB));
            
            // Re-renderiza a tela atual para refletir os novos dados
            if (currentPage === 'dashboard') renderDashboard();
            else if (currentPage === 'clients') renderClientList();
          }
        }
      } catch (err) { console.error('Erro ao carregar banco da nuvem:', err); }
    }

    // Carregar status reais das máquinas
    cloudStatuses = {};
    cloudData.forEach(r => {
      if (r.hardware_id !== 'DB_BACKUP') {
        cloudStatuses[r.hardware_id] = r;
      }
    });
  } catch (e) { /* offline */ }
}

// ============================================
// Navegação entre Páginas
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
  let expiring = 0;
  let ok = 0;

  DB.forEach(c => {
    if (c.Maquinas && Array.isArray(c.Maquinas)) {
      c.Maquinas.forEach(m => {
        totalMachines++;
        const days = getDaysRemaining(m.DataExpiracao);
        if (days <= 30) expiring++;
        else ok++;
      });
    }
  });

  return { totalClients, totalMachines, expiring, ok };
}

function getDaysRemaining(dateStr) {
  const exp = new Date(dateStr + 'T23:59:59');
  const now = new Date();
  return Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
}

function renderDashboard() {
  const stats = getDashboardStats();

  document.getElementById('stat-clients').textContent = stats.totalClients;
  document.getElementById('stat-machines').textContent = stats.totalMachines;
  document.getElementById('stat-expiring').textContent = stats.expiring;
  document.getElementById('stat-ok').textContent = stats.ok;

  const expiringCard = document.querySelector('.card-expiring');
  if (stats.expiring > 0) expiringCard.classList.add('has-alert');
  else expiringCard.classList.remove('has-alert');

  // Banner de Máquinas Detectadas na Nuvem
  renderPendingMachinesBanner();

  // Clientes recentes no dashboard
  renderRecentClients();
}

function renderPendingMachinesBanner() {
  const container = document.getElementById('pending-machines-banner');
  if (!container) return;

  const existingHwIds = new Set();
  DB.forEach(c => {
    if (c.Maquinas) c.Maquinas.forEach(m => existingHwIds.add(m.HardwareID));
  });

  const pendingList = Object.values(cloudStatuses).filter(s => 
    s.hardware_id && s.hardware_id !== 'DB_BACKUP' && !existingHwIds.has(s.hardware_id)
  );

  if (pendingList.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  let html = '';
  pendingList.forEach(p => {
    const meta = parsePendingMeta(p.chave_ativacao);
    const displayName = meta.host !== 'Desconhecido' ? meta.host : p.hardware_id;
    html += `
      <div class="pending-alert-card">
        <div class="pending-alert-header">
          <span class="pulse-dot"></span>
          <span class="pending-alert-title">⚡ Nova Máquina Conectada na Nuvem!</span>
        </div>
        <div class="pending-alert-body">
          <div class="pending-machine-name">💻 ${escapeHtml(displayName)}</div>
          <div class="pending-machine-meta">ID: <b>${escapeHtml(p.hardware_id)}</b> • IP: ${escapeHtml(meta.ip)}</div>
        </div>
        <button class="btn-activate-quick" onclick="quickActivateModal('${escapeHtml(p.hardware_id)}', '${escapeHtml(meta.host)}')">
          ⚡ ATIVAR MÁQUINA (1 Toque)
        </button>
      </div>
    `;
  });

  container.innerHTML = html;
  container.style.display = 'block';
}

function renderRecentClients() {
  const container = document.getElementById('recent-clients');
  if (!container) return;

  if (DB.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-text">Nenhum cliente cadastrado ainda</div>
      </div>`;
    return;
  }

  let html = '';
  const recent = DB.slice(-5).reverse();
  recent.forEach(c => {
    const maqCount = (c.Maquinas || []).length;
    const expCount = (c.Maquinas || []).filter(m => getDaysRemaining(m.DataExpiracao) <= 30).length;
    const initial = (c.Instituicao || 'C')[0].toUpperCase();

    html += `
      <div class="client-card" onclick="navigateTo('detail', DB.find(x => x.Id === '${c.Id}'))">
        <div class="client-card-avatar">${initial}</div>
        <div class="client-card-info">
          <div class="client-card-name">${escapeHtml(c.Instituicao || 'Sem Nome')}</div>
          <div class="client-card-meta">${maqCount} máquina(s) • ${c.Contato || 'Sem contato'}</div>
        </div>
        ${expCount > 0 ? `<div class="client-card-badge">⏳ ${expCount}</div>` : `<div class="client-card-badge ok">✓</div>`}
        <div class="client-card-arrow">›</div>
      </div>`;
  });

  container.innerHTML = html;
}

// ============================================
// Lista de Clientes
// ============================================
function renderClientList(filter = '') {
  const container = document.getElementById('client-list-container');
  if (!container) return;

  let filtered = DB;
  if (filter.trim()) {
    const f = filter.toLowerCase();
    filtered = DB.filter(c =>
      (c.Instituicao || '').toLowerCase().includes(f) ||
      (c.Responsavel || '').toLowerCase().includes(f) ||
      (c.Contato || '').toLowerCase().includes(f)
    );
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-text">${filter ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}</div>
      </div>`;
    return;
  }

  let html = '';
  filtered.forEach(c => {
    const maqCount = (c.Maquinas || []).length;
    const expCount = (c.Maquinas || []).filter(m => getDaysRemaining(m.DataExpiracao) <= 30).length;
    const initial = (c.Instituicao || 'C')[0].toUpperCase();

    html += `
      <div class="client-card" onclick="navigateTo('detail', DB.find(x => x.Id === '${c.Id}'))">
        <div class="client-card-avatar">${initial}</div>
        <div class="client-card-info">
          <div class="client-card-name">${escapeHtml(c.Instituicao || 'Sem Nome')}</div>
          <div class="client-card-meta">${maqCount} máquina(s) • ${c.Responsavel || 'Sem responsável'}</div>
        </div>
        ${expCount > 0 ? `<div class="client-card-badge">⏳ ${expCount}</div>` : maqCount > 0 ? `<div class="client-card-badge ok">✓</div>` : ''}
        <div class="client-card-arrow">›</div>
      </div>`;
  });

  container.innerHTML = html;
}

// ============================================
// Detalhes do Cliente
// ============================================
function renderClientDetail() {
  if (!selectedClient) return;

  document.getElementById('detail-instituicao').value = selectedClient.Instituicao || '';
  document.getElementById('detail-localidade').value = selectedClient.Localidade || '';
  document.getElementById('detail-responsavel').value = selectedClient.Responsavel || '';
  document.getElementById('detail-contato').value = selectedClient.Contato || '';

  const maqCount = (selectedClient.Maquinas || []).length;
  document.getElementById('detail-maq-count').textContent = `${maqCount} máquina(s) cadastrada(s)`;

  const ambientes = getClientAmbientes(selectedClient);
  document.getElementById('detail-ambientes').value = ambientes.join(', ');
}

function getClientAmbientes(client) {
  let ambs = client.Ambientes ? [...client.Ambientes] : [];
  if (client.Maquinas) {
    client.Maquinas.forEach(m => {
      if (m.Laboratorio && !ambs.includes(m.Laboratorio)) ambs.push(m.Laboratorio);
    });
  }
  if (ambs.length === 0) ambs = ['Lab Principal'];
  return ambs;
}

function saveClientDetails() {
  if (!selectedClient) return;

  const inst = document.getElementById('detail-instituicao').value.trim();
  if (!inst) { showToast('Nome da instituição não pode ser vazio', 'error'); return; }

  selectedClient.Instituicao = inst;
  selectedClient.Localidade = document.getElementById('detail-localidade').value.trim();
  selectedClient.Responsavel = document.getElementById('detail-responsavel').value.trim();
  selectedClient.Contato = document.getElementById('detail-contato').value.trim();
  selectedClient.NomeExibicao = inst;

  const ambsInput = document.getElementById('detail-ambientes').value;
  selectedClient.Ambientes = ambsInput.split(',').map(a => a.trim()).filter(a => a.length > 0);
  if (selectedClient.Ambientes.length === 0) {
    selectedClient.Ambientes = ['Lab Principal'];
  }

  saveDB();
  showToast('Dados atualizados com sucesso!', 'success');
}

// --- Excluir Cliente ---
function showDeleteClientModal() {
  if (!selectedClient) return;
  const nome = selectedClient.Instituicao || selectedClient.NomeExibicao || 'Este cliente';
  const maqCount = (selectedClient.Maquinas || []).length;

  showModal(`
    <div class="modal-title" style="color:#E94560;">Excluir Cliente</div>
    <div style="color:#ccc;margin-bottom:12px;">
      Tem certeza que deseja excluir <strong style="color:white;">${escapeHtml(nome)}</strong>?
      ${maqCount > 0 ? `<br><br><span style="color:#F39C12;">Atenao: ${maqCount} maquina(s) cadastrada(s) serao removidas.</span>` : ''}
    </div>
    <div class="detail-field">
      <div class="detail-label" style="color:#E94560;">Digite o nome da instituicao para confirmar:</div>
      <input type="text" class="detail-input" id="modal-confirm-delete" placeholder="${escapeHtml(nome)}" autocomplete="off">
    </div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button class="modal-btn-confirm" style="background:#E94560;" onclick="confirmDeleteClient()">EXCLUIR</button>
    </div>
  `);
}

async function confirmDeleteClient() {
  if (!selectedClient) return;
  const nome = selectedClient.Instituicao || selectedClient.NomeExibicao || '';
  const typed = document.getElementById('modal-confirm-delete').value.trim();

  if (typed.toLowerCase() !== nome.toLowerCase()) {
    showToast('O nome digitado nao confere. Exclusao cancelada.', 'error');
    return;
  }

  // Remove cloud licenses for all machines of this client
  const machines = selectedClient.Maquinas || [];
  for (const m of machines) {
    try {
      await fetch(`${SUPABASE_URL}/licencas?hardware_id=eq.${m.HardwareID}`, {
        method: 'DELETE',
        headers: supaHeaders
      });
    } catch (e) { /* offline, will remain in cloud */ }
  }

  // Remove client from local DB
  const idx = DB.findIndex(c => c.Id === selectedClient.Id);
  if (idx >= 0) DB.splice(idx, 1);

  saveDB();
  closeModal();
  selectedClient = null;
  navigateTo('dashboard');
  showToast(`Cliente "${nome}" excluido com sucesso!`, 'success');
}

// ============================================
// Máquinas
// ============================================
async function renderMachines() {
  if (!selectedClient) return;

  await fetchCloudStatuses();

  const container = document.getElementById('machines-list');
  const machines = selectedClient.Maquinas || [];

  // Filtro
  const filterAmb = document.getElementById('filter-ambiente');
  if (filterAmb) {
    const ambs = getClientAmbientes(selectedClient);
    filterAmb.innerHTML = '<option value="">Todos os Ambientes</option>';
    ambs.forEach(a => {
      filterAmb.innerHTML += `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`;
    });
  }

  renderMachineList();
}

function renderMachineList() {
  const container = document.getElementById('machines-list');
  const machines = selectedClient.Maquinas || [];
  const filterVal = document.getElementById('filter-ambiente')?.value || '';
  const searchVal = document.getElementById('search-machine')?.value?.trim().toLowerCase() || '';

  let filtered = machines;

  if (filterVal) {
    filtered = filtered.filter(m => m.Laboratorio === filterVal);
  }

  if (searchVal) {
    filtered = filtered.filter(m =>
      (m.HardwareID || '').toLowerCase().includes(searchVal) ||
      (m.Laboratorio || '').toLowerCase().includes(searchVal) ||
      (m.ChaveGerada || '').toLowerCase().includes(searchVal)
    );
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🖥️</div>
        <div class="empty-state-text">Nenhuma máquina encontrada</div>
      </div>`;
    updateSelectCount();
    return;
  }

  let html = '';
  filtered.forEach((m, i) => {
    const days = getDaysRemaining(m.DataExpiracao);
    const expDate = formatDate(m.DataExpiracao);
    const cloud = cloudStatuses[m.HardwareID];

    let statusClass = 'status-frozen';
    let statusText = '🧊 CONGELADA';
    let statusBadgeClass = 'frozen';
    let daysClass = 'days-ok';
    let daysText = `${days} dias`;

    if (m.ChaveGerada === 'REVOGADA' || days <= 0) {
      statusClass = 'status-danger';
      daysClass = 'days-danger';
      daysText = m.ChaveGerada === 'REVOGADA' ? 'REVOGADA' : 'EXPIRADA';
      statusBadgeClass = 'danger';
    } else if (days <= 30) {
      statusClass = 'status-warning';
      daysClass = 'days-warn';
      daysText = `${days} dias ⚠️`;
      statusBadgeClass = 'warning';
    }

    if (cloud) {
      if (cloud.status_protecao === 'DESCONGELADO') {
        statusText = '🔥 DESBLOQUEADA';
        statusBadgeClass = 'thawed';
        statusClass = 'status-thawed';
      } else {
        statusText = '🧊 CONGELADA';
      }
      if (cloud.chave_ativa && cloud.chave_ativa !== 'Nenhuma' && cloud.chave_ativa !== m.ChaveGerada) {
        statusText = '⚠️ PENDENTE';
        statusBadgeClass = 'warning';
      }
    }

    const isSelected = m._selected ? 'checked' : '';

    html += `
      <div class="machine-card ${statusClass}">
        <div class="machine-header">
          <div class="machine-header-left">
            <input type="checkbox" class="machine-checkbox" data-hw="${m.HardwareID}" ${isSelected} onchange="toggleMachineSelect('${m.HardwareID}', this.checked)">
            <div class="machine-lab">${escapeHtml(m.Laboratorio || 'Lab Principal')}</div>
          </div>
          <div class="machine-header-right">
            <span class="machine-status-badge ${statusBadgeClass}">${statusText}</span>
            <button class="btn-card-trash" onclick="deleteSingleMachine('${m.HardwareID}')" title="Excluir máquina do cadastro" style="background:rgba(233,69,96,0.15); border:1px solid rgba(233,69,96,0.4); color:#FCA5A5; cursor:pointer; font-size:12px; padding:3px 6px; border-radius:6px;">🗑️</button>
          </div>
        </div>
        <div class="machine-details">
          <div class="machine-detail-item">
            <span class="machine-detail-label">Hardware ID</span>
            <span class="machine-detail-value">${escapeHtml(m.HardwareID)}</span>
          </div>
          <div class="machine-detail-item">
            <span class="machine-detail-label">Vencimento</span>
            <span class="machine-detail-value ${daysClass}">${expDate} (${daysText})</span>
          </div>
          <div class="machine-detail-item" style="grid-column: 1 / -1;">
            <span class="machine-detail-label">Chave de Ativação</span>
            <span class="machine-detail-value key" onclick="copyToClipboard('${escapeHtml(m.ChaveGerada || '')}')">${escapeHtml(m.ChaveGerada || 'N/A')} 📋</span>
          </div>
        </div>
      </div>`;
  });

  container.innerHTML = html;
  updateSelectCount();
}

function toggleMachineSelect(hwId, checked) {
  if (!selectedClient || !selectedClient.Maquinas) return;
  const m = selectedClient.Maquinas.find(x => x.HardwareID === hwId);
  if (m) m._selected = checked;
  updateSelectCount();
}

function toggleSelectAll(checked) {
  if (!selectedClient || !selectedClient.Maquinas) return;
  selectedClient.Maquinas.forEach(m => { m._selected = checked; });
  renderMachineList();
}

function updateSelectCount() {
  const count = (selectedClient?.Maquinas || []).filter(m => m._selected).length;
  const el = document.getElementById('select-count');
  if (el) el.textContent = `${count} selecionada(s)`;
}

function getSelectedMachines() {
  if (!selectedClient || !selectedClient.Maquinas) return [];
  return selectedClient.Maquinas.filter(m => m._selected);
}

// ============================================
// Ações de Máquinas
// ============================================

// --- Buscar Maquinas Pendentes na Nuvem ---
async function fetchPendingMachines() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/licencas?chave_ativacao=like.PENDENTE*&select=hardware_id,chave_ativacao,ultima_sincronizacao`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch (e) { return []; }
}

function parsePendingMeta(chaveAtivacao) {
  // Format: PENDENTE|IP:xxx.xxx.xxx.xxx|HOST:NOME|LOCALIP:192.168.x.x
  const meta = { ip: 'Desconhecido', host: 'Desconhecido', localIp: '127.0.0.1' };
  if (!chaveAtivacao) return meta;
  const parts = chaveAtivacao.split('|');
  parts.forEach(p => {
    if (p.startsWith('IP:')) meta.ip = p.substring(3);
    if (p.startsWith('HOST:')) meta.host = p.substring(5);
    if (p.startsWith('LOCALIP:')) meta.localIp = p.substring(8);
  });
  return meta;
}

async function getMyPublicIP() {
  try {
    const res = await fetch('https://api.ipify.org?format=text');
    if (res.ok) return (await res.text()).trim();
  } catch (e) {}
  try {
    const res = await fetch('https://ipinfo.io/ip');
    if (res.ok) return (await res.text()).trim();
  } catch (e) {}
  return null;
}

// --- Adicionar Nova Máquina (com deteccao de pendentes) ---
async function showAddMachineModal() {
  const ambs = getClientAmbientes(selectedClient);
  let ambOptions = ambs.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');

  // Show loading modal first
  showModal(`
    <div class="modal-title">Nova Maquina</div>
    <div style="text-align:center;padding:30px;">
      <div class="spinner" style="margin:0 auto 15px;"></div>
      <p style="color:#ccc;">Buscando maquinas na mesma rede...</p>
    </div>
  `);

  // Fetch pending machines and admin IP in parallel
  const [pendingList, myIp] = await Promise.all([
    fetchPendingMachines(),
    getMyPublicIP()
  ]);

  // Separate machines already registered for this client
  const existingHwIds = new Set();
  DB.forEach(c => {
    if (c.Maquinas) c.Maquinas.forEach(m => existingHwIds.add(m.HardwareID));
  });

  const unregistered = pendingList.filter(p => !existingHwIds.has(p.hardware_id));

  // Categorize: same network vs remote
  const sameNetwork = [];
  const remoteNetwork = [];
  unregistered.forEach(p => {
    const meta = parsePendingMeta(p.chave_ativacao);
    const entry = { hwId: p.hardware_id, ...meta, lastSync: p.ultima_sincronizacao };
    if (myIp && meta.ip === myIp) {
      sameNetwork.push(entry);
    } else {
      remoteNetwork.push(entry);
    }
  });

  // Build the detected machines list
  let detectedHtml = '';
  if (sameNetwork.length > 0) {
    detectedHtml += `<div class="detail-label" style="color:#4ECCA3;margin-bottom:8px;">Nesta Rede (IP: ${escapeHtml(myIp || '?')})</div>`;
    detectedHtml += `<div class="pending-list">`;
    sameNetwork.forEach((m, i) => {
      detectedHtml += `
        <label class="pending-item local" style="display:flex;align-items:center;gap:10px;padding:10px;margin-bottom:6px;background:#16213E;border:1px solid #4ECCA3;border-radius:8px;cursor:pointer;">
          <input type="radio" name="pending-machine" value="${escapeHtml(m.hwId)}" ${i === 0 ? 'checked' : ''} onchange="onPendingSelect(this.value)">
          <div style="flex:1;">
            <div style="color:#4ECCA3;font-weight:bold;font-size:14px;">${escapeHtml(m.hwId)}</div>
            <div style="color:#ccc;font-size:11px;">PC: ${escapeHtml(m.host)} | IP Local: ${escapeHtml(m.localIp)}</div>
            <div style="color:#888;font-size:10px;">Detectado: ${escapeHtml(m.lastSync || '?')}</div>
          </div>
          <span style="color:#4ECCA3;font-size:18px;">&#10004;</span>
        </label>`;
    });
    detectedHtml += `</div>`;
  }

  if (remoteNetwork.length > 0) {
    detectedHtml += `<div class="detail-label" style="color:#F39C12;margin-top:12px;margin-bottom:8px;">Outras Redes (Remotas)</div>`;
    detectedHtml += `<div class="pending-list">`;
    remoteNetwork.forEach(m => {
      detectedHtml += `
        <label class="pending-item remote" style="display:flex;align-items:center;gap:10px;padding:10px;margin-bottom:6px;background:#1a1a2e;border:1px solid #555;border-radius:8px;cursor:pointer;opacity:0.7;">
          <input type="radio" name="pending-machine" value="${escapeHtml(m.hwId)}" onchange="onPendingSelect(this.value)">
          <div style="flex:1;">
            <div style="color:#F39C12;font-weight:bold;font-size:14px;">${escapeHtml(m.hwId)}</div>
            <div style="color:#ccc;font-size:11px;">PC: ${escapeHtml(m.host)} | IP: ${escapeHtml(m.ip)}</div>
            <div style="color:#888;font-size:10px;">Detectado: ${escapeHtml(m.lastSync || '?')}</div>
          </div>
          <span style="color:#F39C12;font-size:14px;">&#9888;</span>
        </label>`;
    });
    detectedHtml += `</div>`;
  }

  const hasDetected = sameNetwork.length > 0 || remoteNetwork.length > 0;
  const defaultHwId = sameNetwork.length > 0 ? sameNetwork[0].hwId : '';

  let manualHtml = `
    <div id="manual-hwid-section" style="display:${hasDetected ? 'none' : 'block'};">
      <div class="detail-field">
        <div class="detail-label">Hardware ID (Ex: AS-A1B2C3D4)</div>
        <input type="text" class="detail-input" id="modal-hwid" placeholder="AS-XXXXXXXX" autocapitalize="characters" style="text-transform: uppercase;">
      </div>
    </div>`;

  let toggleBtn = hasDetected ? `
    <button class="action-btn" onclick="toggleManualHwId()" id="btn-toggle-manual"
      style="background:transparent;border:1px solid #555;color:#aaa;font-size:12px;width:100%;margin-bottom:12px;">
      Digitar Hardware ID manualmente
    </button>` : '';

  showModal(`
    <div class="modal-title">Nova Maquina</div>
    ${hasDetected ? `<div style="color:#4ECCA3;font-size:12px;margin-bottom:12px;">Maquinas detectadas automaticamente:</div>` : ''}
    ${detectedHtml}
    ${toggleBtn}
    ${manualHtml}
    <input type="hidden" id="selected-pending-hwid" value="${escapeHtml(defaultHwId)}">
    <div class="detail-field">
      <div class="detail-label">Ambiente / Laboratorio</div>
      <select class="filter-select" id="modal-ambiente" style="width:100%">${ambOptions}</select>
    </div>
    <div class="renewal-option">
      <input type="checkbox" id="modal-anual" checked>
      <label for="modal-anual">Renovacao anual (+365 dias)</label>
    </div>
    <div class="renewal-input-group">
      <label>Dias Extras (Bonus / Teste)</label>
      <input type="number" id="modal-dias-extras" value="0" min="0" inputmode="numeric">
    </div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button class="modal-btn-confirm" onclick="confirmAddMachine()">Confirmar</button>
    </div>
  `);
}

function onPendingSelect(hwId) {
  const el = document.getElementById('selected-pending-hwid');
  if (el) el.value = hwId;
}

function toggleManualHwId() {
  const section = document.getElementById('manual-hwid-section');
  const btn = document.getElementById('btn-toggle-manual');
  const hiddenInput = document.getElementById('selected-pending-hwid');
  if (section.style.display === 'none') {
    section.style.display = 'block';
    btn.textContent = 'Usar maquina detectada';
    // Uncheck all radios
    document.querySelectorAll('input[name="pending-machine"]').forEach(r => r.checked = false);
    if (hiddenInput) hiddenInput.value = '';
  } else {
    section.style.display = 'none';
    btn.textContent = 'Digitar Hardware ID manualmente';
    // Re-select first radio
    const first = document.querySelector('input[name="pending-machine"]');
    if (first) { first.checked = true; if (hiddenInput) hiddenInput.value = first.value; }
  }
}

async function confirmAddMachine() {
  // First check if a pending machine was selected via radio
  const pendingHwId = document.getElementById('selected-pending-hwid')?.value?.trim() || '';
  const manualHwId = document.getElementById('modal-hwid')?.value?.toUpperCase().trim() || '';
  const hwId = pendingHwId || manualHwId;
  const ambiente = document.getElementById('modal-ambiente').value;
  const anual = document.getElementById('modal-anual').checked;
  const diasExtras = parseInt(document.getElementById('modal-dias-extras').value) || 0;

  if (!hwId.match(/^AS-[A-F0-9]{8}$/)) {
    showToast('Selecione uma maquina detectada ou digite um Hardware ID valido (AS-XXXXXXXX)', 'error');
    return;
  }

  const existing = selectedClient.Maquinas?.find(m => m.HardwareID === hwId);

  if (existing) {
    // Renovar existente
    let currentExp = new Date(existing.DataExpiracao);
    if (currentExp < new Date()) currentExp = new Date();
    if (anual) currentExp.setFullYear(currentExp.getFullYear() + 1);
    currentExp.setDate(currentExp.getDate() + diasExtras);
    const newExp = formatDateISO(currentExp);

    existing.DataExpiracao = newExp;
    existing.ChaveGerada = await getActivationKey(hwId, newExp);
    await syncSupabase(hwId, existing.ChaveGerada, newExp);
    saveDB();
    closeModal();
    renderMachineList();
    showToast(`Máquina renovada! Chave: ${existing.ChaveGerada}`, 'success');
  } else {
    // Nova máquina
    let expDate = new Date();
    if (anual) expDate.setFullYear(expDate.getFullYear() + 1);
    expDate.setDate(expDate.getDate() + diasExtras);
    const newExp = formatDateISO(expDate);
    const key = await getActivationKey(hwId, newExp);

    if (!selectedClient.Maquinas) selectedClient.Maquinas = [];
    selectedClient.Maquinas.push({
      Id: generateId(),
      Laboratorio: ambiente,
      HardwareID: hwId,
      DataExpiracao: newExp,
      ChaveGerada: key
    });

    await syncSupabase(hwId, key, newExp);
    saveDB();
    closeModal();
    renderMachineList();
    showToast(`Máquina adicionada! Chave: ${key}`, 'success');
  }
}

// ============================================
// Ativação Rápida de Máquinas da Nuvem (1 Toque)
// ============================================
async function quickActivateModal(hwId, host) {
  if (DB.length === 0) {
    showToast('Cadastre um cliente primeiro para vincular a máquina.', 'warning');
    return;
  }

  let clientOptions = DB.map(c => `<option value="${c.Id}">${escapeHtml(c.Instituicao || 'Sem Nome')}</option>`).join('');

  showModal(`
    <div class="modal-title">⚡ Ativação Rápida de Máquina</div>
    <div style="font-size:12px; color:var(--text-muted); margin-bottom:15px;">
      A máquina será ativada, licenciada e conectada na nuvem instantaneamente.
    </div>

    <div class="form-group">
      <label class="form-label">Hardware ID</label>
      <input type="text" class="form-input" value="${escapeHtml(hwId)}" readonly style="color:var(--accent-green); font-weight:bold;">
    </div>

    <div class="form-group">
      <label class="form-label">Nome / Identificação</label>
      <input type="text" class="form-input" id="quick-mac-name" value="${escapeHtml(host !== 'Desconhecido' && host ? host : hwId)}">
    </div>

    <div class="form-group">
      <label class="form-label">Vincular ao Cliente</label>
      <select class="form-input" id="quick-mac-client">${clientOptions}</select>
    </div>

    <div class="form-group">
      <label class="form-label">Ambiente / Laboratório</label>
      <input type="text" class="form-input" id="quick-mac-amb" value="Lab Principal">
    </div>

    <div class="form-group">
      <label class="form-label">Período de Validade</label>
      <select class="form-input" id="quick-mac-period">
        <option value="365" selected>1 Ano</option>
        <option value="730">2 Anos</option>
        <option value="1825">5 Anos</option>
        <option value="3650">10 Anos (Vitalícia)</option>
      </select>
    </div>

    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn-primary" onclick="confirmQuickActivate('${escapeHtml(hwId)}')">✅ Ativar Agora</button>
    </div>
  `);
}

async function confirmQuickActivate(hwId) {
  const name = document.getElementById('quick-mac-name').value.trim() || hwId;
  const clientId = document.getElementById('quick-mac-client').value;
  const ambiente = document.getElementById('quick-mac-amb').value.trim() || 'Lab Principal';
  const periodDays = parseInt(document.getElementById('quick-mac-period').value) || 365;

  const client = DB.find(c => c.Id === clientId);
  if (!client) {
    showToast('Cliente não encontrado.', 'error');
    return;
  }

  const exp = new Date();
  exp.setDate(exp.getDate() + periodDays);
  const expDateStr = formatDateISO(exp);

  const key = await getActivationKey(hwId, expDateStr);

  if (!client.Maquinas) client.Maquinas = [];
  
  // Se já existe no cliente, atualiza; senão, adiciona
  const existingIdx = client.Maquinas.findIndex(m => m.HardwareID === hwId);
  const newMachineObj = {
    Id: generateId(),
    Laboratorio: ambiente,
    HardwareID: hwId,
    DataExpiracao: expDateStr,
    ChaveGerada: key,
    NomeExibicao: name
  };

  if (existingIdx >= 0) {
    client.Maquinas[existingIdx] = newMachineObj;
  } else {
    client.Maquinas.push(newMachineObj);
  }

  await syncSupabase(hwId, key, expDateStr);
  await saveDB();

  closeModal();
  showToast(`🎉 Máquina "${name}" ativada com sucesso!`, 'success');
  renderDashboard();
}

// --- Renovar em Lote ---
function showRenewModal() {
  const selected = getSelectedMachines();
  if (selected.length === 0) { showToast('Selecione pelo menos uma máquina', 'warning'); return; }

  showModal(`
    <div class="modal-title">🔑 Renovar ${selected.length} Máquina(s)</div>
    <div class="renewal-option">
      <input type="checkbox" id="modal-renew-anual" checked>
      <label for="modal-renew-anual">Renovação anual (+365 dias)</label>
    </div>
    <div class="renewal-input-group">
      <label>Dias Extras (Bônus / Teste)</label>
      <input type="number" id="modal-renew-extras" value="0" min="0" inputmode="numeric">
    </div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button class="modal-btn-orange" onclick="confirmRenew()">Gerar Chaves</button>
    </div>
  `);
}

async function confirmRenew() {
  const selected = getSelectedMachines();
  const anual = document.getElementById('modal-renew-anual').checked;
  const diasExtras = parseInt(document.getElementById('modal-renew-extras').value) || 0;

  for (const m of selected) {
    let currentExp = new Date(m.DataExpiracao);
    if (currentExp < new Date()) currentExp = new Date();
    if (anual) currentExp.setFullYear(currentExp.getFullYear() + 1);
    currentExp.setDate(currentExp.getDate() + diasExtras);
    const newExp = formatDateISO(currentExp);

    m.DataExpiracao = newExp;
    m.ChaveGerada = await getActivationKey(m.HardwareID, newExp);
    await syncSupabase(m.HardwareID, m.ChaveGerada, newExp);
  }

  saveDB();
  closeModal();
  renderMachineList();
  showToast(`${selected.length} máquina(s) renovada(s)!`, 'success');
}

// --- Congelar ---
function freezeSelected() {
  const selected = getSelectedMachines();
  if (selected.length === 0) { showToast('Selecione pelo menos uma máquina', 'warning'); return; }

  showModal(`
    <div class="modal-title">🧊 Congelar ${selected.length} Máquina(s)</div>
    <div style="margin-bottom:15px; text-align:left;">
      <label style="color:var(--text-secondary); font-size:12px; font-weight:600; text-transform:uppercase; display:block; margin-bottom:8px;">Pasta Persistente:</label>
      <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:10px;">
        <label style="font-size:13px; color:var(--text-primary); display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="persistAction" value="MANTER" checked onchange="togglePersistInput(false)">
          Manter configuração atual
        </label>
        <label style="font-size:13px; color:var(--text-primary); display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="persistAction" value="ALTERAR" onchange="togglePersistInput(true)">
          Definir / Criar nova pasta
        </label>
        
        <div id="persist-presets-container" style="display:none; margin-left:6px; padding:12px; background:rgba(0,0,0,0.25); border:1px solid rgba(78,204,163,0.3); border-radius:8px;">
          <div style="font-size:11px; color:#4ECCA3; font-weight:700; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">Selecione o local pré-definido:</div>
          <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">
            <button type="button" class="preset-loc-btn" onclick="selectPersistPreset('DOCS')" style="padding:10px 12px; text-align:left; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); border-radius:6px; color:white; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:8px; font-family:'Inter',sans-serif;">
              <span style="font-size:16px;">📁</span>
              <div>
                <div style="font-weight:600; color:#FFFFFF;">Meus Documentos</div>
                <div style="font-size:10px; color:#A2A2A2;">C:\\Users\\Public\\Documents\\Pasta_Segura</div>
              </div>
            </button>
            <button type="button" class="preset-loc-btn" onclick="selectPersistPreset('DRIVE_C')" style="padding:10px 12px; text-align:left; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); border-radius:6px; color:white; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:8px; font-family:'Inter',sans-serif;">
              <span style="font-size:16px;">💾</span>
              <div>
                <div style="font-weight:600; color:#FFFFFF;">Unidade C: (Raiz)</div>
                <div style="font-size:10px; color:#A2A2A2;">C:\\Pasta_Segura</div>
              </div>
            </button>
            <button type="button" class="preset-loc-btn" onclick="selectPersistPreset('DESKTOP')" style="padding:10px 12px; text-align:left; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); border-radius:6px; color:white; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:8px; font-family:'Inter',sans-serif;">
              <span style="font-size:16px;">🖥️</span>
              <div>
                <div style="font-weight:600; color:#FFFFFF;">Área de Trabalho (Desktop)</div>
                <div style="font-size:10px; color:#A2A2A2;">C:\\Users\\Public\\Desktop\\Pasta_Segura</div>
              </div>
            </button>
          </div>
          <div style="font-size:11px; color:var(--text-secondary); margin-bottom:4px; font-weight:500;">Caminho da pasta persistente:</div>
          <input type="text" id="modal-persist-folder" class="detail-input" value="C:\\Users\\Public\\Documents\\Pasta_Segura" style="font-size:12px; margin-top:2px;" />
        </div>

        <label style="font-size:13px; color:#E74C3C; display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="persistAction" value="REMOVE" onchange="togglePersistInput(false)">
          Remover pasta (Blindar 100%)
        </label>
      </div>
    </div>
    <div style="margin-bottom:20px; padding:10px; background:rgba(255,255,255,0.05); border-radius:8px; text-align:left;">
      <label style="font-size:13px; color:#F39C12; font-weight:600; display:flex; align-items:center; gap:8px; cursor:pointer;">
        <input type="checkbox" id="modal-block-games" checked>
        Filtro de Jogos e Conteúdo +18
      </label>
    </div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button class="modal-btn-confirm" onclick="confirmFreeze()">Confirmar</button>
    </div>
  `);
}

function togglePersistInput(show) {
  const container = document.getElementById('persist-presets-container');
  if (container) container.style.display = show ? 'block' : 'none';
}

function selectPersistPreset(type) {
  const input = document.getElementById('modal-persist-folder');
  if (!input) return;
  if (type === 'DOCS') {
    input.value = 'C:\\Users\\Public\\Documents\\Pasta_Segura';
  } else if (type === 'DRIVE_C') {
    input.value = 'C:\\Pasta_Segura';
  } else if (type === 'DESKTOP') {
    input.value = 'C:\\Users\\Public\\Desktop\\Pasta_Segura';
  }
}

async function confirmFreeze() {
  const selected = getSelectedMachines();
  const actionRadio = document.querySelector('input[name="persistAction"]:checked')?.value || 'MANTER';
  const blockGames = document.getElementById('modal-block-games')?.checked ? 'TRUE' : 'FALSE';
  
  let persistArg = 'MANTER';
  if (actionRadio === 'REMOVE') {
    persistArg = 'REMOVE';
  } else if (actionRadio === 'ALTERAR') {
    const customPath = document.getElementById('modal-persist-folder')?.value.trim();
    if (customPath) {
      persistArg = customPath;
    }
  }
  
  const cmd = `FREEZE:${persistArg}|BLOCKGAMES:${blockGames}`;
  for (const m of selected) {
    await sendSupabaseCommand(m.HardwareID, cmd);
    if (!cloudStatuses[m.HardwareID]) cloudStatuses[m.HardwareID] = {};
    cloudStatuses[m.HardwareID].status_protecao = 'CONGELADO';
  }
  closeModal();
  renderMachineList();
  showToast(`Comando CONGELAR enviado para ${selected.length} máquina(s)!`, 'success');
}

// --- Descongelar ---
async function thawSelected() {
  const selected = getSelectedMachines();
  if (selected.length === 0) { showToast('Selecione pelo menos uma máquina', 'warning'); return; }

  showModal(`
    <div class="modal-title">🔥 Descongelar / Desbloquear ${selected.length} Máquina(s)</div>
    <p style="color: var(--text-secondary); font-size: 14px; text-align: center; margin-bottom: 20px;">
      As máquinas entrarão em Modo Manutenção (descongeladas/desbloqueadas) na próxima checagem.
    </p>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button style="flex:1; padding:14px; border:none; border-radius:8px; font-family:'Inter',sans-serif; font-size:14px; font-weight:700; cursor:pointer; background:#E74C3C; color:white; text-transform:uppercase;" onclick="confirmThaw()">Descongelar</button>
    </div>
  `);
}

async function confirmThaw() {
  const selected = getSelectedMachines();
  for (const m of selected) {
    await sendSupabaseCommand(m.HardwareID, 'THAW');
    if (!cloudStatuses[m.HardwareID]) cloudStatuses[m.HardwareID] = {};
    cloudStatuses[m.HardwareID].status_protecao = 'DESCONGELADO';
  }
  closeModal();
  renderMachineList();
  showToast(`Comando DESCONGELAR enviado para ${selected.length} máquina(s)!`, 'success');
}

// --- Revogar ---
async function revokeSelected() {
  const selected = getSelectedMachines();
  if (selected.length === 0) { showToast('Selecione pelo menos uma máquina', 'warning'); return; }

  showModal(`
    <div class="modal-title">🚫 Revogar ${selected.length} Licença(s)</div>
    <p style="color: var(--accent-red); font-size: 14px; text-align: center; margin-bottom: 20px; font-weight: 600;">
      ⚠️ ATENÇÃO: As chaves serão invalidadas e as máquinas bloqueadas permanentemente!
    </p>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button style="flex:1; padding:14px; border:none; border-radius:8px; font-family:'Inter',sans-serif; font-size:14px; font-weight:700; cursor:pointer; background:#C0392B; color:white; text-transform:uppercase;" onclick="confirmRevoke()">Revogar</button>
    </div>
  `);
}

async function confirmRevoke() {
  const selected = getSelectedMachines();
  for (const m of selected) {
    m.DataExpiracao = '1970-01-01';
    m.ChaveGerada = 'REVOGADA';
    await syncSupabase(m.HardwareID, 'REVOGADA', '1970-01-01');
    await sendSupabaseCommand(m.HardwareID, 'REVOKE');
  }
  saveDB();
  closeModal();
  renderMachineList();
  showToast(`${selected.length} licença(s) REVOGADA(s)!`, 'success');
}

// --- Atualização OTA ---
function showUpdateModal() {
  const selected = getSelectedMachines();
  if (selected.length === 0) { showToast('Selecione pelo menos uma máquina', 'warning'); return; }

  const defaultUrl = 'https://raw.githubusercontent.com/joelson217/Gerenciador_Area_Segura/main/AreaSegura.exe';

  showModal(`
    <div class="modal-title">🔄 Atualizar ${selected.length} Máquina(s)</div>
    <p style="color:var(--text-secondary); font-size:12px; margin-bottom:12px; text-align:center;">
      O novo binário do Área Segura será baixado e instalado silenciosamente no Windows do notebook/PC selecionado.
    </p>
    <div class="detail-field">
      <div class="detail-label">URL Direta do Executável (.exe)</div>
      <input type="url" class="detail-input" id="modal-update-url" value="${defaultUrl}">
    </div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button style="flex:1; padding:14px; border:none; border-radius:8px; font-family:'Inter',sans-serif; font-size:14px; font-weight:700; cursor:pointer; background:var(--accent-purple); color:white; text-transform:uppercase;" onclick="confirmUpdate()">Enviar Atualização</button>
    </div>
  `);
}

async function confirmUpdate() {
  const url = document.getElementById('modal-update-url').value.trim();
  if (!url) { showToast('Digite uma URL válida', 'error'); return; }

  const selected = getSelectedMachines();
  for (const m of selected) {
    await sendSupabaseCommand(m.HardwareID, `UPDATE|${url}`);
  }
  closeModal();
  showToast(`Atualização enviada para ${selected.length} máquina(s)!`, 'success');
}

// --- Excluir Máquina do Cadastro ---
function deleteSingleMachine(hwId) {
  if (!selectedClient || !selectedClient.Maquinas) return;
  const m = selectedClient.Maquinas.find(x => x.HardwareID === hwId);
  if (!m) return;

  showModal(`
    <div class="modal-title" style="color:#E94560;">🗑️ Remover Máquina</div>
    <p style="color:#ccc; margin-bottom:15px; text-align:center; font-size:13px;">
      Deseja remover a máquina <strong style="color:white;">${escapeHtml(hwId)}</strong> do cadastro de <strong>${escapeHtml(selectedClient.Instituicao)}</strong>?
    </p>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button class="modal-btn-confirm" style="background:#E94560;" onclick="confirmDeleteSingleMachine('${escapeHtml(hwId)}')">REMOVER</button>
    </div>
  `);
}

async function confirmDeleteSingleMachine(hwId) {
  if (!selectedClient || !selectedClient.Maquinas) return;
  const idx = selectedClient.Maquinas.findIndex(x => x.HardwareID === hwId);
  if (idx >= 0) {
    selectedClient.Maquinas.splice(idx, 1);
    try {
      await fetch(`${SUPABASE_URL}/licencas?hardware_id=eq.${hwId}`, {
        method: 'DELETE',
        headers: supaHeaders
      });
    } catch (e) {}
    saveDB();
    closeModal();
    renderMachineList();
    showToast(`Máquina ${hwId} removida com sucesso!`, 'success');
  }
}

function deleteSelectedMachines() {
  const selected = getSelectedMachines();
  if (selected.length === 0) { showToast('Selecione pelo menos uma máquina', 'warning'); return; }

  showModal(`
    <div class="modal-title" style="color:#E94560;">🗑️ Remover ${selected.length} Máquina(s)</div>
    <p style="color:#ccc; margin-bottom:15px; text-align:center; font-size:13px;">
      Deseja remover as <strong>${selected.length} máquina(s)</strong> selecionadas do cadastro deste cliente?
    </p>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button class="modal-btn-confirm" style="background:#E94560;" onclick="confirmDeleteSelectedMachines()">REMOVER</button>
    </div>
  `);
}

async function confirmDeleteSelectedMachines() {
  const selected = getSelectedMachines();
  for (const m of selected) {
    const idx = selectedClient.Maquinas.findIndex(x => x.HardwareID === m.HardwareID);
    if (idx >= 0) selectedClient.Maquinas.splice(idx, 1);
    try {
      await fetch(`${SUPABASE_URL}/licencas?hardware_id=eq.${m.HardwareID}`, {
        method: 'DELETE',
        headers: supaHeaders
      });
    } catch (e) {}
  }
  saveDB();
  closeModal();
  renderMachineList();
  showToast(`${selected.length} máquina(s) removida(s) do cadastro!`, 'success');
}

// --- Desinstalar Remotamente do PC ---
function uninstallSelected() {
  const selected = getSelectedMachines();
  if (selected.length === 0) { showToast('Selecione pelo menos uma máquina', 'warning'); return; }

  showModal(`
    <div class="modal-title" style="color:#E94560;">⚡ Desinstalar Remotamente (${selected.length} máquinas)</div>
    <p style="color: #ccc; font-size: 14px; text-align: center; margin-bottom: 20px;">
      Deseja realmente <strong>DESINSTALAR</strong> o Área Segura dos computadores selecionados?<br>
      <span style="font-size:12px; color:var(--text-secondary); display:block; margin-top:8px;">O programa será removido do Windows, a internet será 100% liberada e o computador será reiniciado.</span>
    </p>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button style="flex:1; padding:14px; border:none; border-radius:8px; font-family:'Inter',sans-serif; font-size:14px; font-weight:700; cursor:pointer; background:#E94560; color:white; text-transform:uppercase;" onclick="confirmUninstall()">Confirmar Desinstalação</button>
    </div>
  `);
}

async function confirmUninstall() {
  const selected = getSelectedMachines();
  for (const m of selected) {
    await sendSupabaseCommand(m.HardwareID, 'UNINSTALL');
    if (cloudStatuses[m.HardwareID]) {
      cloudStatuses[m.HardwareID].status_protecao = 'DESINSTALADO';
    }
  }
  closeModal();
  showToast(`Comando de DESINSTALAÇÃO enviado para ${selected.length} máquina(s)!`, 'success');
  setTimeout(() => renderMachineList(), 1000);
}

// ============================================
// Relatório de Expirando
// ============================================
function renderExpiringReport() {
  const container = document.getElementById('expiring-list');
  if (!container) return;

  let expList = [];
  DB.forEach(c => {
    (c.Maquinas || []).forEach(m => {
      const days = getDaysRemaining(m.DataExpiracao);
      if (days <= 30) {
        expList.push({
          clientId: c.Id,
          instituicao: c.Instituicao,
          laboratorio: m.Laboratorio || 'Lab Principal',
          hardwareId: m.HardwareID,
          dataExp: formatDate(m.DataExpiracao),
          days: days,
          statusText: days <= 0 ? `VENCIDA HÁ ${Math.abs(days)} DIAS` : `VENCE EM ${days} DIAS`,
          isExpired: days <= 0
        });
      }
    });
  });

  if (expList.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✅</div>
        <div class="empty-state-text">Todas as licenças estão em dia!</div>
      </div>`;
    return;
  }

  expList.sort((a, b) => a.days - b.days);

  let html = '';
  expList.forEach(item => {
    html += `
      <div class="expiring-item ${item.isExpired ? 'expired' : ''}" onclick="navigateTo('detail', DB.find(x => x.Id === '${item.clientId}'))">
        <div class="expiring-item-title">${escapeHtml(item.instituicao)}</div>
        <div class="expiring-item-meta">${escapeHtml(item.laboratorio)} • ${item.hardwareId} • ${item.dataExp}</div>
        <div class="expiring-item-status" style="color: ${item.isExpired ? 'var(--accent-red)' : 'var(--accent-orange)'}">
          ${item.statusText}
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

// ============================================
// Novo Cliente
// ============================================
function showNewClientModal() {
  showModal(`
    <div class="modal-title">👤 Novo Cliente</div>
    <div class="detail-field">
      <div class="detail-label">Nome da Instituição / Cliente</div>
      <input type="text" class="detail-input" id="modal-new-name" placeholder="Ex: Escola Municipal...">
    </div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" onclick="closeModal()">Cancelar</button>
      <button class="modal-btn-confirm" onclick="confirmNewClient()">Cadastrar</button>
    </div>
  `);
}

function confirmNewClient() {
  const name = document.getElementById('modal-new-name').value.trim();
  if (!name) { showToast('Digite o nome do cliente', 'error'); return; }

  const newClient = {
    Id: generateId(),
    Instituicao: name,
    Localidade: '',
    Responsavel: '',
    Contato: '',
    Ambientes: ['Lab Principal'],
    Maquinas: [],
    NomeExibicao: name,
    CorAlerta: 'White'
  };

  DB.push(newClient);
  saveDB();
  closeModal();
  showToast(`Cliente "${name}" cadastrado!`, 'success');
  navigateTo('detail', newClient);
}

// ============================================
// Importar/Exportar Banco de Dados
// ============================================
function exportDB() {
  const data = JSON.stringify(DB, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `banco_clientes_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Banco exportado com sucesso!', 'success');
}

function importDB() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (Array.isArray(data)) {
          DB = data;
          saveDB();
          showToast(`${data.length} cliente(s) importado(s)!`, 'success');
          navigateTo('dashboard');
        } else {
          showToast('Formato inválido', 'error');
        }
      } catch (err) {
        showToast('Erro ao ler arquivo', 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ============================================
// Modal System
// ============================================
function showModal(content) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'app-modal';
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-handle"></div>
      ${content}
    </div>
  `;
  document.body.appendChild(overlay);
}

function closeModal() {
  const modal = document.getElementById('app-modal');
  if (modal) modal.remove();
}

// ============================================
// Utilitários
// ============================================
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function copyToClipboard(text) {
  if (!text || text === 'N/A' || text === 'REVOGADA') return;
  navigator.clipboard.writeText(text).then(() => {
    showToast('Chave copiada! 📋', 'success');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Chave copiada! 📋', 'success');
  });
}

function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

async function refreshAll() {
  const btn = document.querySelector('.header-refresh');
  if (btn) btn.classList.add('spinning');

  await syncFromCloud();

  if (currentPage === 'dashboard') renderDashboard();
  else if (currentPage === 'clients') renderClientList();
  else if (currentPage === 'machines') renderMachineList();
  else if (currentPage === 'expiring') renderExpiringReport();

  setTimeout(() => {
    if (btn) btn.classList.remove('spinning');
    showToast('Dados atualizados!', 'success');
  }, 500);
}

// ============================================
// Segurança: PIN e Biometria
// ============================================
let pinCode = '';
let lockScreenMode = 'unlock';
let tempSetupPin = '';
let biometricsAvailable = false;

async function hashPIN(pin) {
  const msgUint8 = new TextEncoder().encode(pin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkBiometricsSupport() {
  if (window.PublicKeyCredential && 
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      return false;
    }
  }
  return false;
}

async function registerBiometrics() {
  const challenge = new Uint8Array(32);
  window.crypto.getRandomValues(challenge);
  
  const userId = new Uint8Array(16);
  window.crypto.getRandomValues(userId);

  const publicKey = {
    challenge: challenge,
    rp: {
      name: "Área Segura",
      id: window.location.hostname || "localhost"
    },
    user: {
      id: userId,
      name: "usuario@areasegura",
      displayName: "Usuário Área Segura"
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 }
    ],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      userVerification: "required"
    },
    timeout: 60000
  };

  try {
    const credential = await navigator.credentials.create({ publicKey });
    if (credential) {
      const credentialId = btoa(String.fromCharCode.apply(null, new Uint8Array(credential.rawId)));
      localStorage.setItem('security_bio_cred_id', credentialId);
      return true;
    }
  } catch (e) {
    console.error("Biometria recusada ou erro:", e);
    throw e;
  }
  return false;
}

async function authenticateBiometrics() {
  const credId = localStorage.getItem('security_bio_cred_id');
  if (!credId) return false;

  const challenge = new Uint8Array(32);
  window.crypto.getRandomValues(challenge);

  const rawId = new Uint8Array(
    atob(credId).split("").map(c => c.charCodeAt(0))
  );

  const publicKey = {
    challenge: challenge,
    allowCredentials: [{
      id: rawId,
      type: 'public-key'
    }],
    userVerification: "required",
    rpId: window.location.hostname || "localhost",
    timeout: 60000
  };

  try {
    const assertion = await navigator.credentials.get({ publicKey });
    return !!assertion;
  } catch (e) {
    console.error("Erro na autenticação biométrica:", e);
    return false;
  }
}

function pressPinNum(num) {
  if (pinCode.length >= 6) return;
  pinCode += num;
  updatePinDots();
  if (pinCode.length === 6) {
    setTimeout(handlePinComplete, 200);
  }
}

function deletePinDigit() {
  if (pinCode.length === 0) return;
  pinCode = pinCode.slice(0, -1);
  updatePinDots();
}

function updatePinDots() {
  const dots = document.querySelectorAll('#pin-dots .dot');
  dots.forEach((dot, idx) => {
    dot.className = 'dot';
    if (idx < pinCode.length) {
      dot.classList.add('filled');
    }
  });
}

async function handlePinComplete() {
  const currentPin = pinCode;
  pinCode = ''; 
  
  if (lockScreenMode === 'unlock') {
    const hash = await hashPIN(currentPin);
    const savedHash = localStorage.getItem('security_pin_hash');
    if (hash === savedHash) {
      unlockApp();
    } else {
      shakePinDots();
      showToast('PIN incorreto!', 'error');
      updatePinDots();
    }
  } else if (lockScreenMode === 'setup') {
    tempSetupPin = currentPin;
    lockScreenMode = 'confirm';
    document.getElementById('lock-message').textContent = 'Confirme seu PIN de 6 dígitos';
    updatePinDots();
  } else if (lockScreenMode === 'confirm') {
    if (currentPin === tempSetupPin) {
      const hash = await hashPIN(currentPin);
      localStorage.setItem('security_pin_hash', hash);
      localStorage.setItem('security_pin_enabled', 'true');
      
      showToast('PIN configurado com sucesso!', 'success');
      renderSettings();
      hideLockScreen();
    } else {
      shakePinDots();
      showToast('Os PINs não coincidem! Tente novamente.', 'error');
      lockScreenMode = 'setup';
      document.getElementById('lock-message').textContent = 'Defina um PIN de 6 dígitos';
      tempSetupPin = '';
      updatePinDots();
    }
  }
}

function shakePinDots() {
  const pinDotsContainer = document.getElementById('pin-dots');
  const dots = document.querySelectorAll('#pin-dots .dot');
  dots.forEach(d => d.classList.add('error'));
  pinDotsContainer.classList.add('shake-animation');
  setTimeout(() => {
    pinDotsContainer.classList.remove('shake-animation');
    dots.forEach(d => d.classList.remove('error'));
  }, 400);
}

function showLockScreen(mode = 'unlock') {
  lockScreenMode = mode;
  pinCode = '';
  updatePinDots();
  
  const lockEl = document.getElementById('lock-screen');
  lockEl.classList.add('active');
  
  const msgEl = document.getElementById('lock-message');
  const bioBtn = document.getElementById('btn-biometric-auth');
  
  if (mode === 'unlock') {
    msgEl.textContent = 'Digite o PIN para desbloquear';
    const isBioEnabled = localStorage.getItem('security_bio_enabled') === 'true';
    if (isBioEnabled && localStorage.getItem('security_bio_cred_id')) {
      bioBtn.style.visibility = 'visible';
      setTimeout(triggerBiometricAuth, 300);
    } else {
      bioBtn.style.visibility = 'hidden';
    }
  } else if (mode === 'setup') {
    msgEl.textContent = 'Defina um PIN de 6 dígitos';
    bioBtn.style.visibility = 'hidden';
  }
}

function hideLockScreen() {
  const lockEl = document.getElementById('lock-screen');
  lockEl.classList.remove('active');
}

function unlockApp() {
  hideLockScreen();
  showToast('Desbloqueado com sucesso!', 'success');
  navigateTo('dashboard');
}

async function triggerBiometricAuth() {
  const success = await authenticateBiometrics();
  if (success) {
    unlockApp();
  } else {
    showToast('Falha na biometria. Use o PIN.', 'error');
  }
}

// Configurações e Switches
async function togglePinSecurity(checked) {
  if (checked) {
    showLockScreen('setup');
  } else {
    const confirmDisable = confirm("Deseja desativar o bloqueio por PIN? A biometria também será desativada.");
    if (confirmDisable) {
      localStorage.removeItem('security_pin_hash');
      localStorage.removeItem('security_pin_enabled');
      localStorage.removeItem('security_bio_enabled');
      localStorage.removeItem('security_bio_cred_id');
      showToast('Bloqueio desativado.', 'success');
      renderSettings();
    } else {
      document.getElementById('setting-pin-enabled').checked = true;
    }
  }
}

async function toggleBioSecurity(checked) {
  if (checked) {
    try {
      showToast('Autentique-se para ativar a biometria...', 'info');
      const registered = await registerBiometrics();
      if (registered) {
        localStorage.setItem('security_bio_enabled', 'true');
        showToast('Biometria ativada!', 'success');
        renderSettings();
      } else {
        document.getElementById('setting-bio-enabled').checked = false;
      }
    } catch (e) {
      document.getElementById('setting-bio-enabled').checked = false;
      showToast('Erro ao ativar biometria.', 'error');
    }
  } else {
    localStorage.removeItem('security_bio_enabled');
    localStorage.removeItem('security_bio_cred_id');
    showToast('Biometria desativada.', 'success');
    renderSettings();
  }
}

function startPinChange() {
  showLockScreen('setup');
}

function renderSettings() {
  const isPinEnabled = localStorage.getItem('security_pin_enabled') === 'true';
  const isBioEnabled = localStorage.getItem('security_bio_enabled') === 'true';
  
  const pinToggle = document.getElementById('setting-pin-enabled');
  const bioToggle = document.getElementById('setting-bio-enabled');
  
  if (pinToggle) pinToggle.checked = isPinEnabled;
  if (bioToggle) bioToggle.checked = isBioEnabled;
  
  const changePinRow = document.getElementById('change-pin-row');
  const bioSettingsItem = document.getElementById('biometric-settings-item');
  
  if (isPinEnabled) {
    if (changePinRow) changePinRow.style.display = 'block';
    if (biometricsAvailable) {
      if (bioSettingsItem) bioSettingsItem.style.display = 'flex';
    }
  } else {
    if (changePinRow) changePinRow.style.display = 'none';
    if (bioSettingsItem) bioSettingsItem.style.display = 'none';
  }
}

// Dynamic Version & Auto-Update Check
let currentAppVersion = '1.4.0';

async function checkAppVersion() {
  try {
    const res = await fetch(`./version.json?_t=${Date.now()}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.version) {
        currentAppVersion = data.version;
        const versionEl = document.getElementById('app-version-display');
        if (versionEl) versionEl.textContent = `v${data.version} PWA`;

        const savedVersion = localStorage.getItem('area_segura_app_version');
        if (savedVersion && savedVersion !== data.version) {
          localStorage.setItem('area_segura_app_version', data.version);
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(registrations => {
              for (let reg of registrations) reg.update();
            });
          }
          showToast(`Aplicativo atualizado para v${data.version}!`, 'success');
          setTimeout(() => { window.location.reload(); }, 1000);
        } else if (!savedVersion) {
          localStorage.setItem('area_segura_app_version', data.version);
        }
      }
    }
  } catch (e) {}
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
  showToast(`Aparência: ${nextTheme === 'slate' ? 'Clean Slate' : 'Cyber Dark'}`, 'info');
}

// ============================================
// Inicialização
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  // Inicializar Tema salvo
  initTheme();

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.update();
    }).catch(() => {});
  }

  // Carregar DB
  loadDB();
  syncFromCloud();
  checkAppVersion();

  // Checar suporte biometria
  checkBiometricsSupport().then(supported => {
    biometricsAvailable = supported;
    renderSettings();
  });

  // Splash Screen
  setTimeout(() => {
    document.getElementById('splash-screen').classList.add('hidden');
    document.getElementById('app').classList.add('visible');
    
    if (localStorage.getItem('security_pin_enabled') === 'true') {
      showLockScreen('unlock');
    } else {
      navigateTo('dashboard');
    }
  }, 2200);

  // Navegação Bottom
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.page);
    });
  });

  // Busca de clientes
  const searchInput = document.getElementById('search-clients');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      renderClientList(e.target.value);
    });
  }

  // Auto-refresh da nuvem a cada 60s e checagem de versão a cada 30s
  setInterval(() => {
    syncFromCloud();
  }, 60000);

  setInterval(() => {
    checkAppVersion();
  }, 30000);

  // Atualizar ao voltar ao foco/visibilidade da aba no celular
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      syncFromCloud();
      checkAppVersion();
    }
  });
});

