/**
 * Os primitivos visuais da página do médico. Só apresentação — nenhuma decisão de dado.
 *
 * ## Por que primitivos próprios, e não os do dashboard
 *
 * `components/ui/*` é vidro escuro: existe para o cockpit do fundador, com `backdrop-filter`
 * e sombra sobre fundo navy. Esta página é um documento clínico, claro e imprimível, e é a
 * única superfície do produto que uma pessoa de fora abre. Reaproveitar o vidro escuro aqui
 * custaria mais para desfazer (tema, contraste, impressão) do que estes 5 componentes.
 *
 * ## A hierarquia de peso, que é a razão de a página existir
 *
 * Alergia grave não pode ter o mesmo peso visual que "hemograma sem alterações". `tom`
 * carrega essa hierarquia num lugar só: `perigo` > `atencao` > `ok` > `neutro`. Sem isso,
 * o peso vira decisão de cada `className` espalhado pela tela — que foi exatamente como a
 * versão anterior virou uma lista de blocos iguais.
 */
'use client';

export type Tom = 'perigo' | 'atencao' | 'ok' | 'neutro';

/**
 * Paleta por tom, em pares testados contra branco.
 *
 * `texto` mede ≥ 4,5:1 sobre `fundo` (mínimo AA) — a página é lida na luz do consultório,
 * às vezes impressa em jato de tinta, às vezes num monitor de 2011 com gama torto.
 */
export const TOM: Record<Tom, { fundo: string; borda: string; texto: string; forte: string }> = {
  perigo: { fundo: '#fff1f2', borda: '#fecdd3', texto: '#9f1239', forte: '#be123c' },
  atencao: { fundo: '#fffbeb', borda: '#fde68a', texto: '#854d0e', forte: '#a16207' },
  ok: { fundo: '#f0fdf9', borda: '#a7f3d0', texto: '#115e51', forte: '#0f766e' },
  neutro: { fundo: '#f8fafc', borda: '#e6e8f0', texto: '#475069', forte: '#0f1222' },
};

/** Cartão branco: a unidade de leitura. `break-inside-avoid` porque a página é impressa. */
export function Cartao({
  children,
  className = '',
  tom,
}: {
  children: React.ReactNode;
  className?: string;
  tom?: Tom;
}) {
  const c = tom ? TOM[tom] : null;
  return (
    <div
      className={`break-inside-avoid rounded-2xl border p-4 sm:p-5 ${className}`}
      style={c ? { background: c.fundo, borderColor: c.borda } : { background: '#fff', borderColor: '#e6e8f0' }}
    >
      {children}
    </div>
  );
}

/**
 * Seção com contador e estado vazio OBRIGATÓRIO.
 *
 * `vazio` não é opcional de propósito. Uma seção que desaparece quando não tem dado ensina
 * ao médico que a Xarlote não guarda aquilo — quando a verdade é que o paciente ainda não
 * contou. Dizer "nenhuma condição registrada" é informação clínica; sumir é ruído.
 */
export function Secao({
  id,
  titulo,
  contador,
  acessorio,
  vazio,
  children,
}: {
  id: string;
  titulo: string;
  contador?: number;
  acessorio?: React.ReactNode;
  vazio: string;
  children?: React.ReactNode;
}) {
  const temConteudo = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section aria-labelledby={id} className="scroll-mt-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-[17px] font-semibold tracking-tight text-[#0f1222]">
          {titulo}
          {contador !== undefined && contador > 0 && (
            <span className="ml-2 text-[13px] font-medium tabular-nums text-[#5c6280]">{contador}</span>
          )}
        </h2>
        {acessorio}
      </div>
      {temConteudo ? children : <p className="text-[14px] leading-relaxed text-[#5c6280]">{vazio}</p>}
    </section>
  );
}

/**
 * Etiqueta curta — **13px, e não 12**.
 *
 * O `Chip` carrega "↑ acima da faixa" na tabela de exames e a gravidade da alergia na lista.
 * Nenhum dos dois é metadado descartável: são o que a régua chama de dado clínico, e ela põe
 * o piso em 13px. 12px fica para rótulo de estrutura (cabeçalho de coluna) e assinatura de
 * rodapé, que o médico não precisa ler.
 */
export function Chip({ tom = 'neutro', children }: { tom?: Tom; children: React.ReactNode }) {
  const c = TOM[tom];
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-[3px] text-[13px] font-semibold leading-none"
      style={{ background: c.fundo, borderColor: c.borda, color: c.texto }}
    >
      {children}
    </span>
  );
}

/**
 * Linha de dado: nome em cima, detalhe embaixo.
 *
 * O detalhe é 14px, e não 12: dose e frequência são o dado que muda a prescrição. Metadado
 * descartável ("há 3 dias") pode ser 12; "500mg · 1x ao dia" não é metadado.
 */
export function Linha({
  titulo,
  detalhe,
  acessorio,
  tom,
}: {
  titulo: string;
  detalhe?: string | null;
  acessorio?: React.ReactNode;
  tom?: Tom;
}) {
  const c = tom ? TOM[tom] : null;
  return (
    <li
      className="flex items-start justify-between gap-3 border-b px-4 py-3 last:border-b-0"
      style={{ borderColor: c?.borda ?? '#eef0f6' }}
    >
      <div className="min-w-0">
        <p className="text-[15px] font-semibold leading-snug" style={{ color: c?.forte ?? '#0f1222' }}>
          {titulo}
        </p>
        {detalhe && <p className="mt-0.5 text-[14px] leading-snug text-[#5c6280]">{detalhe}</p>}
      </div>
      {acessorio && <div className="shrink-0 pt-0.5">{acessorio}</div>}
    </li>
  );
}

/** Lista de `Linha` — moldura branca com divisórias, uma unidade de impressão. */
export function ListaCartao({ children, tom }: { children: React.ReactNode; tom?: Tom }) {
  const c = tom ? TOM[tom] : null;
  return (
    <ul
      className="break-inside-avoid overflow-hidden rounded-2xl border"
      style={c ? { background: c.fundo, borderColor: c.borda } : { background: '#fff', borderColor: '#e6e8f0' }}
    >
      {children}
    </ul>
  );
}

/**
 * Medidor de adesão: arco de 180°, desenhado à mão.
 *
 * Arco em vez de barra porque o número é o herói e o arco só o emoldura — e porque uma
 * barra de progresso ao lado de "78%" repetiria o mesmo dado duas vezes com mais tinta.
 * O `aria-label` carrega o valor: o arco é decoração, o texto é o dado.
 */
export function Arco({ percentual }: { percentual: number }) {
  const r = 52;
  const cx = 64;
  const cy = 60;
  const comprimento = Math.PI * r;
  const preenchido = (Math.max(0, Math.min(100, percentual)) / 100) * comprimento;
  // Vermelho abaixo de 50%, âmbar até 80%, verde acima: os cortes que a literatura de
  // adesão usa (≥80% é o limiar clássico de "aderente"), não gradação estética.
  const cor = percentual < 50 ? TOM.perigo.forte : percentual < 80 ? TOM.atencao.forte : TOM.ok.forte;
  return (
    <svg viewBox="0 0 128 72" className="h-auto w-[128px]" aria-hidden="true" focusable="false">
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="#eef0f6" strokeWidth="10" strokeLinecap="round" />
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none"
        stroke={cor}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${preenchido} ${comprimento}`}
      />
    </svg>
  );
}
