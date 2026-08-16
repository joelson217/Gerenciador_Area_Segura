// ============================================
// ÁREA SEGURA PRO - LICENSE API (Supabase Edge Function)
// Camada única de acesso ao banco. Nenhum segredo (HMAC, admin token,
// service role) sai daqui. O cliente (app.js / AreaSegura.ps1) nunca
// mais fala direto com a tabela `licencas`.
// ============================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN")!;
const LICENSE_HMAC_SECRET = Deno.env.get("LICENSE_HMAC_SECRET")!;
const PORTAL_TOKEN_SECRET = Deno.env.get("PORTAL_TOKEN_SECRET")!;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// --- HMAC helpers (equivalentes ao antigo getActivationKey do app.js / Get-ActivationKey do .ps1) ---
async function hmacHex16(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16)
    .toUpperCase();
}

async function computeActivationKey(hardwareId: string, expirationDate: string): Promise<string> {
  const hash = await hmacHex16(LICENSE_HMAC_SECRET, `${hardwareId}|${expirationDate}`);
  return `${expirationDate}-${hash}`;
}

async function makePortalToken(clientId: string): Promise<string> {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 12; // 12h
  const payload = `${clientId}|${expiresAt}`;
  const sig = await hmacHex16(PORTAL_TOKEN_SECRET, payload);
  return btoa(`${payload}|${sig}`);
}

async function verifyPortalToken(token: string): Promise<string | null> {
  try {
    const decoded = atob(token);
    const [clientId, expiresAtStr, sig] = decoded.split("|");
    const expected = await hmacHex16(PORTAL_TOKEN_SECRET, `${clientId}|${expiresAtStr}`);
    if (sig !== expected) return null;
    if (Date.now() > Number(expiresAtStr)) return null;
    return clientId;
  } catch {
    return null;
  }
}

function requireAdmin(body: any): boolean {
  return typeof body.admin_token === "string" && body.admin_token === ADMIN_TOKEN;
}

// --- Acesso à tabela `licencas` (só este arquivo, com service_role, fala com ela) ---
async function getLicenseRow(hardwareId: string) {
  const { data } = await db
    .from("licencas")
    .select("*")
    .eq("hardware_id", hardwareId)
    .maybeSingle();
  return data;
}

async function upsertLicenseRow(row: Record<string, unknown>) {
  await db.from("licencas").upsert(row, { onConflict: "hardware_id" });
}

async function patchLicenseRow(hardwareId: string, patch: Record<string, unknown>) {
  await db.from("licencas").update(patch).eq("hardware_id", hardwareId);
}

// ============================================
// Handlers por action
// ============================================

// Chamado pelo AreaSegura.ps1 instalado no PC do cliente. Substitui a
// leitura direta da tabela + o cálculo local do HMAC (Validate-License).
async function handleCheckin(body: any) {
  const hardwareId = String(body.hardware_id || "");
  if (!hardwareId) return json({ error: "hardware_id obrigatório" }, 400);

  let row = await getLicenseRow(hardwareId);

  if (!row) {
    // Auto-registro de máquina nova, igual ao comportamento anterior.
    await upsertLicenseRow({
      hardware_id: hardwareId,
      chave_ativacao: `PENDENTE|IP:${body.public_ip || "Desconhecido"}|HOST:${body.hostname || ""}|LOCALIP:${body.local_ip || ""}`,
      data_expiracao: "1970-01-01",
      status_protecao: "PENDENTE",
      pasta_persistente: "Nenhuma",
      comando_remoto: "NONE",
      ultima_sincronizacao: new Date().toISOString(),
    });
    return json({ valid: false, comando_remoto: "NONE", status: "PENDENTE" });
  }

  // Processa e limpa o comando remoto pendente (mesma lógica do Process-RemoteCommand).
  const comando = row.comando_remoto && row.comando_remoto !== "NONE" ? row.comando_remoto : "NONE";
  if (comando !== "NONE") {
    await patchLicenseRow(hardwareId, { comando_remoto: "NONE" });
  }

  let valid = false;
  if (row.chave_ativacao && !String(row.chave_ativacao).startsWith("PENDENTE")) {
    const expected = await computeActivationKey(hardwareId, row.data_expiracao);
    if (expected === row.chave_ativacao && new Date(row.data_expiracao) > new Date()) {
      valid = true;
    }
  }

  return json({
    valid,
    comando_remoto: comando,
    data_expiracao: row.data_expiracao,
    status: row.status_protecao,
  });
}

