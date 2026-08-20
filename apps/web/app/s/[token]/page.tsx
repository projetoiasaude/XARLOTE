/**
 * A página que o MÉDICO abre — a única superfície pública com dado clínico.
 *
 * O paciente gera um link no app e manda pro médico dele. Aqui não há login, não há
 * cadastro, não há app: o profissional abre no navegador do consultório e vê o quadro.
 *
 * ## As decisões de SEGURANÇA que a página carrega (não mexer sem entender)
 *
 * · **Client component, e o token nunca vai pro servidor Next.** A busca é um POST do
 *   navegador direto pra API, com o token no CORPO. Se a página fosse renderizada no
 *   servidor, o token entraria nos logs do Next e do proxy — que é onde credencial some
 *   sem ninguém notar.
 * · **`noindex` de verdade** (metadata no layout + header da API).
 * · **Uma só mensagem de recusa.** Expirado, revogado e inexistente dizem a mesma coisa,
 *   porque a API responde a mesma coisa — a página não inventa distinção que o backend
 *   recusa fazer de propósito.
 * · **Nada de telefone, CPF ou data de nascimento.** Só idade. Esta página pode acabar
 *   encaminhada no grupo da clínica.
 * · **Leitor tolerante** (`lerResumo`): links criados por versões anteriores do formato
 *   continuam vivos e não têm `valores`. Um `as Resumo` seguido de `.map` quebraria a
 *   página no consultório, com o paciente ao lado.
 *
 * ## A decisão de DESIGN, que é o que mudou nesta versão
 *
 * A versão anterior era honesta e era uma **lista**: alergia, medicamento, condição e exame
 * em blocos do mesmo peso. Um médico tem 90 segundos, e nesse formato ele gasta os primeiros
 * 20 descobrindo se há algo perigoso. Agora a hierarquia é explícita:
 *
 * 1. **Triagem antes de qualquer rolagem.** Alergia grave é uma faixa vermelha no topo, com
 *    o nome da substância em corpo grande. Se não há alergia registrada, a faixa diz — e diz
 *    também que ausência de registro **não é** negativa de alergia, que é o mal-entendido
 *    capaz de causar dano nesta página.
 * 2. **Censo em uma linha**, logo abaixo: o que existe neste resumo e quanto de cada. É o
 *    índice e é o inventário; some do papel a dúvida "isso é tudo?".
 * 3. **Valor de exame com histórico vira traço.** Tendência de glicemia se lê numa
 *    inclinação, não em três linhas de texto — mas todo número plotado também está na
 *    tabela, porque o gráfico é a segunda leitura, nunca a única.
 * 4. **Imprimível.** Ver o cabeçalho de `layout.tsx`: fundo claro, timbre que vira régua
 *    preta, cartões que não quebram no meio.
 *
 * ## O que a página NUNCA faz
 *
 * Não interpreta. Comparar um valor com a faixa que o **próprio laudo** imprimiu é
 * aritmética, e é o limite: o rótulo é "acima da faixa do laudo", nunca "alterado", e onde
 * não há faixa impressa não aparece selo nenhum.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { dataBr } from '@/lib/br-data';
import { apiUrl } from '@/lib/utils';
import {
  adesaoPercentual,
  frescor,
  lerResumo,
  ordenarAlergias,
  triagem,
  type Alergia,
  type Gravidade,
  type ResumoMedico,
} from '@/lib/medico/resumo';
import { lerReferencia, numeroBr, situacao } from '@/lib/medico/numeros';
import { seriesDosExames } from '@/lib/medico/serie';
import { resumoTexto } from '@/lib/medico/texto';
import { Arco, Cartao, Chip, Linha, ListaCartao, Secao, TOM, type Tom } from './ui';
import { Grafico } from './Grafico';

type Estado =
  | { t: 'carregando' }
  | { t: 'pin'; mensagem: string; restantes: number | null }
  | { t: 'ok'; resumo: ResumoMedico; recebidoEm: number }
  | { t: 'indisponivel'; codigo: string | null; mensagem: string };

/**
 * Os códigos em que a culpa **não** é do link — e por isso a tela não pode falar de validade.
 *
 * `rate_limited` é o teto de 20 requisições por IP a cada 10 minutos, e uma clínica inteira
 * sai por um NAT só: o segundo médico do corredor cai aqui com o link perfeito na mão.
 * `unavailable` é o Redis fora. `rede` é o `catch` do `fetch`. Anunciar qualquer um dos três
 * como "link indisponível, peça um novo" faz o paciente gerar outro link, o médico abrir, e
 * falhar igual — porque o link nunca foi o problema.
 */
