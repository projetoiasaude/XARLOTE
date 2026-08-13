/**
 * Moldura da página do médico — e o `noindex`, que é o ponto.
 *
 * Um resumo clínico indexado por buscador seria o pior desfecho possível deste recurso.
 * A API já manda `X-Robots-Tag` na resposta do `/share/resolve`; aqui a meta tag cobre o
 * outro lado, o HTML que o crawler leria.
 *
 * O layout também é `server component` de propósito e NÃO lê o token: quem lê é a página,
 * no navegador. Token que passa pelo servidor Next vira log.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Resumo clínico — Xarlote',
  // `noindex, nofollow, noarchive`: não indexe, não siga, e não guarde cópia em cache.
  robots: { index: false, follow: false, nocache: true, noarchive: true },
};

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#04041a]">{children}</div>;
}
