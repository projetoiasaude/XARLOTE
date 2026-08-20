/**
 * O que o prontuário TEM A DIZER — as derivações que viram ação, não linha de lista.
 *
 * ## Por que este arquivo existe
 *
 * "Tomo Losartana 50mg" é uma linha que ninguém faz nada com. "Sua Losartana acaba em
 * 4 dias" é a mesma informação virada do avesso: dá pra agir agora, e a ação existe de
 * verdade do outro lado (a Xarlote cota em farmácia — é o fluxo do MVP). A Saúde 360
 * mostrava só o primeiro formato; tudo aqui é o segundo.
 *
 * ## Nada aqui é conselho clínico
 *
 * Cada aviso é um FATO com data ("faz 8 meses desde o seu último hemograma") e uma
 * pergunta como ação ("vale repetir?"), nunca uma recomendação ("você precisa
 * repetir"). A Xarlote não diagnostica e não ajusta conduta; uma tela que dissesse
 * "repita este exame" estaria fazendo as duas coisas em nome dela. Também não existe
 * periodicidade por tipo de exame aqui — inventar que hemograma é anual e TSH é
 * semestral seria escrever protocolo médico em TypeScript.
 *
 * ## Os números não são novos — são os MESMOS do banco
 *
 * `DIAS_ESTOQUE_BAIXO` = 7 porque `THRESHOLD_DAYS` do `inventory-tracker.worker` é 7, e
 * a conta de dias é `tablets_remaining / daily_consumption` porque é a da função SQL
 * `medications_running_low`. Se a tela usasse 10 dias, ela alarmaria sobre remédios que
 * a Xarlote nunca mencionou — e o paciente teria duas fontes discordando sobre o mesmo
 * vidro de comprimido. Uma definição, dois consumidores (é o mesmo compromisso do
 * cabeçalho de `packages/shared/src/adherence.ts`).
 */
import { diaBrt, msDe } from '@/lib/br-format';
import type { ExamResult, InventoryRow, Medication } from './overview';

/**
 * Dias de estoque a partir dos quais isto é assunto — o MESMO 7 do inventory-tracker.
 * Ver o cabeçalho: divergir daqui é fazer a tela e a Xarlote discordarem.
 */
export const DIAS_ESTOQUE_BAIXO = 7;

/**
 * Meses desde o último exame de um tipo a partir dos quais vale perguntar.
 *
 * 6 meses NÃO é uma recomendação clínica — é o ponto em que "faz tempo" deixa de ser
 * óbvio pra quem não anota nada. A frase que a tela mostra é factual e a ação é uma
 * pergunta; quem decide se repete é o médico.
 */
export const MESES_EXAME_ANTIGO = 6;

/**
 * Quantos TIPOS de exame antigo viram aviso — a faixa não é o acervo.
 *
 * O servidor manda até 60 exames e cada tipo distinto com ≥6 meses virava um cartão de
 * ~130px com botão de 44pt. Um paciente com histórico de verdade (hemograma, glicemia,
 * colesterol, TSH, creatinina, urina…) abria a Saúde e encontrava seis cartões entre o
 * herói e as Alergias, todo santo dia, sem nada pra dispensar. "Faz tempo" não tem
 * prazo: dois é o bastante pra virar assunto, e a biblioteca de exames — que é o acervo,
 * com todos os tipos e todas as datas — está a uma linha de distância na mesma tela.
 *
 * Os avisos vêm ordenados do mais antigo pro menos antigo, então o corte fica com os
 * dois que fazem mais tempo, que é a ordem em que a pergunta faz mais sentido.
 */
export const TIPOS_DE_EXAME_NA_FAIXA = 2;

// ─── Tempo ──────────────────────────────────────────────────────────────────────

/** Os campos de calendário de Brasília, reusando o `diaBrt` que já é testado. */
function camposBrt(ms: number): { ano: number; mes: number; dia: number } {
  const [ano, mes, dia] = diaBrt(ms).split('-');
  return { ano: Number(ano), mes: Number(mes), dia: Number(dia) };
}

