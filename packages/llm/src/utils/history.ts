import type { ChatMessage } from '../client.js';
import type { Message } from '@iasaude/shared';

/**
 * Converte mensagens do banco no formato de histórico que o LLM consome.
 *
 * IMPORTANTE: inclui TODOS os tipos que carregam texto útil — não só 'text'.
 *   - text     → usa content
 *   - audio    → usa transcript (transcrição do áudio); fallback content
 *   - image    → usa content (caption), se houver
 *   - location → usa content ("[Localização compartilhada…]")
 *
 * Bug histórico (corrigido): antes filtrava `content_type === 'text'`, o que
 * APAGAVA do histórico a saudação inicial da Xarlote (enviada como ÁUDIO) e
 * qualquer áudio do paciente. Resultado: a Xarlote "esquecia" que já tinha
 * cumprimentado e repetia a saudação no turno seguinte (e ignorava o que o
 * paciente pediu por áudio). Agora áudio entra no histórico via transcript.
 */
/**
 * O que o paciente NUNCA recebeu não é conversa. O espelho de um lembrete fica em `messages`
 * mesmo quando o WhatsApp o recusou (`window_blocked`) ou a rotina estava pausada
 * (`suppressed`). Se isso entra no histórico como fala da Xarlote, o modelo responde a uma
 * conversa que só existiu no banco: o Glauber disse "Sim" às 06:49 e a Xarlote registrou a
 * Domperidona "do jantar" da véspera — que ele nunca viu — e desejou "boa noite" de manhã
 * (15/09/2026). O Ciro disse "sim" pra "tudo bem por aí?" e ganhou creatina no prontuário.
 */
export const NAO_ENTREGUE = new Set(['window_blocked', 'suppressed', 'failed']);

/**
 * O TEMPO ENTRA NO HISTÓRICO. As mensagens iam pro modelo sem data: a conversa de 10/09 (endereço,
 * Coimbra, frete) e o "Oi, tudo bem?" de 14/09 pareciam a mesma tarde — e o modelo "continuou"
 * um pedido morto há quatro dias. Quando duas mensagens têm mais de 6h entre si, a segunda
 * começa com a data e há quanto tempo foi ("[10/09 12:52 — há 4 dias]"). Calendário é conta
 * de servidor, não de modelo (regra 100).
 */
export const LACUNA_MARCADA_MS = 6 * 60 * 60_000;

function quandoFoi(iso: string, agoraMs: number): string {
  const t = new Date(iso).getTime();
  const data = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t)).replace(',', '');
  const dif = Math.max(0, agoraMs - t);
  const horas = Math.round(dif / 3_600_000);
  const dias = Math.round(dif / 86_400_000);
  const ha = dias >= 2 ? `há ${dias} dias` : horas >= 24 ? 'ontem' : horas >= 1 ? `há ${horas}h` : 'agora há pouco';
  return `[${data} — ${ha}]`;
}

export function messagesToHistory(messages: Message[], agora: Date = new Date()): ChatMessage[] {
  const entregues = messages.filter((m) => !(m.direction === 'out' && NAO_ENTREGUE.has(String(m.delivery_status ?? ''))));
  const ultimaMs = entregues.length ? new Date(entregues[entregues.length - 1]!.created_at).getTime() : agora.getTime();
  let anteriorMs: number | null = null;
  return entregues
    .map((m) => {
      // Prioriza transcrição (áudio) sobre content; cai pra content (texto/caption/location)
      const text =
        (m.transcript && m.transcript.trim()) ||
        (m.content && m.content.trim()) ||
        '';
      const ms = new Date(m.created_at).getTime();
      // Marca: (a) a mensagem que vem depois de um vazio de 6h+; (b) a primeira da janela quando a
      // janela toda é antiga (a última mensagem tem 6h+ em relação a AGORA) — é o caso do "oi" de
      // hoje depois de uma conversa de dias atrás.
      const lacuna = !Number.isNaN(ms) && (
        (anteriorMs != null && ms - anteriorMs >= LACUNA_MARCADA_MS) ||
        (anteriorMs == null && (ultimaMs - ms >= LACUNA_MARCADA_MS || agora.getTime() - ultimaMs >= LACUNA_MARCADA_MS))
      );
      if (!Number.isNaN(ms)) anteriorMs = ms;
      return {
        role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: text && lacuna ? `${quandoFoi(m.created_at, agora.getTime())} ${text}` : text,
      };
    })
    .filter((m) => m.content.length > 0);
}

