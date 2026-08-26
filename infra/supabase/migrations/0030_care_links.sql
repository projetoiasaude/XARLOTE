-- ═══════════════════════════════════════════════════════════════════════════════
-- CONTA CUIDADOR — uma pessoa cuidando do registro de outra
--
-- Até aqui "quem fala" e "de quem é o dado" eram a mesma pessoa, por construção:
-- `findUserByPhone(telefone)` devolvia UM usuário e todo write ia com
-- `.eq('user_id', ctx.userId)`. Um pai acompanhando o filho, ou um filho cuidando da mãe
-- idosa, não tinha onde existir.
--
-- Esta migration NÃO move dado nenhum. As 30 tabelas por-paciente continuam exatamente
-- como estão: o registro da mãe segue nas linhas dela. O que passa a existir é a
-- AUTORIZAÇÃO — quem pode ler e escrever naquelas linhas além do próprio titular.
--
-- Desenho completo: docs/PLANO_CUIDADOR.md
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Perfil dependente ─────────────────────────────────────────────────────────
-- Uma criança de 6 anos não tem WhatsApp. O perfil dela existe, é dono de exames e
-- lembretes como qualquer outro, mas nunca conversa. `phone_e164` é NOT NULL UNIQUE, então
-- a linha recebe a sentinela `dep-<uuid>` — mesmo padrão que o forget-me já usa
-- (`deleted-<uuid>`), pra não abrir exceção no schema por causa deste caso.
alter table users
  add column if not exists account_kind text not null default 'titular'
    check (account_kind in ('titular', 'dependente'));

comment on column users.account_kind is
  'titular = tem WhatsApp e fala com a Xarlote. dependente = perfil sem canal próprio, gerido por um cuidador.';

-- ── O vínculo ─────────────────────────────────────────────────────────────────
create table if not exists care_links (
  id uuid primary key default gen_random_uuid(),

  -- ⚠️ `user_id` É O SUJEITO — o titular de quem o dado é.
  -- O nome não é descuido: `TABELAS_COM_USER_ID` e o executor do forget-me apagam por
  -- `user_id`, e o titular desta linha, pra efeito de LGPD, é quem está sendo cuidado.
  -- O lado do CUIDADOR não é alcançável por essa varredura genérica e tem tratamento
  -- explícito em `executeForgetMe`.
  user_id uuid not null references users(id) on delete cascade,
  caregiver_user_id uuid not null references users(id) on delete cascade,

  -- Relação do CUIDADOR em relação ao SUJEITO: 'filho' = "sou filho dela".
  relation text not null,

  -- vinculo    = os dois têm conta; o sujeito consentiu e pode revogar sozinho.
  -- dependente = o sujeito não tem canal próprio; o cuidador declarou responsabilidade.
  kind text not null check (kind in ('vinculo', 'dependente')),
  status text not null default 'ativo' check (status in ('ativo', 'revogado')),

  -- A prova. Obrigatória quando há alguém capaz de consentir.
  consent_event_id uuid references consent_events(id) on delete set null,

  created_by_user_id uuid not null references users(id) on delete cascade,
  activated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),

  -- Ninguém cuida de si mesmo por vínculo: sobre o próprio registro já se pode tudo, e um
  -- auto-vínculo criaria um caminho paralelo de autorização que ninguém auditaria.
  constraint care_links_nao_e_si_mesmo check (user_id <> caregiver_user_id),

  -- Vínculo entre contas SEM prova de consentimento é acesso a prontuário alheio sem
  -- autorização. O banco recusa; não depende de ninguém lembrar no código.
  constraint care_links_vinculo_exige_consentimento
    check (kind = 'dependente' or consent_event_id is not null)
);

-- Um vínculo VIVO por par. O índice é parcial de propósito: revogar e reconectar depois é
-- normal (a mãe tira o acesso, pensa melhor, devolve), e um unique cru impediria isso.
create unique index if not exists care_links_ativo_unico
  on care_links (caregiver_user_id, user_id) where status = 'ativo';

-- Caminho quente: "de quem eu cuido?", lido a cada turno do cuidador.
create index if not exists care_links_caregiver_idx
  on care_links (caregiver_user_id) where status = 'ativo';

-- Caminho inverso: "quem cuida de mim?", pra tela de privacidade e pros avisos.
create index if not exists care_links_subject_idx
  on care_links (user_id) where status = 'ativo';

alter table care_links enable row level security;
-- Sem policy = só service_role. Autorização de paciente vive na aplicação
-- (`requirePatient` + `podeAtuarSobre`), como em `app_sessions` e `share_grants`.

comment on table care_links is
  'Vínculo de cuidado. user_id = SUJEITO (titular do dado), caregiver_user_id = quem cuida.';

-- ── O convite ─────────────────────────────────────────────────────────────────
-- Código de 6 dígitos gerado por quem VAI SER CUIDADO e entregue a quem vai cuidar.
--
-- A direção é a proteção: o código só existe porque a pessoa deliberadamente pediu um pra
-- dar a alguém. Não há convite não-solicitado, e portanto não há vetor de assédio nem de
-- engenharia social por telefone digitado errado.
--
-- Mecânica espelhada de `otp_codes` (0024): guarda só o hash, salt por convite, tentativas
-- limitadas e prazo curto.
create table if not exists care_invites (
  id uuid primary key default gen_random_uuid(),
  -- Quem GEROU o código = o sujeito oferecendo acesso ao próprio registro.
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  salt text not null,
  attempts int not null default 0,
  max_attempts int not null default 5,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists care_invites_user_idx on care_invites (user_id, created_at desc);
create index if not exists care_invites_abertos_idx
  on care_invites (code_hash) where consumed_at is null;

alter table care_invites enable row level security;

comment on table care_invites is
  'Código de 6 dígitos que o SUJEITO gera e entrega a quem vai cuidar dele. Só o hash é guardado.';

-- ── Auditoria: um ator que não é o titular ────────────────────────────────────
-- `audit_log` já separava `actor_type`/`actor_id` de `user_id` desde a 0002 — "quem agiu"
-- sempre foi ortogonal a "de quem é o dado". Faltava só um valor que representasse uma
-- PESSOA FÍSICA que não é o titular. Sem ele, a ação de um cuidador seria registrada como
-- 'user' e ficaria indistinguível do próprio paciente no export que ele lê como
-- "quem acessou meu prontuário".
alter table audit_log drop constraint if exists audit_log_actor_type_check;
alter table audit_log add constraint audit_log_actor_type_check
  check (actor_type in ('xarlote', 'agent_pharmacy', 'agent_clinic',
                        'system', 'admin', 'user', 'webhook', 'caregiver'));
