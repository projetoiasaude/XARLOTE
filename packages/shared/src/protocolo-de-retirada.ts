/**
 * PROTOCOLO DE RETIRADA NÃO É RESULTADO (caso Ciro, 18/09/2026).
 *
 * Ele mandou a foto do protocolo do IGR ("Pega esses resultados"). O modelo chamou
 * `save_exam_result` com título "RM Crânio", um único "marcador" = "Código do procedimento
 * 1474509" e o resumo "Prazo de entrega previsto… Resultados disponíveis pelo site…" — e
 * disse "Guardei seu resultado". Duas vezes. No prontuário ficou um exame de imagem sem
 * laudo, com um número de protocolo no lugar de achado. Sete minutos depois a própria
 * Xarlote admitiu que só tinha o protocolo.
 *
 * A régua é pura: sem achado clínico nenhum (só código/protocolo/senha/data de retirada) e
 * com o resumo falando em retirada/prazo/acesso, é protocolo — e protocolo não entra como
 * resultado. O modelo ouve isso e oferece o que existe: avisar na data, ou ler o PDF/foto.
 */

function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const MARCADOR_DE_PROTOCOLO = /\b(codigo|protocolo|senha|login|usuario|numero\s+do\s+(?:pedido|atendimento|exame|protocolo)|atendimento|pedido|os\b|guia|ficha|autenticacao)\b/;
const FALA_DE_RETIRADA = /\b(protocolo|retirada|retirar|prazo\s+de\s+entrega|previsao\s+de\s+entrega|resultado(?:s)?\s+(?:disponive|estar[aá]|fica)|acesso\s+pelo\s+site|acesse\s+o\s+site|www\.|\.com\.br|senha\s+de\s+acesso|liberado\s+em|entrega\s+prevista)\b/;

export interface AchadoDeExame { marker?: string | null; value?: string | null; unit?: string | null; reference?: string | null }

/** O que o modelo quer guardar é um protocolo de retirada (não um laudo)? */
export function pareceProtocoloDeRetirada(p: { summary?: string | null; findings?: AchadoDeExame[] | null; title?: string | null }): boolean {
  const achados = (p.findings ?? []).filter((f) => (f?.marker ?? '').trim() || (f?.value ?? '').trim());
  const achadosClinicos = achados.filter((f) => !MARCADOR_DE_PROTOCOLO.test(fold(f.marker ?? '')));
  if (achadosClinicos.length > 0) return false;
  const resumo = fold(p.summary ?? '');
  const titulo = fold(p.title ?? '');
  if (/\bprotocolo\b/.test(titulo)) return true;
  return FALA_DE_RETIRADA.test(resumo);
}

export const RECUSA_DE_PROTOCOLO = 'NÃO guardei: isso é um PROTOCOLO de retirada (código/prazo/site), não um resultado — não existe achado clínico nenhum aqui. Não diga que guardou o resultado. Diga a verdade: você anotou que o resultado sai em tal data/site, e que quando ele mandar o PDF ou a foto do laudo você lê e guarda. Se quiser lembrar na data, use create_reminder (sem prometer que VOCÊ vai buscar).';
