/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { typedRoutes: false },
  // Páginas legais/públicas: HTML estático em public/, servido em URL limpa.
  // Ficam FORA do App Router de propósito — não podem herdar o layout do
  // dashboard nem cair atrás do AdminAuthGate: a Apple e a ANPD precisam abrir
  // essas duas URLs sem login. Ver docs da submissão na App Store.
  async rewrites() {
    return [
      { source: '/privacidade', destination: '/privacidade.html' },
      { source: '/suporte', destination: '/suporte.html' },
    ];
  },
};

export default nextConfig;
