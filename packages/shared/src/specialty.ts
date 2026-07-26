/**
 * Sintagma legível pra ESPECIALIDADE médica (auditoria 26/07 — caso Ciro, ao vivo 25/07).
 *
 * O LLM manda a especialidade CRUA ("reumatologista", "cardiologia"), e o código
 * interpolava direto numa frase que espera um sintagma nominal:
 *     `pra ver ${specialty}`  →  "pra ver reumatologista"   ← falta artigo, soa quebrado
 *
 * Aqui normalizamos os dois formatos que o modelo usa na prática:
 *   • PROFISSIONAL ("reumatologista", "cardiologista", "ortopedista", "psiquiatra",
 *     "ginecologista", "endócrino") → "um reumatologista"
 *   • ÁREA ("reumatologia", "cardiologia") → "uma consulta de reumatologia"
 *
 * Devolve `null` quando a especialidade é vazia ou genérica demais pra virar frase
 * ("consulta", "médico") — nesse caso o caller OMITE o trecho em vez de dizer bobagem.
 */

/** Genéricos que não acrescentam nada à frase ("pra ver um médico" é ruído). */
const GENERIC = /^(consulta|medic[oa]|m[ée]dic[oa]|doutor[a]?|dr\.?|dra\.?|especialista|atendimento|avalia[çc][ãa]o)$/i;

/** Sufixos de PROFISSIONAL em PT-BR: -ista, -logo/-loga, -atra, -eta (protético//paramédico). */
const PROFESSIONAL_SUFFIX = /(ista|logo|loga|[ií]atra|atra|eta)$/i;

/** Sufixos de ÁREA/ESPECIALIDADE: -logia, -atria, -ia. */
const AREA_SUFFIX = /(logia|[ií]atria|atria|urgia)$/i;

/** Feminino quando o profissional termina em -loga (psicóloga, ginecologista é comum-2-gêneros). */
function articleFor(word: string): string {
  return /loga$/i.test(word) ? 'uma' : 'um';
}

/**
 * @param specialty valor cru vindo do LLM (pode ser null/vazio/genérico)
 * @returns sintagma pronto pra encaixar depois de "pra ver ..." / "pra marcar ...",
 *          ou `null` quando não vale a pena dizer nada.
 */
export function specialtyPhrase(specialty?: string | null): string | null {
  const raw = (specialty ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;

  // Já veio com artigo/preposição do modelo ("uma consulta de cardiologia", "um ortopedista",
  // "de cardiologia") → confia e devolve como está (não empilha artigo em cima de artigo).
  if (/^(um|uma|o|a|os|as|de|do|da)\s/i.test(raw)) return raw;

  if (GENERIC.test(raw)) return null;

  const lower = raw.toLowerCase();
  const lastWord = lower.split(' ').pop() ?? lower;

  // ÁREA antes de PROFISSIONAL: "cardiologia" casa -logia (área), e -logia não casa
  // os sufixos de profissional, então a ordem só protege casos ambíguos futuros.
  if (AREA_SUFFIX.test(lastWord)) return `uma consulta de ${lower}`;
  if (PROFESSIONAL_SUFFIX.test(lastWord)) return `${articleFor(lastWord)} ${lower}`;

  // Desconhecido (ex.: "cirurgia de joelho", "check-up"): trata como área, que é a forma
  // que quase sempre lê bem — e nunca fica sem artigo.
  return `uma consulta de ${lower}`;
}
