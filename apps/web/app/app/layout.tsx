import type { Metadata, Viewport } from 'next';
import { ApiAuth } from '@/components/layout/ApiAuth';
import { XarloteBackground } from '@/components/xarlote/XarloteBackground';
import { OrbNav } from '@/components/xarlote/OrbNav';
import { PairGuard } from '@/components/xarlote/PairGuard';
import { XarloteAppProvider } from '@/lib/xarlote/app-context';

export const metadata: Metadata = {
  title: 'Xarlote — seu agente de saúde 360',
  description:
    'A Xarlote cuida da sua saúde: conversa, lembra dos remédios, compra na farmácia e marca consultas. Uma IA que age de verdade.',
  appleWebApp: {
    capable: true,
    title: 'Xarlote',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#04041a',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function XarloteAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-dvh bg-[#04041a] text-white">
      <ApiAuth />
      <XarloteBackground />
      <XarloteAppProvider>
        <PairGuard>
          <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-3xl flex-col">
            {children}
          </div>
        </PairGuard>
        <OrbNav />
      </XarloteAppProvider>
    </div>
  );
}
