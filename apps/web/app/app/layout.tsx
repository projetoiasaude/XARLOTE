import type { Metadata, Viewport } from 'next';
import { ApiAuth } from '@/components/layout/ApiAuth';
import { XarloteBackground } from '@/components/xarlote/XarloteBackground';
import { OrbNav } from '@/components/xarlote/OrbNav';
import { PairGuard } from '@/components/xarlote/PairGuard';
import { CapacitorBridge } from '@/components/xarlote/CapacitorBridge';
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
  icons: {
    // PNG do mascote 3D real (frame do vídeo) — iOS ignora SVG no home screen.
    apple: '/apple-touch-icon.png',
    icon: [
      { url: '/xarlote-icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/xarlote-icon.svg', type: 'image/svg+xml' },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: '#04041a',
  width: 'device-width',
  initialScale: 1,
  // sem maximumScale: bloquear pinch-zoom é barreira de acessibilidade (WCAG 1.4.4)
  viewportFit: 'cover',
};

export default function XarloteAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-svh bg-[#04041a] text-white">
      <ApiAuth />
      <XarloteBackground />
      <XarloteAppProvider>
        <CapacitorBridge />
        <PairGuard>
          <div className="relative z-10 mx-auto flex min-h-svh w-full max-w-3xl flex-col">
            {children}
          </div>
        </PairGuard>
        <OrbNav />
      </XarloteAppProvider>
    </div>
  );
}
