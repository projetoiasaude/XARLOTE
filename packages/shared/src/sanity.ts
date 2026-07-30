/**
 * AUTO-VERIFICAÇÃO DA FALA (auditoria 30/07 — caso Glauber/IAD).
 *
 * A Xarlote mandou para uma clínica, duas vezes: *"preciso de uma consulta de consulta"*.
 * Qualquer pessoa releria e veria que não faz sentido — ela não. O problema não é o modelo
 * ser ruim: é que **nada relê o que ela vai dizer antes de sair**. Entre gerar e enviar não
 * havia nenhuma etapa.
 *
 * Esta é essa etapa. Roda no ponto ÚNICO de saída para terceiros (clínica/farmácia), que é
 * onde o dano de reputação é maior e o volume é baixo. Duas responsabilidades:
 *
 *   1. CONSERTAR degenerações de interpolação que têm conserto óbvio
 *      ("consulta de consulta" → "consulta"), pra a mensagem sair sã mesmo assim.
 *   2. DENUNCIAR o que não tem conserto seguro ("undefined", "[object Object]", buraco de
 *      variável) — devolvendo o problema pra quem chamou BLOQUEAR o envio e alertar,
 *      em vez de despejar lixo num terceiro real.
 *
 * Determinístico de propósito: é uma rede de segurança, não mais um julgamento de LLM.
 * Não custa token, não adiciona latência e não falha junto com o modelo.
 */

export interface SanityResult {
  /** Texto já reparado no que era reparável. */
  text: string;
  /** Problemas que NÃO têm conserto seguro — se houver, não envie. */
  blockers: string[];
  /** O que foi consertado automaticamente (pra log). */
  repairs: string[];
}

/** Palavras que, repetidas na forma "X de X", denunciam interpolação degenerada. */
const SELF_REFERENTIAL = ['consulta', 'exame', 'médico', 'medico', 'especialidade', 'procedimento'];

/** Artefatos de código que NUNCA podem chegar a um humano. */
const CODE_LEAKS = /\b(undefined|null|NaN)\b|\[object |\{\{\d+\}\}|\$\{/;

export function checkOutboundSanity(raw: string): SanityResult {
  const repairs: string[] = [];
  const blockers: string[] = [];
  let text = raw ?? '';

  // 1. "consulta de consulta", "exame de exame" — a interpolação caiu sobre si mesma.
  //    Conserto: fica só o substantivo ("uma consulta de consulta" → "uma consulta").
  for (const w of SELF_REFERENTIAL) {
    const re = new RegExp(`\\b(${w})s?\\s+(?:de|da|do)\\s+\\1s?\\b`, 'gi');
    if (re.test(text)) {
      text = text.replace(re, '$1');
      repairs.push(`"${w} de ${w}" → "${w}"`);
    }
  }

  // 2. "consulta de médico" / "exame de exame médico": genérico sobre genérico, mesma classe.
  const genericOnGeneric = /\b(consulta)s?\s+(?:de|da|do)\s+m[ée]dic[oa]s?\b/gi;
  if (genericOnGeneric.test(text)) {
    text = text.replace(genericOnGeneric, '$1 médica');
    repairs.push('"consulta de médico" → "consulta médica"');
  }

  // 3. Preposição órfã: "consulta de  e o valor" / "de ," — variável veio vazia.
  //    Sem saber o que deveria estar ali, não há conserto seguro: BLOQUEIA.
  if (/\b(?:de|da|do|com|para|pra)\s{2,}/.test(text) || /\b(?:de|da|do|com)\s*[,.!?]/.test(text)) {
    blockers.push('variável vazia deixou preposição órfã (ex.: "consulta de  ,")');
  }

  // 4. Vazamento de código/template: sintoma de bug, nunca de linguagem.
  if (CODE_LEAKS.test(text)) {
    blockers.push('artefato de código no texto (undefined/null/NaN/[object]/placeholder)');
  }

  // 5. Mensagem vazia ou quase — não se manda "." pra uma clínica.
  if (text.trim().length < 3) {
    blockers.push('texto vazio ou curto demais');
  }

  // Normaliza espaços que os reparos possam ter deixado.
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').trim();

  return { text, blockers, repairs };
}
