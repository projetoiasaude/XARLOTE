/**
 * BUSCA DE EXAME AGENDADA — as decisões puras (caso Ciro, 16–21/09/2026).
 *
 * ─── O QUE ACONTECEU ─────────────────────────────────────────────────────────
 * O Ciro mandou o protocolo do CDI e disse: "no dia da previsão de entrega, pega esse
 * resultado pra mim". O sistema só sabia buscar AGORA. Enfileirou, o portal não foi
 * reconhecido, o worker disse "não conheço o site" — e o modelo, no mesmo segundo, disse
 * "estou entrando no site no dia 21/09". No dia seguinte, criou um LEMBRETE com "vou entrar
 * no site… já volto com novidades". Um lembrete não entra em site nenhum.
 *
 * ─── AS REGRAS ───────────────────────────────────────────────────────────────
 * 1. "Quando" é decisão de servidor: o modelo passa a data que leu no protocolo; aqui ela
 *    vira `agora` (já passou / é daqui a minutos) ou `agendada` (futuro, até 60 dias).
 * 2. A autorização é a fala da pessoa, nesta mensagem — e pode vir junto com um dado que o
 *    portal pediu ("15/03/1990, sim").
 * 3. As frases que a pessoa ouve são fixas e honestas: "vou tentar", nunca "vou conseguir";
 *    e a data combinada só é dita DEPOIS do reconhecimento do portal.
 *
 * PURO: sem I/O, sem relógio próprio (recebe `agora`).
 */
import { foldPt } from './br-datetime.js';

export const JANELA_AGORA_MS = 10 * 60_000;           // até 10 min no futuro = agora
export const JANELA_PASSADO_TOLERADO_MS = 12 * 3600_000; // data que passou há <12h = agora (o resultado já saiu)
export const MAX_ANTECEDENCIA_MS = 60 * 24 * 3600_000; // até 60 dias

export type QuandoBuscar =
  | { tipo: 'agora' }
  | { tipo: 'agendada'; em: Date }
  | { tipo: 'invalida'; motivo: 'formato' | 'longe_demais' | 'passado' };

/**
 * `quando` como o modelo passa: omisso/"agora" → agora; ISO com fuso → data. Uma data-só
 * ("2026-09-21") vale às 09:00 de Brasília — um resultado "sai no dia" e de manhã já dá
 * pra tentar; se o protocolo diz "a partir das 17h30", o modelo passa a hora.
 */
export function interpretarQuando(quando: string | null | undefined, agora: Date): QuandoBuscar {
  const q = (quando ?? '').trim();
  if (!q || /^(agora|now|hoje)$/i.test(q)) return { tipo: 'agora' };
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(q) ? `${q}T09:00:00-03:00` : q;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { tipo: 'invalida', motivo: 'formato' };
  const dif = t - agora.getTime();
  if (dif <= JANELA_AGORA_MS && dif >= -JANELA_PASSADO_TOLERADO_MS) return { tipo: 'agora' };
  if (dif < 0) return { tipo: 'invalida', motivo: 'passado' };
  if (dif > MAX_ANTECEDENCIA_MS) return { tipo: 'invalida', motivo: 'longe_demais' };
  return { tipo: 'agendada', em: new Date(t) };
}

const NEGACAO = /(^|\s)(n[ãa]o|nunca|deix|depois|espera|ainda n|cancela|para|melhor n)/;
const AFIRMACAO = /(^|[\s,.;:!-])(sim|pode|autorizo|autorizado|ok|okay|claro|vai|bora|isso|quero|confirmo|beleza|manda|busca|pode sim|isso mesmo)(\s|$|[!.,;])/;

/**
 * A pessoa disse SIM, com as palavras dela, nesta mensagem? Determinístico, sem modelo.
 * Negação em qualquer lugar vence ("sim, mas não agora"). Data ou número junto não atrapalha
 * ("15/03/1990, sim" · "sim, 15031990"): o portal do CDI pede a data de nascimento, e a
 * resposta natural traz as duas coisas.
 */
export function autorizouBuscaNoPortal(texto: string | null | undefined): boolean {
  const t = foldPt(texto ?? '').trim();
  if (!t) return false;
  if (NEGACAO.test(t)) return false;
  const semDatas = t.replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{8}\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!semDatas) return false;
  return AFIRMACAO.test(semDatas);
}

