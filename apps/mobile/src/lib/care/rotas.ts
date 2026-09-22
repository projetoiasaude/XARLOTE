/**
 * Como o sujeito da tela entra na URL. Pura, sem React — é o que dá pra testar.
 *
 * ## Por que isto virou função, e não mais um sufixo pronto
 *
 * Antes existia UM sufixo (`?subject=…`) e cada chamada o adaptava na mão: quem já tinha
 * query fazia `subject.replace('?', '&')`, quem não tinha concatenava direto. Duas formas
 * de escrever a mesma coisa, e a que ficou de fora foi justamente a única ESCRITA da
 * tela: a ação de lembrete saía sem sujeito, o servidor respondia 403 e o cuidador era
 * DESLOGADO no meio de um "já tomei" da mãe. O sufixo estava calculado na linha de cima e
 * nunca usado — o lint até avisava.
 *
 * Aqui a rota é a entrada e a rota completa é a saída: quem chama não escolhe entre `?` e
 * `&`, e não existe variável de sufixo pra alguém esquecer de concatenar.
 */

/**
 * A rota com `?subject=<id>` quando o alvo NÃO é quem está logado.
 *
 * `null` devolve a rota intacta, byte a byte — quem não cuida de ninguém continua
 * batendo exatamente na mesma URL de sempre.
 */
export function comSujeito(rota: string, subjectId: string | null): string {
  if (!subjectId) return rota;
  const separador = rota.includes('?') ? '&' : '?';
  return `${rota}${separador}subject=${encodeURIComponent(subjectId)}`;
}