/**
 * Meses de CALENDÁRIO completos desde `iso`, no fuso do paciente. Null se a data não
 * dá pra confiar, e negativo nunca acontece por acidente — data no futuro devolve 0.
 *
 * Passa por `msDe`, que é o único lugar que sabe que `exam_date` é uma coluna DATE:
 * `Date.parse('2026-08-01')` é meia-noite UTC, que lida em -03:00 vira 31 de julho —
 * o bug que já jogou exame do dia 1º pro mês anterior. Contar em blocos de 30 dias
 * daria "5 meses" pra algo de 1º de março visto em 1º de agosto.
 */
export function mesesDesde(iso: string | null | undefined, agoraMs: number): number | null {
  const ms = msDe(iso);
  if (ms === null) return null;
  const a = camposBrt(ms);
  const b = camposBrt(agoraMs);
  const brutos = (b.ano - a.ano) * 12 + (b.mes - a.mes);
  // O mês só "fechou" quando o dia do mês já passou: de 20/jan até 05/fev é 0 mês.
  const meses = b.dia >= a.dia ? brutos : brutos - 1;
  return meses > 0 ? meses : 0;
}

// ─── Estoque ────────────────────────────────────────────────────────────────────

export interface EstoqueDoMedicamento {
  /**
   * Dias INTEIROS que sobram pela conta do banco (`floor`). `0` NÃO quer dizer acabou:
   * quer dizer que não fecha um dia — 2 comprimidos com 3 por dia também dá 0. Quem
   * responde "acabou?" é `comprimidosRestantes`, e é dele que `avisosDeEstoque` tira a
   * palavra.
   */
  dias: number;
  comprimidosRestantes: number;
}

/**
 * Quanto sobra de um medicamento, ou null quando não há como saber.
 *
 * A caixa considerada é a MAIS RECENTE com comprimido sobrando, e não a soma de
 * todas: o decremento por dose confirmada (`tool-executor-v2`) só mexe numa linha, então
 * somar caixas antigas contaria comprimido que ninguém está descontando — o estoque
 * pareceria maior do que é justamente no dado que serve pra avisar que está acabando.
 * É também a linha que a Xarlote vê em `pack_user_context`, o que mantém as duas versões
 * da mesma frase iguais.
 *
 * `expected_depletion_at` existe na tabela e NÃO é usada de propósito: é um palpite
 * congelado no dia da compra, e quem pula doses fica com a data no passado e a caixa
 * cheia. O contador vivo é `tablets_remaining`.
 */
export function estoqueDoMedicamento(
  med: Medication,
  inventario: readonly InventoryRow[],
): EstoqueDoMedicamento | null {
  const consumo = med.daily_consumption;
  if (typeof consumo !== 'number' || !Number.isFinite(consumo) || consumo <= 0) return null;

  const doMed = inventario.filter((i) => i.medication_id === med.id);
  if (doMed.length === 0) return null;

  const porCompra = (a: InventoryRow, b: InventoryRow): number =>
    (msDe(b.purchased_at) ?? 0) - (msDe(a.purchased_at) ?? 0);

  const comSobra = doMed.filter((i) => (i.tablets_remaining ?? 0) > 0).sort(porCompra);
  // Nenhuma caixa com sobra é informação, não ausência dela: significa "acabou".
  const alvo = comSobra[0] ?? [...doMed].sort(porCompra)[0];
  if (!alvo || typeof alvo.tablets_remaining !== 'number') return null;

  return {
    // `floor` no rótulo e a comparação no valor cru — igual ao par worker/RPC: 7,4 dias
    // não é estoque baixo (a RPC filtra `<= 7`), mas se aparecer diz "7 dias".
    dias: Math.floor(alvo.tablets_remaining / consumo),
    comprimidosRestantes: alvo.tablets_remaining,
  };
}

/** O mesmo predicado da função SQL: dias CRUS (não arredondados) dentro do limite. */
function estoqueBaixo(med: Medication, e: EstoqueDoMedicamento): boolean {
  const consumo = med.daily_consumption ?? 0;
  if (consumo <= 0) return false;
  return e.comprimidosRestantes / consumo <= DIAS_ESTOQUE_BAIXO;
}

// ─── Exames por tipo ────────────────────────────────────────────────────────────