// PC reportando o próprio status (freeze/unfreeze etc). Substitui Sync-StatusToCloud.
async function handleSyncStatus(body: any) {
  const hardwareId = String(body.hardware_id || "");
  if (!hardwareId) return json({ error: "hardware_id obrigatório" }, 400);
  await patchLicenseRow(hardwareId, {
    status_protecao: body.status_protecao,
    pasta_persistente: body.pasta_persistente || "Nenhuma",
    ultima_sincronizacao: new Date().toISOString(),
  });
  return json({ ok: true });
}

// Admin (Gerenciador) emitindo uma licença nova. O segredo nunca sai daqui.
async function handleActivate(body: any) {
  if (!requireAdmin(body)) return json({ error: "não autorizado" }, 401);
  const hardwareId = String(body.hardware_id || "");
  const expirationDate = String(body.expiration_date || "");
  if (!hardwareId || !expirationDate) return json({ error: "parâmetros obrigatórios" }, 400);

  const chave = await computeActivationKey(hardwareId, expirationDate);
  await upsertLicenseRow({
    hardware_id: hardwareId,
    chave_ativacao: chave,
    data_expiracao: expirationDate,
    comando_remoto: "NONE",
  });
  return json({ ok: true, chave_ativacao: chave });
}

// Confirma uma chave digitada manualmente no PC (fluxo offline de ativação),
// sem nunca expor o segredo — só diz se a chave bate com o hardware_id.
async function handleVerifyKey(body: any) {
  const hardwareId = String(body.hardware_id || "");
  const chave = String(body.chave || "");
  const match = chave.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (!hardwareId || !match) return json({ valid: false });

  const expirationDate = match[1];
  const expected = await computeActivationKey(hardwareId, expirationDate);
  const valid = expected === chave && new Date(expirationDate) > new Date();
  if (valid) {
    await upsertLicenseRow({ hardware_id: hardwareId, chave_ativacao: chave, data_expiracao: expirationDate, comando_remoto: "NONE" });
  }
  return json({ valid, data_expiracao: expirationDate });
}

// Admin enviando comando remoto (bloquear/desbloquear/desinstalar etc).
async function handleCommand(body: any) {
  if (!requireAdmin(body)) return json({ error: "não autorizado" }, 401);
  const hardwareId = String(body.hardware_id || "");
  const comando = String(body.comando || "");
  if (!hardwareId || !comando) return json({ error: "parâmetros obrigatórios" }, 400);

  const patch: Record<string, unknown> = { comando_remoto: comando };
  if (comando === "REVOKE") {
    // Além de avisar o PC, invalida a licença no servidor — sem isso o
    // próximo check-in ainda leria a chave antiga como válida.
    patch.chave_ativacao = "REVOGADA";
    patch.data_expiracao = "1970-01-01";
  }
  await patchLicenseRow(hardwareId, patch);
  return json({ ok: true });
}

// Admin sincronizando o dashboard: status de todas as licenças + backup do banco de clientes.
async function handleAdminSync(body: any) {
  if (!requireAdmin(body)) return json({ error: "não autorizado" }, 401);
  const { data: statuses } = await db
    .from("licencas")
    .select("hardware_id,status_protecao,pasta_persistente,comando_remoto,ultima_sincronizacao,chave_ativacao,data_expiracao")
    .neq("hardware_id", "DB_BACKUP");

  const backupRow = await getLicenseRow("DB_BACKUP");
  let dbBackup: unknown[] = [];
  if (backupRow?.chave_ativacao) {
    try {
      dbBackup = JSON.parse(backupRow.chave_ativacao);
    } catch {
      dbBackup = [];
    }
  }
  return json({ statuses: statuses || [], db_backup: dbBackup });
}

// Admin salvando o banco de clientes (substitui o POST direto de DB_BACKUP).
async function handleAdminSaveDb(body: any) {
  if (!requireAdmin(body)) return json({ error: "não autorizado" }, 401);
  await upsertLicenseRow({
    hardware_id: "DB_BACKUP",
    chave_ativacao: JSON.stringify(body.db || []),
    data_expiracao: "1970-01-01",
    status_protecao: "BACKUP",
    pasta_persistente: "Nenhuma",
    comando_remoto: "NONE",
    ultima_sincronizacao: new Date().toISOString(),
  });
  return json({ ok: true });
}

