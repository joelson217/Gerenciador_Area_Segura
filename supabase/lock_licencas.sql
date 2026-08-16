-- ============================================
-- ÁREA SEGURA PRO - Bloqueio da tabela `licencas`
-- ============================================
-- SÓ RODE ISTO DEPOIS de:
--   1. A Edge Function "license-api" estar publicada (supabase functions deploy license-api)
--   2. O app.js e o AreaSegura.ps1 já atualizados para chamar a Edge Function
--      em vez de acessar a tabela direto (isso já foi feito neste repositório)
-- Rodar antes disso vai parar a sincronização de todos os PCs e do Gerenciador,
-- porque hoje eles ainda leem/escrevem a tabela direto com a chave anon.
--
-- O que este script faz: tira TODO acesso da chave pública (anon) e de
-- usuários logados comuns (authenticated) a esta tabela. Só a Edge Function
-- (que usa a service_role key, guardada só no servidor) continua funcionando,
-- porque service_role sempre ignora RLS.

alter table public.licencas enable row level security;

revoke all on public.licencas from anon;
revoke all on public.licencas from authenticated;

-- Sem nenhuma "create policy" para anon/authenticated: com RLS ligado e
-- zero políticas para esses papéis, toda leitura/escrita deles é negada.
-- (Não precisa de policy nenhuma aqui — a ausência de policy é o bloqueio.)
