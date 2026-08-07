/**
 * Máscara de telefone BR enquanto o paciente digita.
 *
 * A conversão pra E.164 NÃO mora aqui: é `toE164BR` do @iasaude/shared, a mesma
 * função que o backend usa pra achar o usuário. Duas implementações de "o que é um
 * telefone válido" divergem com o tempo, e a divergência aparece como "meu número
 * não existe" na tela de login.
 *
 * Aqui fica só a APRESENTAÇÃO — o que o campo mostra enquanto se digita.
 */

/** Só dígitos, sem DDI, no máximo 11 (celular BR com o 9). */
export function phoneDigitsBR(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  // Tira o 55 do DDI só quando o resto tem cara de número BR completo (10 ou 11
  // dígitos). Sem essa condição, um celular de Santa Maria/RS — DDD 55! — perderia
  // o próprio DDD: "55999912345" viraria "999912345".
  const semDdi = (digits.length === 12 || digits.length === 13) && digits.startsWith('55')
    ? digits.slice(2)
    : digits;
  return semDdi.slice(0, 11);
}

/**
 * Formata progressivamente: "6" → "(6" · "629" → "(62) 9" → "(62) 98345-0244".
 *
 * A quebra é SEMPRE 5-4 (celular), nunca 4-4 (fixo), mesmo no meio da digitação.
 * O motivo é que este campo só aceita celular — o login é por WhatsApp. Alternar a
 * quebra conforme o comprimento faria o número dançar na tela ("(62) 9834-5" e
 * depois "(62) 98345-0") a cada tecla, e dança em campo de telefone parece bug.
 */
export function maskPhoneBR(raw: string): string {
  const d = phoneDigitsBR(raw);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;

  const ddd = d.slice(0, 2);
  const resto = d.slice(2);
  if (resto.length <= 5) return `(${ddd}) ${resto}`;
  return `(${ddd}) ${resto.slice(0, 5)}-${resto.slice(5, 9)}`;
}

/** Exibição de um E.164 já salvo: "+5562983450244" → "+55 (62) 98345-0244". */
export function formatPhonePretty(e164: string): string {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * Dá pra tentar o login com o que está digitado?
 *
 * Fixo (10 dígitos) NÃO passa: o login é por WhatsApp, e WhatsApp de número fixo não
 * recebe o código. Melhor barrar no campo do que gastar uma das 3 tentativas do
 * paciente e esperar 5 minutos por um código que nunca chega.
 */
export function isSubmittablePhone(raw: string): boolean {
  return phoneDigitsBR(raw).length === 11;
}

/**
 * Número completo, mas de telefone FIXO (10 dígitos, sem o 9 na frente).
 *
 * Existe pra que o botão desligado tenha VOZ. Barrar sem explicar é o mesmo bug do
 * estado vazio mudo: o paciente digitou um número que ele considera válido, o botão
 * não acende, e não há nada na tela dizendo por quê.
 */
export function looksLikeLandline(raw: string): boolean {
  const d = phoneDigitsBR(raw);
  return d.length === 10 && !d.startsWith('9', 2);
}

/** Últimos 4 dígitos, pra confirmar "mandei o código pro ···0244" sem expor o número. */
export function phoneTail(raw: string): string {
  const d = phoneDigitsBR(raw);
  return d.length >= 4 ? d.slice(-4) : d;
}