const FALHA_TEMPORARIA = ['rate_limited', 'unavailable', 'rede'];

export default function ResumoCompartilhado() {
  const { token } = useParams<{ token: string }>();
  const [estado, setEstado] = useState<Estado>({ t: 'carregando' });
  const [pin, setPin] = useState('');
  const [enviando, setEnviando] = useState(false);

  const buscar = useCallback(
    async (pinTentado?: string) => {
      setEnviando(true);
      try {
        const res = await fetch(apiUrl('/share/resolve'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Token no CORPO, nunca na URL — ver o cabeçalho deste arquivo.
          body: JSON.stringify({ token, ...(pinTentado ? { pin: pinTentado } : {}) }),
          cache: 'no-store',
        });
        const corpo = (await res.json()) as Record<string, unknown>;

        if (res.ok) {
          const resumo = lerResumo(corpo['resumo']);
          // Resposta 200 com corpo que não é um resumo: falha nossa, e ela se anuncia.
          // Uma tela vazia diria ao médico que o paciente não tem nada registrado.
          setEstado(
            resumo
              ? { t: 'ok', resumo, recebidoEm: Date.now() }
              : {
                  t: 'indisponivel',
                  codigo: 'formato',
                  mensagem: 'O link abriu, mas o resumo veio num formato que eu não consegui ler. Pede um link novo ao paciente.',
                },
          );
        } else if (corpo['error'] === 'pin_necessario') {
          setEstado({
            t: 'pin',
            mensagem: (corpo['message'] as string) ?? 'Este link pede um PIN.',
            restantes: (corpo['tentativasRestantes'] as number) ?? null,
          });
          setPin('');
        } else {
          // O CÓDIGO fica guardado, não só a frase. Sem ele, o 429 do rate limit e o 503 do
          // Redis fora caíam na mesma caixa do token revogado — e recebiam o conselho errado.
          setEstado({
            t: 'indisponivel',
            codigo: typeof corpo['error'] === 'string' ? corpo['error'] : null,
            mensagem: (corpo['message'] as string) ?? 'Este link não está mais disponível.',
          });
        }
      } catch {
        setEstado({
          t: 'indisponivel',
          codigo: 'rede',
          mensagem: 'Não consegui falar com o servidor. Confere a conexão e tenta de novo.',
        });
      } finally {
        setEnviando(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void buscar();
  }, [buscar]);

  return (
    <main className="pb-16">
      <Timbre estado={estado} />

      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        {estado.t === 'carregando' && <Carregando />}
        {estado.t === 'indisponivel' && (
          <Indisponivel
            codigo={estado.codigo}
            mensagem={estado.mensagem}
            tentando={enviando}
            onTentarDeNovo={() => void buscar()}
          />
        )}
        {estado.t === 'pin' && (
          <FormularioPin
            mensagem={estado.mensagem}
            restantes={estado.restantes}
            pin={pin}
            setPin={setPin}
            enviando={enviando}
            onEnviar={() => void buscar(pin)}
          />
        )}
        {estado.t === 'ok' && <Documento resumo={estado.resumo} agora={estado.recebidoEm} />}
      </div>
    </main>
  );
}

// ─── Timbre ────────────────────────────────────────────────────────────────────

function Timbre({ estado }: { estado: Estado }) {
  const r = estado.t === 'ok' ? estado.resumo : null;
  const f = r ? frescor(r.geradoEm, estado.t === 'ok' ? estado.recebidoEm : Date.now()) : null;

  return (
    <header
      className="med-timbre mb-6 border-b border-white/10 text-white"
      style={{ background: 'linear-gradient(120deg,#12163a 0%,#241a52 48%,#3a1f63 100%)' }}
    >
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-7">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Marca />
            <div>
              <p className="text-[15px] font-semibold leading-none tracking-tight">Xarlote</p>
              <p className="mt-1 text-[12px] leading-none text-white/60">resumo clínico</p>
            </div>
          </div>
          {r && <Acoes resumo={r} agora={estado.t === 'ok' ? estado.recebidoEm : Date.now()} />}
        </div>

        {r && (
          <div className="mt-6">
            <h1 className="text-[28px] font-bold leading-[1.1] tracking-tight sm:text-[34px]">
              {r.paciente.nome ?? 'Paciente'}
            </h1>
            <p className="mt-2 text-[14px] text-white/70">
              {[
                r.paciente.idade !== null ? `${r.paciente.idade} anos` : null,
                f ? f.texto : null,
                'compartilhado pelo próprio paciente',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        )}
      </div>
    </header>
  );
}

/** A marca em 28px de SVG. Inline para não pedir uma requisição a mais na rede do médico. */
function Marca() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="marca-x" cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#a5b4fc" />
          <stop offset="55%" stopColor="#7c87ff" />
          <stop offset="100%" stopColor="#6d28d9" />
        </radialGradient>
      </defs>
      <circle cx="14" cy="14" r="13" fill="url(#marca-x)" />
      <circle cx="10" cy="10" r="4" fill="#fff" fillOpacity="0.28" />
    </svg>
  );
}

function Acoes({ resumo, agora }: { resumo: ResumoMedico; agora: number }) {
  const [copiado, setCopiado] = useState<'nao' | 'sim' | 'falhou'>('nao');

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(resumoTexto(resumo, agora));
      setCopiado('sim');
    } catch {
      // Navegador sem permissão de área de transferência (ou http): diz o que houve em vez
      // de piscar um "copiado" que não aconteceu.
      setCopiado('falhou');
    }
    setTimeout(() => setCopiado('nao'), 2600);
  };

  // 44px e não 40: o médico abre isto no telefone, entre consultas. O formulário de PIN já
  // usava 52 — o piso de alvo era conhecido, e estes dois botões tinham ficado abaixo dele.
  const botao =
    'inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-white/20 bg-white/10 px-3 text-[13px] font-semibold text-white transition hover:bg-white/20';

  return (
    <div className="nao-imprime flex shrink-0 gap-2">
      <button type="button" onClick={() => void copiar()} className={botao} aria-live="polite">
        {copiado === 'sim' ? 'Copiado' : copiado === 'falhou' ? 'Não deu' : 'Copiar texto'}
      </button>
      <button type="button" onClick={() => window.print()} className={botao}>
        Imprimir
      </button>
    </div>
  );
}

