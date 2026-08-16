// ============================================
// ÁREA SEGURA PRO - PORTAL EXCLUSIVO DO CLIENTE
// Página independente do Gerenciador administrativo. Não carrega nenhum
// dado ou lógica de admin — só fala com a Edge Function via portal-login/
// portal-refresh/portal-command, que devolvem apenas os dados do próprio
// cliente autenticado.
// ============================================

const LICENSE_API_URL = 'https://inndgkbugwegrkbvogew.supabase.co/functions/v1/license-api';

let portalSessionToken = null;
let portalClient = null;
let portalStatuses = {};

async function callLicenseApi(action, payload = {}) {
  try {
    const res = await fetch(LICENSE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload })
    });
    return await res.json();
  } catch (e) {
    return { error: 'offline' };
  }
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
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}

function getPortalKeyFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('u') || params.get('portal') || params.get('cliente') || '';
}

async function submitPortalLogin() {
  const userEl = document.getElementById('portal-login-user');
  const passEl = document.getElementById('portal-login-pass');
  const errorEl = document.getElementById('portal-login-error');
  const user = userEl?.value.trim() || '';
  const pass = passEl?.value || '';

  if (!user) {
    if (errorEl) errorEl.textContent = 'Digite o usuário de acesso.';
    userEl?.focus();
    return;
  }

  const result = await callLicenseApi('portal-login', { portal_key: user, portal_pass: pass });

  if (result.error || !result.client) {
    if (errorEl) errorEl.textContent = result.error === 'Senha incorreta.' ? 'Usuário ou senha incorretos.' : 'Portal não encontrado. Confira o usuário digitado.';
    passEl?.focus();
    return;
  }

  portalSessionToken = result.token;
  portalStatuses = result.statuses || {};
  enterPortal(result.client);
}

function enterPortal(client) {
  portalClient = client;
  document.getElementById('portal-login-screen').classList.remove('active');
  document.getElementById('portal-app').style.display = 'block';
  document.getElementById('portal-client-name').textContent = client.Instituicao || 'Cliente';
  renderPortalMachines();
  showToast(`Bem-vindo, ${client.Instituicao}!`, 'success');
}

function renderPortalMachines() {
  const container = document.getElementById('portal-machines-list');
  if (!container || !portalClient) return;
  container.innerHTML = '';

  const machines = portalClient.Maquinas || [];
  if (machines.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-text">Nenhuma máquina cadastrada ainda.</div></div>';
    return;
  }

  machines.forEach(m => {
    const cloud = portalStatuses[m.HardwareID] || {};
    const status = cloud.status_protecao || 'DESCONHECIDO';
    const isFrozen = status === 'CONGELADO';
    const isPending = status === 'PENDENTE';

    const isUnavailable = status === 'INDISPONIVEL';

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
    } else if (isUnavailable) {
      badgeClass = 'status-pending';
      statusIcon = 'icon-alert-triangle';
      statusLabel = 'Proteção Indisponível';
    }

    const card = document.createElement('div');
    card.className = 'machine-card';
    card.innerHTML = `
      <div class="machine-card-header">
        <div class="machine-card-header-left">
          <span class="machine-card-title">${escapeHtml(m.NomeExibicao || m.HardwareID)}</span>
        </div>
        <span class="machine-status-badge ${badgeClass}"><svg class="icon"><use href="#${statusIcon}"/></svg> ${statusLabel}</span>
      </div>
      <div class="machine-card-body">
        <div><strong>Ambiente:</strong> ${escapeHtml(m.Laboratorio || 'Lab Principal')}</div>
        <div><svg class="icon"><use href="#icon-calendar"/></svg> <strong>Validade:</strong> ${m.DataExpiracao || 'Indefinida'}</div>
      </div>
      <div class="machine-card-footer" style="gap:8px;">
        <span>Última Sinc: ${cloud.ultima_sincronizacao ? new Date(cloud.ultima_sincronizacao).toLocaleString('pt-BR') : 'Sem dados recentes'}</span>
        ${isPending ? '' : `
          <button class="btn-small-action" onclick="portalCommand('${escapeHtml(m.HardwareID)}', '${isFrozen ? 'THAW' : 'FREEZE|MANTER'}')">
            <svg class="icon"><use href="#${isFrozen ? 'icon-flame' : 'icon-snowflake'}"/></svg> ${isFrozen ? 'Descongelar' : 'Congelar'}
          </button>
        `}
      </div>
    `;
    container.appendChild(card);
  });
}

async function portalCommand(hwId, comando) {
  const result = await callLicenseApi('portal-command', { token: portalSessionToken, hardware_id: hwId, comando });
  if (result.error) {
    showToast('Não foi possível enviar o comando. Tente novamente.', 'error');
    return;
  }
  showToast('Comando enviado! A máquina aplica em instantes.', 'success');
  setTimeout(portalRefresh, 2000);
}

async function portalRefresh() {
  if (!portalSessionToken) return;
  const result = await callLicenseApi('portal-refresh', { token: portalSessionToken });
  if (result.error) {
    if (result.error === 'sessão expirada') exitPortal();
    return;
  }
  portalClient = result.client;
  portalStatuses = result.statuses || {};
  renderPortalMachines();
}

function exitPortal() {
  window.location.href = window.location.origin + window.location.pathname;
}

document.addEventListener('DOMContentLoaded', () => {
  const key = getPortalKeyFromUrl();
  const userInput = document.getElementById('portal-login-user');
  if (userInput && key && !key.includes('-')) userInput.value = key;

  setTimeout(() => {
    const target = userInput && userInput.value ? document.getElementById('portal-login-pass') : userInput;
    target?.focus();
  }, 200);

  setInterval(() => {
    if (portalSessionToken) portalRefresh();
  }, 15000);
});