/** dd/mm/aaaa · dd-mm-aaaa · ddmmaaaa · aaaa-mm-dd → ISO (aaaa-mm-dd), só se for uma data plausível de nascimento. */
export function dataDeNascimentoDaFala(texto: string | null | undefined, agora: Date = new Date()): string | null {
  const t = (texto ?? '').trim();
  if (!t) return null;
  let d: number, m: number, a: number;
  let hit: RegExpExecArray | null;
  if ((hit = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t))) { a = +hit[1]!; m = +hit[2]!; d = +hit[3]!; }
  else if ((hit = /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/.exec(t))) { d = +hit[1]!; m = +hit[2]!; a = +hit[3]!; }
  else if ((hit = /\b(\d{2})(\d{2})(\d{4})\b/.exec(t))) { d = +hit[1]!; m = +hit[2]!; a = +hit[3]!; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const anoAtual = agora.getUTCFullYear();
  if (a < anoAtual - 120 || a > anoAtual) return null;
  const iso = `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== d) return null;
  return iso;
}

const TZ = 'America/Sao_Paulo';
export function quandoPorExtenso(em: Date, tz = TZ): string {
  const data = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(em);
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(em);
  return `${data} a partir das ${hora.replace(':', 'h')}`;
}

function nomeDoLab(lab: string | null | undefined): string {
  return lab?.trim() ? ` do ${lab.trim()}` : ' do laboratório';
}

/** Ao enfileirar AGORA: o único fato é que vai tentar. */
export function mensagemVouTentarAgora(lab: string | null | undefined): string {
  return `Tô tentando entrar no site${nomeDoLab(lab)} agora com esse acesso. Já te digo o que deu 💙`;
}

/** Ao pedir agendamento: ainda sem prova, então "deixa eu conferir". */
export function mensagemVouConferirOSite(lab: string | null | undefined, em: Date): string {
  return `Deixa eu conferir se eu consigo entrar no site${nomeDoLab(lab)}. Se der, eu deixo agendado pra ${quandoPorExtenso(em)} e te confirmo já já 💙`;
}

/** Reconhecimento OK: agora sim, a data combinada — e o que acontece com o acesso. */
export function mensagemAgendamentoConfirmado(lab: string | null | undefined, em: Date): string {
  return `Combinado: ${quandoPorExtenso(em)} eu entro no site${nomeDoLab(lab)} com esse acesso, busco seu resultado e te aviso aqui. Guardo o acesso cifrado só até lá e apago depois 🔒💙`;
}

/** Reconhecimento falhou: a verdade, e o caminho que sempre funciona (com o lembrete honesto). */
export function mensagemAgendamentoImpossivel(lab: string | null | undefined, em: Date, motivo: string): string {
  const porque = motivo === 'bloqueado_captcha'
    ? 'o site pede uma verificação humana ("não sou um robô"), e isso eu não faço'
    : motivo === 'portal_desconhecido'
      ? `ainda não conheço o site${nomeDoLab(lab)} bem o suficiente pra navegar nele sozinha`
      : `não consegui abrir o site${nomeDoLab(lab)} direito agora`;
  return `Conferi aqui e ${porque} 😕 Então fica assim: ${quandoPorExtenso(em)} eu te lembro que o resultado saiu, você baixa o PDF (ou tira foto do laudo) e me manda — eu leio e guardo no seu perfil na hora 💙`;
}

/** O portal pede um dado que a gente não tem: sem ele não dá pra agendar nem tentar. */
export function mensagemFaltouDado(lab: string | null | undefined, campo: 'nascimento' | 'cpf'): string {
  const oQue = campo === 'nascimento' ? 'a sua data de nascimento (dd/mm/aaaa)' : 'o seu CPF';
  return `Pra entrar no site${nomeDoLab(lab)} eu preciso de ${oQue}, que o site pede junto com o protocolo. Me manda ${campo === 'nascimento' ? 'a data' : 'o número'} e confirma com "sim" que eu agendo 💙`;
}

/** Na hora combinada, antes de abrir o navegador. */
export function mensagemBuscaAgendadaComecou(lab: string | null | undefined): string {
  return `Como combinado, tô entrando no site${nomeDoLab(lab)} agora pra buscar seu resultado. Já te digo o que deu 💙`;
}

/** O lembrete honesto que substitui a busca quando o portal não é reconhecido. */
export function corpoDoLembreteDeResultado(lab: string | null | undefined, protocolo: string | null | undefined): string {
  const p = protocolo?.trim() ? ` (protocolo ${protocolo.trim()})` : '';
  return `Oi! Hoje o resultado do seu exame${nomeDoLab(lab)}${p} já deve estar liberado. Quando você baixar o PDF ou tirar foto do laudo, me manda aqui que eu leio e guardo no seu perfil 💙`;
}