// ─── Estados que não são o documento ───────────────────────────────────────────

/**
 * Espera SEM animação.
 *
 * Um esqueleto varrendo gradiente é a lição de desempenho de 18/08 repetida numa página que
 * o médico abre em 4G: a varredura roda justamente enquanto a thread está ocupada com a
 * resposta que ele espera. Retângulos parados dizem a mesma coisa por zero.
 */
function Carregando() {
  return (
    <div aria-busy="true" aria-live="polite">
      <p className="mb-4 text-[14px] text-[#5c6280]">Abrindo o resumo…</p>
      <div className="space-y-3">
        <div className="h-[92px] rounded-2xl border border-[#e6e8f0] bg-white" />
        <div className="h-[140px] rounded-2xl border border-[#e6e8f0] bg-white" />
        <div className="h-[140px] rounded-2xl border border-[#e6e8f0] bg-white" />
      </div>
    </div>
  );
}

/**
 * A recusa — e ela precisa distinguir "este link acabou" de "eu falhei agora".
 *
 * O parágrafo sobre validade só aparece onde é VERDADE. Numa falha temporária ele mandava o
 * médico pedir um link novo para um problema que link nenhum resolve, e não havia nada para
 * tocar: o texto dizia "tenta de novo" sobre uma tela sem botão.
 */
