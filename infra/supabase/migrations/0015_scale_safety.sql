-- 0015 — Escala-segura (Fase 2): backstop de unicidade nas tabelas de perfil.
--
-- O mutex por-usuário do enricher (withUserLock) já serializa as escritas e mata
-- a corrida de check-then-insert. Estes índices únicos são o CINTO DE SEGURANÇA
-- (defesa em profundidade) pra quando o Redis cair (o lock é fail-open). Como o
-- enricher IGNORA erro de INSERT, uma violação de unicidade vira no-op idempotente
-- em vez de duplicata — exatamente o comportamento desejado sob carga.
--
-- Dedup ANTES de criar o índice, senão o CREATE falha. `ctid` garante 1 sobrevivente
-- por grupo (é o id físico da row, sempre único) — mantém a de menor ctid.

-- user_allergies: 1 substância por usuário (case-insensitive)
delete from user_allergies a using user_allergies b
  where a.user_id = b.user_id
    and lower(a.substance) = lower(b.substance)
    and a.ctid > b.ctid;
create unique index if not exists user_allergies_uniq
  on user_allergies (user_id, lower(substance));

-- user_health_conditions: 1 condição por usuário (case-insensitive)
delete from user_health_conditions a using user_health_conditions b
  where a.user_id = b.user_id
    and lower(a.name) = lower(b.name)
    and a.ctid > b.ctid;
create unique index if not exists user_health_conditions_uniq
  on user_health_conditions (user_id, lower(name));

-- user_medications: 1 medicamento por usuário (case-insensitive).
-- CUIDADO: medication_log e medication_inventory referenciam user_medications(id)
-- com ON DELETE CASCADE. Apagar uma row duplicada cega DESTRUIRIA o histórico de
-- doses/estoque que aponta pra ela. Então REPONTA os filhos pro sobrevivente (menor
-- id do grupo) ANTES de apagar as duplicatas. (Em prod rodou com 0 dupes → no-op;
-- isto protege ambientes futuros com duplicatas legadas.)
with grp as (
  select id,
    row_number() over (partition by user_id, lower(medication_name) order by id) as rn,
    first_value(id) over (partition by user_id, lower(medication_name) order by id) as keep_id
  from user_medications
)
update medication_log ml set medication_id = g.keep_id
  from grp g where ml.medication_id = g.id and g.rn > 1;
update medication_inventory mi set medication_id = g.keep_id
  from grp g where mi.medication_id = g.id and g.rn > 1;
delete from user_medications um using grp g where um.id = g.id and g.rn > 1;
create unique index if not exists user_medications_uniq
  on user_medications (user_id, lower(medication_name));
