/**
 * Moldura da página do médico — o `noindex`, o tema claro e a folha de impressão.
 *
 * ## `noindex` continua sendo o ponto
 *
 * Um resumo clínico indexado por buscador seria o pior desfecho possível deste recurso. A
 * API já manda `X-Robots-Tag` na resposta do `/share/resolve`; aqui a meta tag cobre o outro
 * lado, o HTML que o crawler leria.
 *
 * O layout é `server component` de propósito e NÃO lê o token: quem lê é a página, no
 * navegador. Token que passa pelo servidor Next vira log.
 *
 * ## Por que esta página é CLARA, contra o resto do produto
 *
 * O app e o dashboard são vidro escuro, e a versão anterior desta página seguia o mesmo
 * tema. A alternativa óbvia — manter o navy da marca — foi recusada por três motivos que
 * pesam mais que a coerência visual:
 *
 * 1. **Ela é impressa.** O médico cola no prontuário de papel ou salva em PDF. Fundo
 *    #04041a em jato de tinta sai como uma mancha, ou o navegador o descarta e a página
 *    volta em texto branco sobre branco.
 * 2. **É uma tabela de números.** Valor de laudo, unidade e faixa de referência lado a
 *    lado, lidos por alguém de 45-60 anos na luz do consultório: papel é o suporte que
 *    séculos de documento clínico escolheram, e não por falta de imaginação.
 * 3. **É a única superfície que alguém de fora abre.** Um documento que se parece com um
 *    laudo é levado a sério; um que se parece com um app de consumo, não.
 *
 * A marca não desaparece — ela vive na faixa do cabeçalho, que é onde ela deve estar num
 * documento: no timbre. `color-scheme: light` impede o navegador em modo escuro de inverter
 * as cores dos controles e desmontar o contraste calculado.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Resumo clínico — Xarlote',
  // `noindex, nofollow, noarchive`: não indexe, não siga, e não guarde cópia em cache.
  robots: { index: false, follow: false, nocache: true, noarchive: true },
};

/**
 * CSS desta rota, injetado inline.
 *
 * Fica aqui, e não em `globals.css`, porque o `globals` pinta o `body` de navy para o
 * dashboard inteiro: sobrescrever de dentro da subárvore só enquanto ESTA rota está montada
 * é o que evita que o documento claro vaze para o cockpit. É pouco CSS e é declarativo —
 * a alternativa (uma classe no `<html>` via script) rodaria depois da primeira pintura e
 * daria o flash de navy que a página não pode ter.
 */
const CSS = `
:root { color-scheme: light; }
body { background: #f6f7fb; color: #0f1222; }

/* Alvo de toque e foco visível: a página tem um formulário de PIN e dois botões, e é
   navegada por teclado por quem usa leitor de tela. */
.med-doc :focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; border-radius: 6px; }
.med-doc { font-variant-numeric: tabular-nums; }

@media print {
  @page { size: A4; margin: 12mm; }
  body { background: #fff; }
  /* Botões e o formulário de PIN não existem no papel. */
  .nao-imprime { display: none !important; }
  /* O timbre escuro vira uma régua preta: economiza tinta e imprime legível em qualquer
     impressora, inclusive as que descartam fundo colorido por configuração. */
  .med-timbre { background: #fff !important; color: #0f1222 !important; border-bottom: 2px solid #0f1222; }
  .med-timbre * { color: #0f1222 !important; }
  .med-doc section, .med-doc figure, .med-doc li, .med-doc .break-inside-avoid {
    break-inside: avoid;
  }
  /* Sem sombra e sem canto arredondado: no papel viram borrão cinza. */
  .med-doc * { box-shadow: none !important; }
  /* O endereço do link é um segredo: navegador que imprime href não pode vazá-lo. */
  .med-doc a[href]:after { content: '' !important; }
}
`;

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="med-doc min-h-screen bg-[#f6f7fb]">{children}</div>
    </>
  );
}
