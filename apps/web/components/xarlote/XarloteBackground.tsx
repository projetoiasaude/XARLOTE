/**
 * Fundo ambiente do Xarlote App — navy profundo das referências de marca,
 * mais azul/roxo que o do dashboard. 3 orbs aurora em drift lento + vinheta + grain.
 * Estático no servidor (zero JS), animação via keyframes existentes.
 */
export function XarloteBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {/* Base navy profunda */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#04041a_0%,#070725_45%,#0a0830_100%)]" />

      {/* Orb azul — topo esquerdo */}
      <div
        className="absolute -left-[20%] -top-[25%] h-[70vmax] w-[70vmax] animate-orb-1 rounded-full opacity-45"
        style={{
          background:
            'radial-gradient(circle, rgba(59,110,245,0.5) 0%, rgba(59,110,245,0.16) 45%, transparent 70%)',
          filter: 'blur(60px)',
        }}
      />
      {/* Orb roxo — direita */}
      <div
        className="absolute -right-[25%] top-[15%] h-[65vmax] w-[65vmax] animate-orb-2 rounded-full opacity-50"
        style={{
          background:
            'radial-gradient(circle, rgba(155,92,246,0.5) 0%, rgba(155,92,246,0.15) 50%, transparent 72%)',
          filter: 'blur(64px)',
        }}
      />
      {/* Orb rosa — base */}
      <div
        className="absolute -bottom-[30%] left-[20%] h-[60vmax] w-[60vmax] animate-orb-3 rounded-full opacity-25"
        style={{
          background:
            'radial-gradient(circle, rgba(217,70,239,0.45) 0%, rgba(217,70,239,0.12) 50%, transparent 72%)',
          filter: 'blur(70px)',
        }}
      />

      {/* Vinheta — concentra o foco */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 38%, transparent 0%, transparent 55%, rgba(2,2,14,0.55) 100%)',
        }}
      />

      {/* Grain sutil */}
      <div
        className="absolute inset-0 opacity-[0.025] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </div>
  );
}