function Indisponivel({
  codigo,
  mensagem,
  tentando,
  onTentarDeNovo,
}: {
  codigo: string | null;
  mensagem: string;
  tentando: boolean;
  onTentarDeNovo: () => void;
}) {
  const temporaria = codigo !== null && FALHA_TEMPORARIA.indexOf(codigo) !== -1;
  return (
    <Cartao tom={temporaria ? 'atencao' : 'neutro'}>
      <h2 className="text-[19px] font-bold tracking-tight text-[#0f1222]">
        {temporaria ? 'Não consegui carregar agora' : 'Link indisponível'}
      </h2>
      <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-[#475069]">{mensagem}</p>

      {temporaria ? (
        <>
          <button
            type="button"
            onClick={onTentarDeNovo}
            disabled={tentando}
            // 44px, o mesmo piso dos botões do timbre: o médico toca isto com o polegar.
            className="nao-imprime mt-4 inline-flex min-h-[44px] items-center rounded-xl bg-[#4f46e5] px-5 text-[15px] font-semibold text-white transition hover:bg-[#4338ca] disabled:opacity-40"
          >
            {tentando ? 'Tentando…' : 'Tentar de novo'}
          </button>
          <p className="mt-4 text-[13px] leading-relaxed text-[#5c6280]">
            A falha foi ao carregar esta página — o link em si pode estar perfeito. Se insistir, espera alguns minutos e
            toca de novo.
          </p>
        </>
      ) : (
        <p className="mt-4 text-[13px] leading-relaxed text-[#5c6280]">
          Links de resumo valem por poucos dias e podem ser desligados pelo paciente a qualquer momento — é assim de
          propósito. Peça um link novo pelo aplicativo dele.
        </p>
      )}
    </Cartao>
  );
}

function FormularioPin({
  mensagem,
  restantes,
  pin,
  setPin,
  enviando,
  onEnviar,
}: {
  mensagem: string;
  restantes: number | null;
  pin: string;
  setPin: (v: string) => void;
  enviando: boolean;
  onEnviar: () => void;
}) {
  return (
    <Cartao>
      <h2 className="text-[19px] font-bold tracking-tight text-[#0f1222]">Este resumo é protegido</h2>
      <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-[#475069]">{mensagem}</p>
      <form
        className="nao-imprime mt-5 flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (pin.length === 4 && !enviando) onEnviar();
        }}
      >
        <label className="sr-only" htmlFor="pin">
          PIN de 4 números
        </label>
        <input
          id="pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          enterKeyHint="go"
          placeholder="0000"
          className="h-[52px] w-[136px] rounded-xl border border-[#cdd2e0] bg-white px-4 text-center text-[22px] font-semibold tracking-[0.35em] text-[#0f1222] outline-none placeholder:text-[#aab0c4] focus:border-[#4f46e5]"
        />
        <button
          type="submit"
          disabled={pin.length !== 4 || enviando}
          className="h-[52px] rounded-xl bg-[#4f46e5] px-6 text-[15px] font-semibold text-white transition hover:bg-[#4338ca] disabled:opacity-40"
        >
          {enviando ? 'Conferindo…' : 'Abrir resumo'}
        </button>
      </form>
      {restantes !== null && (
        <p className="mt-3 text-[13px] font-medium" style={{ color: restantes === 1 ? TOM.perigo.texto : '#5c6280' }}>
          {restantes === 1 ? 'Última tentativa antes de o link travar.' : `${restantes} tentativas restantes.`}
        </p>
      )}
      <p className="mt-4 text-[13px] leading-relaxed text-[#5c6280]">
        O PIN é combinado entre você e o paciente. Ele existe porque um link de prontuário costuma ser reencaminhado — e
        quem recebe o encaminhamento não deveria abrir.
      </p>
    </Cartao>
  );
}

// ─── O documento ───────────────────────────────────────────────────────────────