export interface TipoDeExame {
  /** Chave normalizada só pra agrupar — nunca vai à tela. */
  chave: string;
  /** O NOME do exame como está escrito no laudo mais recente ("Hemograma completo"). */
  rotulo: string;
  /**
   * A categoria grossa da coluna `exam_type` ('sangue' | 'imagem' | 'urina' | …) do exame
   * mais recente do grupo. NÃO é o nome do exame e não vai sozinha à tela — fica aqui pra
   * quem precisar desempatar dois laudos de mesmo nome em categorias diferentes.
   */
  categoria: string;
  total: number;
  ultimo: ExamResult;
  /** Meses desde o último COM data. Null quando nenhum tinha data legível. */
  mesesDesdeUltimo: number | null;
}

/**
 * Exame sem data legível não é descartado — entra no grupo do seu tipo com
 * `mesesDesdeUltimo: null`, porque some com um exame da vida do paciente é pior
 * do que mostrar um exame com data incerta (a mesma decisão de `agruparExamesPorMes`).
 */
function chaveDoTipo(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * O NOME do exame: `title` com queda pra `exam_type` — a convenção do app inteiro.
 *
 * ⚠️ `exam_type` NÃO é o nome do exame. A migration 0014 declara
 * `exam_type text not null, -- 'sangue' | 'imagem' | 'urina' | 'cardiologico' | 'covid'`
 * e `title text, -- ex.: "Hemograma completo"`, e a tool `save_exam_result`
 * (`packages/llm/src/tools/xarlote-tools.ts`) instrui o modelo exatamente assim, com as
 * duas obrigatórias. Agrupar pela categoria juntava hemograma, glicemia, colesterol, TSH
 * e creatinina num grupo só: quem fez glicemia mês passado e não faz hemograma há dois
 * anos não recebia aviso nenhum — que é literalmente o aviso que esta tela existe pra
 * dar —, e o que chegava ao paciente era "sangue — faz 8 meses".
 *
 * `e.title?.trim() || e.exam_type` é a MESMA expressão de `saude/index.tsx`,
 * `exames/index.tsx`, `exames/[id].tsx` e `apps/api/src/lib/share-grants.ts`; este
 * arquivo era o único fora da convenção.
 */
function nomeDoExame(e: ExamResult): string {
  return e.title?.trim() || e.exam_type;
}

/**
 * Exames agrupados pelo NOME do laudo, do mais recentemente feito pro mais antigo.
 *
 * A normalização é só caixa e espaço. Não junto "hemograma" com "hemograma completo" de
 * propósito: casar nomes de exame por semelhança é decisão clínica, e o erro tem
 * consequência — dois exames diferentes virando um esconde o mais antigo dos dois. Pela
 * mesma razão dois exames de sangue com nomes diferentes são dois grupos: "quando foi o
 * último hemograma?" não se responde com a data da última glicemia.
 */
export function agruparExamesPorTipo(
  exames: readonly ExamResult[],
  agoraMs: number,
): TipoDeExame[] {
  const porChave = new Map<string, ExamResult[]>();
  for (const e of exames) {
    // Pelo NOME do laudo, nunca pela categoria da coluna `exam_type` — ver `nomeDoExame`.
    const chave = chaveDoTipo(nomeDoExame(e));
    const lista = porChave.get(chave);
    if (lista) lista.push(e);
    else porChave.set(chave, [e]);
  }

  const tipos: TipoDeExame[] = [];
  for (const [chave, lista] of porChave) {
    const ordenados = [...lista].sort((a, b) => (msDe(b.exam_date) ?? -1) - (msDe(a.exam_date) ?? -1));
    const ultimo = ordenados[0]!;
    tipos.push({
      chave,
      rotulo: nomeDoExame(ultimo).trim() || 'exame',
      categoria: ultimo.exam_type.trim(),
      total: lista.length,
      ultimo,
      mesesDesdeUltimo: mesesDesde(ultimo.exam_date, agoraMs),
    });
  }

  // Sem data vai pro fim: não se pode afirmar que é o mais recente nem o mais antigo.
  return tipos.sort((a, b) => (msDe(b.ultimo.exam_date) ?? -1) - (msDe(a.ultimo.exam_date) ?? -1));
}

// ─── Avisos ─────────────────────────────────────────────────────────────────────

/**
 * A ação de um aviso. `perguntar` manda uma mensagem REAL pra Xarlote (o app faz, não
 * pede pro paciente fazer); `abrirExame` navega. Não existe variante que só informe:
 * aviso sem saída é cobrança.
 */
export type AcaoDoAviso =
  | { tipo: 'perguntar'; mensagem: string; rotulo: string }
  | { tipo: 'abrirExame'; exameId: string; rotulo: string };

export interface Aviso {
  /** Estável (id do dado) — serve de `key` e evita aviso repetido. */
  chave: string;
  titulo: string;
  detalhe: string;
  tom: 'warn' | 'info';
  acao: AcaoDoAviso;
}

/** 'ago/2026' sem depender de `brMesAno` (que exige o ISO, não o ms). */
const MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'] as const;

function mesAnoDe(iso: string | null | undefined): string | null {
  const ms = msDe(iso);
  if (ms === null) return null;
  const c = camposBrt(ms);
  return `${MES_CURTO[c.mes - 1]}/${c.ano}`;
}

function plural(n: number, um: string, muitos: string): string {
  return n === 1 ? um : muitos;
}

/**
 * Medicamento acabando — o aviso mais acionável do app, porque a ação existe: a Xarlote
 * cota reposição em farmácia (é literalmente o que o `inventory-tracker` já oferece
 * sozinho por WhatsApp). Aqui o paciente pede quando ELE lembra, sem esperar o worker.
 *
 * Não filtro por `reorder_offered_at`: aquele carimbo serve pra não repetir a oferta
 * automática, e esta tela não é uma oferta — é o estado do estoque. Esconder um remédio
 * acabando porque já avisamos uma vez é a definição de dado que existe e não aparece.
 */
export function avisosDeEstoque(
  medicamentos: readonly Medication[],
  inventario: readonly InventoryRow[],
): Aviso[] {
  const comUrgencia: { dias: number; aviso: Aviso }[] = [];
  for (const m of medicamentos) {
    if (m.active === false) continue;
    const e = estoqueDoMedicamento(m, inventario);
    if (!e || !estoqueBaixo(m, e)) continue;

    const nome = [m.medication_name, m.dosage].filter(Boolean).join(' ');
    /**
     * A palavra sai do COMPRIMIDO, não do `dias`.
     *
     * `dias` é `floor(tablets_remaining / daily_consumption)`: qualquer sobra menor que um
     * dia inteiro vira 0 lá dentro. Quem toma 3 por dia (antibiótico de 8/8h) e tem 2 na
     * caixa lia "Amoxicilina acabou" e "não sobrou nenhum comprimido" com dois na mão —
     * uma afirmação falsa sobre o estoque clínico de alguém. Três estados, três frases:
     * acabou (0), está no fim (sobra menos de um dia) e está acabando.
     *
     * E "pelas minhas contas" não é modéstia decorativa: a conta desce por dose
     * CONFIRMADA, então quem toma sem responder ao lembrete tem mais caixa do que este
     * número diz. Afirmar seco seria mentir com precisão de um dígito.
     */
    const restantes = e.comprimidosRestantes;
    let titulo: string;
    let detalhe: string;
    if (restantes <= 0) {
      titulo = `${nome} acabou`;
      detalhe = 'Pelas minhas contas não sobrou nenhum comprimido.';
    } else if (e.dias <= 0) {
      // Sobra que não fecha um dia: a frase conta COMPRIMIDO, que é o que a pessoa tem
      // na mão, e nunca diz que acabou.
      titulo = `${nome} está no fim`;
      detalhe = `${plural(restantes, 'Sobra', 'Sobram')} ${restantes} ${plural(restantes, 'comprimido', 'comprimidos')} — menos de um dia, pelas minhas contas.`;
    } else {
      titulo = `${nome} está acabando`;
      detalhe =
        e.dias === 1
          ? 'Sobra 1 dia, pelas minhas contas.'
          : `Sobram uns ${e.dias} dias, pelas minhas contas.`;
    }

    comUrgencia.push({
      dias: e.dias,
      aviso: {
        chave: `estoque:${m.id}`,
        titulo,
        detalhe,
        tom: 'warn',
        acao: {
          tipo: 'perguntar',
          rotulo: 'Pedir na farmácia',
          mensagem: `Minha ${nome} está acabando. Pode cotar uma caixa pra mim?`,
        },
      },
    });
  }

  /**
   * Urgência antes do alfabeto — e é o teto da tela que torna isso obrigatório.
   *
   * `TETO_AVISOS` corta o FIM da lista, então o fim tem que ser o menos urgente. Em
   * ordem alfabética pura, um hipertenso/diabético com quatro remédios em falta podia ter
   * a Sinvastatina que ACABOU escondida atrás de "ver os outros N" (começa com 'S')
   * enquanto uma Amoxicilina de 7 dias ocupava a faixa aberta. O alfabeto continua como
   * desempate, pra a ordem não dançar entre renders com dois remédios no mesmo prazo.
   */
  return comUrgencia
    .sort((a, b) => a.dias - b.dias || a.aviso.titulo.localeCompare(b.aviso.titulo, 'pt-BR'))
    .map((x) => x.aviso);
}

/**
 * Exame que faz tempo — um por NOME de exame, o mais antigo primeiro.
 *
 * O aviso diz a data e pergunta; não manda repetir. E só existe pra exame que o paciente
 * JÁ FEZ: sugerir um exame que ele nunca fez seria indicação de exame, que é ato médico.
 *
 * O `rotulo` que entra no título e na mensagem é o nome do laudo ("Hemograma completo"),
 * não a categoria da coluna `exam_type` — senão o paciente lia "sangue — faz 8 meses" e
 * mandava "Meu último sangue foi de jan/2026" pra Xarlote (ver `nomeDoExame`).
 *
 * O corte em `TIPOS_DE_EXAME_NA_FAIXA` não é `slice()` mudo: nada aqui é a fonte da
 * verdade sobre os exames do paciente — todos continuam na biblioteca, com data e valor,
 * e ela tem entrada própria na mesma tela. O que este corte limita é quantas PERGUNTAS a
 * faixa faz de uma vez.
 */
export function avisosDeExame(exames: readonly ExamResult[], agoraMs: number): Aviso[] {
  return agruparExamesPorTipo(exames, agoraMs)
    .filter((t) => t.mesesDesdeUltimo !== null && t.mesesDesdeUltimo >= MESES_EXAME_ANTIGO)
    .sort((a, b) => (b.mesesDesdeUltimo ?? 0) - (a.mesesDesdeUltimo ?? 0))
    .slice(0, TIPOS_DE_EXAME_NA_FAIXA)
    .map((t) => {
      const meses = t.mesesDesdeUltimo!;
      const quando = mesAnoDe(t.ultimo.exam_date);
      return {
        chave: `exame:${t.ultimo.id}`,
        titulo: `${t.rotulo} — faz ${meses} ${plural(meses, 'mês', 'meses')}`,
        detalhe: quando
          ? `O último que você me mandou foi de ${quando}. Vale repetir?`
          : 'Vale repetir?',
        tom: 'info' as const,
        acao: {
          tipo: 'perguntar' as const,
          rotulo: 'Perguntar pra Xarlote',
          mensagem: quando
            ? `Meu último ${t.rotulo} foi de ${quando}. Vale repetir?`
            : `Faz ${meses} ${plural(meses, 'mês', 'meses')} desde meu último ${t.rotulo}. Vale repetir?`,
        },
      };
    });
}

/**
 * A lista da faixa "Cuidar disso": estoque antes de exame, sempre.
 *
 * Estoque tem prazo (o remédio acaba na quinta) e exame não tem — ordenar pela
 * urgência real é o que evita a faixa virar mural. E o teto é do CHAMADOR, não daqui:
 * cortar em silêncio é o defeito que esta sessão está consertando.
 */
export function avisosDoProntuario(
  dados: {
    medications: readonly Medication[];
    inventory: readonly InventoryRow[];
    examResults: readonly ExamResult[];
  },
  agoraMs: number,
): Aviso[] {
  return [
    ...avisosDeEstoque(dados.medications, dados.inventory),
    ...avisosDeExame(dados.examResults, agoraMs),
  ];
}
