import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IA da Saúde — Dashboard',
  description: 'Cockpit operacional da IA da Saúde',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
