/**
 * O gráfico de um marcador — `<svg>` escrito à mão, ~2 KB, zero dependência.
 *
 * A geometria toda vem de `lib/medico/serie.ts` (pura e testada); aqui só se pinta. A
 * divisão importa: o que decide onde o ponto cai é testável sem navegador, e o que decide
 * a cor não precisa ser.
 *
 * ## As três decisões visuais que não são estética
 *
 * 1. **Cor nunca é o único sinal.** Ponto fora da faixa recebe anel mais grosso E aparece
 *    na tabela do exame com a palavra "acima"/"abaixo". Um médico com deuteranopia lê a
 *    mesma informação que os outros.
 * 2. **`aria-label` com a série inteira em palavras.** `role="img"` sozinho só silencia o
 *    elemento; a frase de `descricaoSerie` é o que faz o traço existir num leitor de tela.
 * 3. **`id` de gradiente sufixado.** Dois `<svg>` na mesma página com `id="grad"` fazem o
 *    segundo herdar o primeiro — bug clássico, invisível no print e óbvio na tela.
 */
'use client';

import { dataBr } from '@/lib/br-data';
import { numeroTexto } from '@/lib/medico/numeros';
import { CAIXA_PADRAO, FONTE_EIXO, descricaoSerie, geometria, tendencia, type Serie } from '@/lib/medico/serie';

const COR = {
  linha: '#4f46e5',
  dentro: '#0f766e',
  fora: '#b91c1c',
  neutro: '#64748b',
  faixa: '#0f766e',
  grade: '#e6e8f0',
  texto: '#5c6280',
};

function corDoPonto(s: 'dentro' | 'acima' | 'abaixo' | 'indefinido'): string {
  if (s === 'acima' || s === 'abaixo') return COR.fora;
  if (s === 'dentro') return COR.dentro;
  return COR.neutro;
}

export function Grafico({ serie, idx }: { serie: Serie; idx: number }) {
  const g = geometria(serie, CAIXA_PADRAO);
  const { largura, altura } = CAIXA_PADRAO;
  const idGrad = `xg-${idx}`;
  const t = tendencia(serie);
  const ultimo = serie.pontos[serie.pontos.length - 1]!;
  const primeiro = serie.pontos[0]!;

  return (
    <figure className="m-0 break-inside-avoid rounded-2xl border border-[#e6e8f0] bg-white p-4">
      <figcaption className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-[15px] font-semibold leading-tight text-[#0f1222]">{serie.marcador}</h4>
          <p className="mt-0.5 text-[13px] text-[#5c6280]">
            {serie.pontos.length} medições · {dataBr(primeiro.data)} a {dataBr(ultimo.data)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[19px] font-bold leading-none tabular-nums text-[#0f1222]">
            {numeroTexto(ultimo.valor)}
            {serie.unidade && <span className="ml-1 text-[13px] font-medium text-[#5c6280]">{serie.unidade}</span>}
          </p>
          {t && (
            <p
              className="mt-1 text-[13px] font-semibold tabular-nums"
              style={{ color: t.direcao === 'estavel' ? COR.neutro : COR.texto }}
            >
              {t.direcao === 'estavel' ? '≈ estável' : `${t.direcao === 'subiu' ? '↑' : '↓'} ${numeroTexto(Math.abs(t.delta))}`}
            </p>
          )}
        </div>
      </figcaption>

      <svg
        viewBox={`0 0 ${largura} ${altura}`}
        className="h-auto w-full"
        role="img"
        aria-label={descricaoSerie(serie)}
      >
        <defs>
          <linearGradient id={idGrad} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COR.linha} stopOpacity="0.16" />
            <stop offset="100%" stopColor={COR.linha} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Faixa do laudo: o "onde deveria estar", desenhado ANTES da linha. */}
        {g.faixa && (
          <rect
            x={CAIXA_PADRAO.pad.esq}
            y={g.faixa.y}
            width={largura - CAIXA_PADRAO.pad.esq - CAIXA_PADRAO.pad.dir}
            height={g.faixa.altura}
            fill={COR.faixa}
            fillOpacity="0.08"
          />
        )}

        {g.grade.map((linha, i) => (
          <g key={i}>
            <line
              x1={CAIXA_PADRAO.pad.esq}
              y1={linha.y}
              x2={largura - CAIXA_PADRAO.pad.dir}
              y2={linha.y}
              stroke={COR.grade}
              strokeWidth="1"
            />
            <text x={CAIXA_PADRAO.pad.esq - 6} y={linha.y + 4.5} textAnchor="end" fontSize={FONTE_EIXO} fill={COR.texto}>
              {linha.rotulo}
            </text>
          </g>
        ))}

        <path d={g.area} fill={`url(#${idGrad})`} />
        <polyline
          points={g.linha}
          fill="none"
          stroke={COR.linha}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {g.pontos.map((c, i) => {
          const fora = c.p.situacao === 'acima' || c.p.situacao === 'abaixo';
          const ultimoPonto = i === g.pontos.length - 1;
          return (
            <circle
              key={i}
              cx={c.x}
              cy={c.y}
              r={ultimoPonto || fora ? 4 : 3}
              fill="#ffffff"
              stroke={corDoPonto(c.p.situacao)}
              // Anel mais grosso no que está fora: o sinal existe sem depender da cor.
              strokeWidth={fora ? 3 : 2}
            />
          );
        })}

        {/* Data de exame é dado clínico, e o rótulo do eixo y é valor de laudo: os três
            `<text>` usam `FONTE_EIXO`, que é um piso medido contra a escala do viewBox —
            ver o comentário dele em `serie.ts`, e a caixa que foi aberta para eles. */}
        <text x={CAIXA_PADRAO.pad.esq} y={altura - 6} fontSize={FONTE_EIXO} fill={COR.texto}>
          {dataBr(primeiro.data)}
        </text>
        <text x={largura - CAIXA_PADRAO.pad.dir} y={altura - 6} fontSize={FONTE_EIXO} textAnchor="end" fill={COR.texto}>
          {dataBr(ultimo.data)}
        </text>
      </svg>

      <p className="mt-2 text-[13px] leading-snug text-[#5c6280]">
        {serie.referenciaTexto ? (
          <>
            Faixa do laudo: <span className="font-medium text-[#0f1222]">{serie.referenciaTexto}</span>
            {!serie.referencia && ' (não comparável automaticamente)'}
          </>
        ) : (
          'O laudo não trouxe faixa de referência para este marcador.'
        )}
      </p>
    </figure>
  );
}
