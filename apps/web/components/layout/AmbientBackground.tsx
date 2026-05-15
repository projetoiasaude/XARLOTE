/**
 * Background ambient com 3 orbs animados em azul + roxo.
 *
 * Renderiza atrás do conteúdo (z-0) com pointer-events:none. Os orbs
 * são radial-gradients enormes com blur — Liquid Glass acima deles
 * tem o que refratar. Saturação 30-40% pra não competir com texto.
 *
 * Performance: 3 elementos position:absolute com transform animation.
 * Respeita `prefers-reduced-motion` via globals.css.
 */
export function AmbientBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      {/* Camada base — gradient sutil grafite */}
      <div className="absolute inset-0 bg-gradient-to-br from-ink-base via-[#0a0a14] to-[#0c0a16]" />

      {/* Orb azul — top-left */}
      <div
        className="absolute -top-32 -left-24 h-[60vw] w-[60vw] max-h-[900px] max-w-[900px] animate-orb-1 rounded-full opacity-40"
        style={{
          background:
            'radial-gradient(circle at center, rgba(59,110,245,0.55) 0%, rgba(59,110,245,0.18) 35%, transparent 65%)',
          filter: 'blur(60px)',
        }}
      />

      {/* Orb roxo — bottom-right */}
      <div
        className="absolute -bottom-40 -right-32 h-[55vw] w-[55vw] max-h-[850px] max-w-[850px] animate-orb-2 rounded-full opacity-45"
        style={{
          background:
            'radial-gradient(circle at center, rgba(155,92,246,0.6) 0%, rgba(155,92,246,0.2) 38%, transparent 68%)',
          filter: 'blur(64px)',
        }}
      />

      {/* Orb pink acento — centro inferior, bem sutil */}
      <div
        className="absolute bottom-1/4 left-1/3 h-[35vw] w-[35vw] max-h-[550px] max-w-[550px] animate-orb-3 rounded-full opacity-20"
        style={{
          background:
            'radial-gradient(circle at center, rgba(217,70,239,0.45) 0%, rgba(217,70,239,0.1) 40%, transparent 70%)',
          filter: 'blur(70px)',
        }}
      />

      {/* Vinheta escura sutil nas bordas — concentra atenção no centro */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)',
        }}
      />

      {/* Grain noise muito sutil — quebra gradient liso, dá textura */}
      <div
        className="absolute inset-0 opacity-[0.025] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='200' height='200' filter='url(%23n)'/></svg>\")",
        }}
      />
    </div>
  );
}