// Busca o status ao vivo (na tabela `licencas`) só das máquinas que
// pertencem a este cliente — nunca a tabela inteira.
async function getScopedStatuses(client: any) {
  const hwIds: string[] = (client.Maquinas || []).map((m: any) => m.HardwareID).filter(Boolean);
  if (hwIds.length === 0) return {};
  const { data } = await db
    .from("licencas")
    .select("hardware_id,status_protecao,pasta_persistente,comando_remoto,ultima_sincronizacao,data_expiracao")
    .in("hardware_id", hwIds);
  const map: Record<string, unknown> = {};
  (data || []).forEach((r: any) => { map[r.hardware_id] = r; });
  return map;
}

async function findClientByPortalKey(key: string) {
  const backupRow = await getLicenseRow("DB_BACKUP");
  let allClients: any[] = [];
  try {
    allClients = JSON.parse(backupRow?.chave_ativacao || "[]");
  } catch {
    allClients = [];
  }
  const lower = key.toLowerCase();
  return allClients.find((c) => c.Id === key || (c.PortalUser && c.PortalUser.toLowerCase() === lower));
}

// Login do portal do cliente: valida a senha no servidor e devolve
// APENAS os dados daquele cliente — nunca o array inteiro de clientes.
async function handlePortalLogin(body: any) {
  const key = String(body.portal_key || "");
  const pass = String(body.portal_pass || "");
  if (!key) return json({ error: "parâmetro obrigatório" }, 400);

  const client = await findClientByPortalKey(key);
  if (!client) return json({ error: "Portal do cliente não localizado." }, 404);

  if (client.PortalPass) {
    if (pass !== client.PortalPass) return json({ error: "Senha incorreta." }, 401);
  }

  const { PortalPass: _omit, ...safeClient } = client;
  const token = await makePortalToken(client.Id);
  const statuses = await getScopedStatuses(client);
  return json({ ok: true, token, client: safeClient, statuses });
}

// Atualização periódica dos dados enquanto o cliente está logado no portal.
async function handlePortalRefresh(body: any) {
  const clientId = await verifyPortalToken(String(body.token || ""));
  if (!clientId) return json({ error: "sessão expirada" }, 401);

  const client = await findClientByPortalKey(clientId);
  if (!client) return json({ error: "cliente não encontrado" }, 404);

  const { PortalPass: _omit, ...safeClient } = client;
  const statuses = await getScopedStatuses(client);
  return json({ ok: true, client: safeClient, statuses });
}

// Comando remoto disparado pelo próprio cliente no portal (congelar/descongelar
// só as máquinas dele). Autenticado pelo token de sessão do portal, não pelo
// admin_token — e restrito a comandos inofensivos, nunca REVOKE/UNINSTALL/UPDATE.
const PORTAL_ALLOWED_COMMANDS = new Set(["FREEZE|MANTER", "THAW"]);
async function handlePortalCommand(body: any) {
  const clientId = await verifyPortalToken(String(body.token || ""));
  if (!clientId) return json({ error: "sessão expirada" }, 401);

  const comando = String(body.comando || "");
  const hardwareId = String(body.hardware_id || "");
  if (!PORTAL_ALLOWED_COMMANDS.has(comando)) return json({ error: "comando não permitido" }, 403);

  const client = await findClientByPortalKey(clientId);
  if (!client) return json({ error: "cliente não encontrado" }, 404);

  const owns = (client.Maquinas || []).some((m: any) => m.HardwareID === hardwareId);
  if (!owns) return json({ error: "máquina não pertence a este cliente" }, 403);

  await patchLicenseRow(hardwareId, { comando_remoto: comando });
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  switch (body.action) {
    case "checkin":
      return handleCheckin(body);
    case "sync-status":
      return handleSyncStatus(body);
    case "activate":
      return handleActivate(body);
    case "verify-key":
      return handleVerifyKey(body);
    case "command":
      return handleCommand(body);
    case "admin-sync":
      return handleAdminSync(body);
    case "admin-save-db":
      return handleAdminSaveDb(body);
    case "portal-login":
      return handlePortalLogin(body);
    case "portal-refresh":
      return handlePortalRefresh(body);
    case "portal-command":
      return handlePortalCommand(body);
    default:
      return json({ error: "action desconhecida" }, 400);
  }
});