const RUBRICA: Record<Gravidade, { rotulo: string; tom: Tom }> = {
  grave: { rotulo: 'grave', tom: 'perigo' },
  moderada: { rotulo: 'moderada', tom: 'atencao' },
  leve: { rotulo: 'leve', tom: 'neutro' },
  // "a confirmar" e não "sem gravidade": a segunda soa como boa notícia e não é.
  desconhecida: { rotulo: 'gravidade a confirmar', tom: 'atencao' },
};

function Documento({ resumo, agora }: { resumo: ResumoMedico; agora: number }) {
  const tri = useMemo(() => triagem(resumo), [resumo]);
  const alergias = useMemo(() => ordenarAlergias(resumo.alergias), [resumo]);
  const { series, total: totalSeries } = useMemo(() => seriesDosExames(resumo.exames), [resumo]);
  const f = frescor(resumo.geradoEm, agora);
  const pct = adesaoPercentual(resumo.adesao30d);

  return (
    <div className="space-y-8">
      {/* 1 · A triagem. Antes de qualquer rolagem, e sem competir com nada. */}
      <FaixaTriagem tri={tri} />

      {f.avisar && (
        <p
          className="rounded-xl border px-4 py-3 text-[14px] leading-relaxed"
          style={{ background: TOM.atencao.fundo, borderColor: TOM.atencao.borda, color: TOM.atencao.texto }}
        >
          {/* Data ilegível não vira "0 dias": esse número contradizia o cabeçalho ao lado
              ("data de geração não registrada") e era o "fingir que é de hoje" que este
              aviso existe para impedir. Sem data, o aviso diz que não sabe. */}
          {f.dias === null ? (
            <>
              <strong className="font-semibold">Não sei quando este retrato foi montado.</strong> Trate as informações
              como possivelmente desatualizadas — o resumo é congelado no momento em que o paciente cria o link.
            </>
          ) : (
            <>
              <strong className="font-semibold">Este retrato tem {f.dias} dias.</strong> O resumo é congelado no momento
              em que o paciente cria o link — medicações e exames podem ter mudado desde então.
            </>
          )}
        </p>
      )}

      {/* 2 · O censo. É índice e é inventário: responde "isso é tudo?" numa linha. */}
      <Censo resumo={resumo} />

      <Secao
        id="sec-alergias"
        titulo="Alergias"
        contador={alergias.length}
        vazio="Nenhuma alergia registrada. Isso significa que nada foi registrado — não que o paciente tenha negado alergias."
      >
        {alergias.length > 0 && (
          <ListaCartao>
            {alergias.map((a, i) => (
              <LinhaAlergia key={i} a={a} />
            ))}
          </ListaCartao>
        )}
      </Secao>

      <Secao
        id="sec-medicamentos"
        titulo="Medicamentos em uso"
        contador={resumo.medicamentos.length}
        vazio="Nenhum medicamento em uso registrado."
      >
        {resumo.medicamentos.length > 0 && (
          <ListaCartao>
            {resumo.medicamentos.map((m, i) => (
              <Linha
                key={i}
                titulo={m.nome}
                // "dose não registrada" e não vazio: o médico precisa distinguir o que a
                // Xarlote não sabe do que o remédio não tem.
                detalhe={[m.dosagem, m.frequencia].filter(Boolean).join(' · ') || 'dose e frequência não registradas'}
              />
            ))}
          </ListaCartao>
        )}
      </Secao>

      <Secao
        id="sec-adesao"
        titulo="Adesão ao tratamento"
        vazio="Sem doses registradas nos últimos 30 dias — não há como estimar adesão."
      >
        {pct !== null && <CartaoAdesao pct={pct} />}
      </Secao>

      <Secao
        id="sec-condicoes"
        titulo="Condições de saúde"
        contador={resumo.condicoes.length}
        vazio="Nenhuma condição de saúde registrada."
      >
        {resumo.condicoes.length > 0 && (
          <ListaCartao>
            {resumo.condicoes.map((c, i) => (
              <Linha key={i} titulo={c.nome} detalhe={c.desde ? `desde ${dataBr(c.desde)}` : 'início não registrado'} />
            ))}
          </ListaCartao>
        )}
      </Secao>

      <Secao
        id="sec-exames"
        titulo="Exames"
        contador={resumo.exames.length}
        vazio="Nenhum exame registrado. O paciente pode fotografar um laudo pelo aplicativo e ele passa a constar aqui."
      >
        {resumo.exames.length > 0 && (
          <div className="space-y-5">
            {series.length > 0 && (
              <div>
                <h3 className="mb-1 text-[15px] font-semibold text-[#0f1222]">Marcadores com histórico</h3>
                <p className="mb-3 text-[13px] leading-relaxed text-[#5c6280]">
                  {series.length === totalSeries
                    ? `${totalSeries} ${totalSeries === 1 ? 'marcador' : 'marcadores'} com duas ou mais medições. Os valores de todos os exames estão nas tabelas abaixo.`
                    : `${series.length} de ${totalSeries} marcadores com histórico, começando pelos que saíram da faixa do laudo. Os valores de todos estão nas tabelas abaixo.`}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {series.map((s, i) => (
                    <Grafico key={s.chave} serie={s} idx={i} />
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3">
              {resumo.exames.map((e, i) => (
                <CartaoExame key={i} exame={e} />
              ))}
            </div>
          </div>
        )}
      </Secao>

      {/* Não há seção de documentos, e a ausência é deliberada — ver `share-grants.ts`.
          Enquanto nada preencher os anexos do paciente, uma seção dizendo "nenhum documento
          anexado" seria a página afirmando ao médico algo que ela não sabe. */}

      <Rodape resumo={resumo} />
    </div>
  );
}

function FaixaTriagem({ tri }: { tri: ReturnType<typeof triagem> }) {
  const tom: Tom = tri.nivel === 'critico' ? 'perigo' : tri.nivel === 'atencao' ? 'atencao' : 'neutro';
  const c = TOM[tom];
  return (
    <Cartao tom={tom} className="border-2">
      <div className="flex items-start gap-3">
        <Sinal nivel={tri.nivel} cor={c.forte} />
        <div className="min-w-0">
          <p className="text-[19px] font-bold leading-tight tracking-tight sm:text-[21px]" style={{ color: c.forte }}>
            {tri.titulo}
          </p>
          <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: c.texto }}>
            {tri.detalhe}
          </p>
          {tri.criticas.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {tri.criticas.map((a, i) => (
                <li key={i}>
                  <span
                    className="inline-flex items-baseline gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-[16px] font-bold leading-none"
                    style={{ borderColor: c.borda, color: c.forte }}
                  >
                    {a.substancia}
                    {/* A reação é o dado que muda a conduta ("choque anafilático"), não um
                        metadado: 13px, o piso da régua para dado clínico. */}
                    {a.reacao && <span className="text-[13px] font-medium text-[#5c6280]">{a.reacao}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Cartao>
  );
}

/** Triângulo (perigo/atenção) ou círculo de informação. Forma diferente, não só cor. */
function Sinal({ nivel, cor }: { nivel: 'critico' | 'atencao' | 'neutro'; cor: string }) {
  if (nivel === 'neutro') {
    return (
      <svg width="26" height="26" viewBox="0 0 24 24" className="mt-0.5 shrink-0" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9.5" fill="none" stroke={cor} strokeWidth="1.8" />
        <path d="M12 11v6" stroke={cor} strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="7.6" r="1.2" fill={cor} />
      </svg>
    );
  }
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" className="mt-0.5 shrink-0" aria-hidden="true" focusable="false">
      <path
        d="M12 3.2 22 20.4H2L12 3.2Z"
        fill="none"
        stroke={cor}
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M12 9.4v5.2" stroke={cor} strokeWidth="2.1" strokeLinecap="round" />
      <circle cx="12" cy="17.6" r="1.25" fill={cor} />
    </svg>
  );
}

/**
 * O censo — âncoras com contagem.
 *
 * Repete os números que cada seção também mostra, e isso é proposital: aqui eles são o
 * inventário do documento (o que existe, em uma linha, antes de rolar) e lá são o cabeçalho
 * de quem chegou pela âncora. São dois papéis, não a mesma etiqueta duplicada a 60px.
 */
function Censo({ resumo }: { resumo: ResumoMedico }) {
  const itens: Array<{ href: string; rotulo: string; n: number; tom?: Tom }> = [
    { href: '#sec-alergias', rotulo: 'Alergias', n: resumo.alergias.length, tom: resumo.alergias.length > 0 ? 'perigo' : undefined },
    { href: '#sec-medicamentos', rotulo: 'Medicamentos', n: resumo.medicamentos.length },
    { href: '#sec-condicoes', rotulo: 'Condições', n: resumo.condicoes.length },
    { href: '#sec-exames', rotulo: 'Exames', n: resumo.exames.length },
  ];
  return (
    <nav aria-label="Conteúdo deste resumo" className="flex flex-wrap gap-2">
      {itens.map((i) => {
        const c = i.tom ? TOM[i.tom] : TOM.neutro;
        return (
          <a
            key={i.href}
            href={i.href}
            // Chip do censo é navegação, não etiqueta: 44px de alvo, como qualquer link
            // que o médico acerta com o polegar no corredor da clínica.
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border bg-white px-3 text-[13px] font-semibold text-[#0f1222] transition hover:border-[#4f46e5]"
            style={{ borderColor: i.n > 0 ? c.borda : '#e6e8f0' }}
          >
            {i.rotulo}
            <span
              className="tabular-nums"
              style={{ color: i.n > 0 ? c.forte : '#8a90a8' }}
            >
              {i.n}
            </span>
          </a>
        );
      })}
    </nav>
  );
}

function LinhaAlergia({ a }: { a: Alergia }) {
  const r = RUBRICA[a.gravidade];
  return (
    <Linha
      titulo={a.substancia}
      detalhe={a.reacao ?? 'reação não registrada'}
      tom={a.gravidade === 'grave' ? 'perigo' : undefined}
      // O texto original ganha do rótulo normalizado: "anafilaxia" diz ao médico
      // muito mais do que "grave", e foi o que o paciente falou.
      acessorio={<Chip tom={r.tom}>{a.gravidadeBruta ?? r.rotulo}</Chip>}
    />
  );
}

function CartaoAdesao({ pct }: { pct: number }) {
  return (
    <Cartao className="flex flex-wrap items-center gap-5">
      <Arco percentual={pct} />
      <div className="min-w-[200px] flex-1">
        <p className="text-[38px] font-bold leading-none tabular-nums tracking-tight text-[#0f1222]">{pct}%</p>
        <p className="mt-2 text-[14px] leading-relaxed text-[#475069]">
          das doses <strong className="font-semibold">registradas</strong> nos últimos 30 dias foram confirmadas pelo
          paciente no aplicativo.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-[#5c6280]">
          Dose não confirmada não é prova de dose não tomada — pode ser só uma confirmação que ele não deu. Serve para
          conversar sobre o tratamento, não para concluir sobre ele.
        </p>
      </div>
    </Cartao>
  );
}

function CartaoExame({ exame }: { exame: ResumoMedico['exames'][number] }) {
  return (
    <Cartao>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[16px] font-semibold tracking-tight text-[#0f1222]">{exame.tipo}</h3>
        <p className="text-[13px] font-medium text-[#5c6280]">
          {exame.data ? dataBr(exame.data) : 'data não identificada no laudo'}
        </p>
      </div>

      {exame.valores.length > 0 && (
        <table className="mt-3 w-full border-collapse text-left">
          <caption className="sr-only">Valores lidos no laudo de {exame.tipo}</caption>
          <thead>
            <tr className="border-b border-[#eef0f6]">
              <th scope="col" className="pb-1.5 text-[12px] font-semibold uppercase tracking-wider text-[#5c6280]">
                Marcador
              </th>
              <th scope="col" className="pb-1.5 text-right text-[12px] font-semibold uppercase tracking-wider text-[#5c6280]">
                Resultado
              </th>
            </tr>
          </thead>
          <tbody>
            {exame.valores.map((v, i) => (
              <LinhaValor key={i} v={v} />
            ))}
          </tbody>
        </table>
      )}

      {exame.valoresOmitidos > 0 && (
        <p className="mt-2 text-[13px] text-[#5c6280]">
          +{exame.valoresOmitidos} {exame.valoresOmitidos === 1 ? 'marcador' : 'marcadores'} deste laudo não entraram no
          resumo.
        </p>
      )}

      {exame.resumo && (
        <p className="mt-3 border-t border-[#eef0f6] pt-3 text-[14px] leading-relaxed text-[#475069]">{exame.resumo}</p>
      )}

      {exame.valores.length === 0 && !exame.resumo && (
        <p className="mt-2 text-[14px] leading-relaxed text-[#5c6280]">
          Exame registrado, mas nenhum valor foi lido do laudo.
        </p>
      )}
    </Cartao>
  );
}

function LinhaValor({ v }: { v: ResumoMedico['exames'][number]['valores'][number] }) {
  // A comparação é feita com a faixa DESTE laudo, na hora de desenhar. Congelar o veredicto
  // no link prenderia a leitura de hoje: parser melhor amanhã não alcançaria links de ontem.
  const ref = lerReferencia(v.referencia);
  const sit = situacao(numeroBr(v.valor), ref);
  const fora = sit === 'acima' || sit === 'abaixo';

  return (
    <tr className="border-b border-[#f2f4f9] align-top last:border-b-0">
      <th scope="row" className="py-2 pr-3 font-normal">
        <span className="block text-[15px] font-semibold leading-snug text-[#0f1222]">{v.marcador}</span>
        {/* Faixa do laudo e unidade são dado clínico — a régua os põe em 13px, junto com
            data de exame. 12px fica só para rótulo de estrutura (o `<thead>` acima). */}
        {v.referencia && <span className="mt-0.5 block text-[13px] text-[#5c6280]">ref. {v.referencia}</span>}
      </th>
      <td className="py-2 text-right">
        <span className="block whitespace-nowrap text-[15px] font-semibold tabular-nums text-[#0f1222]">
          {v.valor}
          {v.unidade && <span className="ml-1 text-[13px] font-medium text-[#5c6280]">{v.unidade}</span>}
        </span>
        {fora && (
          <span className="mt-1 inline-block">
            {/* "da faixa do laudo", nunca "alterado": aritmética, não interpretação. */}
            <Chip tom="perigo">{sit === 'acima' ? '↑ acima da faixa' : '↓ abaixo da faixa'}</Chip>
          </span>
        )}
      </td>
    </tr>
  );
}

function Rodape({ resumo }: { resumo: ResumoMedico }) {
  // `dataBr('')` devolve string vazia, e a linha imprimia "Retrato montado em  · formato v2".
  // Sem data legível, a frase inteira sai: metade de uma afirmação não é uma afirmação.
  const montadoEm = dataBr(resumo.geradoEm);
  return (
    <footer className="border-t border-[#e6e8f0] pt-6">
      <p className="max-w-prose text-[13px] leading-relaxed text-[#5c6280]">
        Resumo organizado pela Xarlote a partir do que o paciente relatou e do que foi registrado no acompanhamento.{' '}
        <strong className="font-semibold text-[#475069]">Não é laudo nem diagnóstico</strong>, e pode estar incompleto.
        Valores de exame são transcrições de laudos fotografados pelo paciente — confirme no documento original antes de
        decidir conduta.
      </p>
      <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-[#5c6280]">
        O paciente é avisado de que este link foi aberto, e pode desligá-lo quando quiser. O link expira sozinho.
      </p>
      <p className="mt-4 text-[12px] text-[#8a90a8]">
        {montadoEm && <>Retrato montado em {montadoEm} · </>}formato v{resumo.versao}
      </p>
    </footer>
  );
}
