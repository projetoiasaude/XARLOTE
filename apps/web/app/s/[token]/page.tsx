/**
 * A página que o MÉDICO abre — a única superfície pública com dado clínico.
 *
 * O paciente gera um link no app e manda pro médico dele. Aqui não há login, não há
 * cadastro, não há app: o profissional abre no navegador do consultório e vê o quadro.
 *
 * ## As decisões que a página carrega
 *
 * · **Client component, e o token nunca vai pro servidor Next.** A busca é um POST do
 *   navegador direto pra API, com o token no CORPO. Se a página fosse renderizada no
 *   servidor, o token entraria nos logs do Next e do proxy — que é onde credencial some
 *   sem ninguém notar.
 * · **`noindex` de verdade** (metadata + header da API). Prontuário indexado por buscador
 *   é o pior desfecho possível deste recurso.
 * · **Uma só mensagem de recusa.** Expirado, revogado e inexistente dizem a mesma coisa,
 *   porque a API responde a mesma coisa — a página não inventa distinção que o backend
 *   recusa fazer de propósito.
 * · **Alergia primeiro, e em vermelho.** É o dado que muda conduta e o que alguém procura
 *   às pressas. Mesma ordem da Saúde 360 no app, e pelo mesmo motivo.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiUrl } from '@/lib/utils';

interface Resumo {
  gerado_em: string;
  paciente: { nome: string | null; idade: number | null };
  alergias: Array<{ substancia: string; reacao: string | null; gravidade: string | null }>;
  medicamentos: Array<{ nome: string; dosagem: string | null; frequencia: string | null }>;
  condicoes: Array<{ nome: string; desde: string | null }>;
  exames: Array<{ tipo: string; data: string | null; resumo: string | null }>;
  adesao_30d: number | null;
}

type Estado =
  | { t: 'carregando' }
  | { t: 'pin'; mensagem: string; restantes: number | null }
  | { t: 'ok'; resumo: Resumo }
  | { t: 'indisponivel'; mensagem: string };

function dataBr(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  // -3h fixo: mesmo raciocínio do app (o Brasil não tem horário de verão desde 2019).
  const d = new Date(ms - 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

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
          setEstado({ t: 'ok', resumo: corpo['resumo'] as Resumo });
        } else if (corpo['error'] === 'pin_necessario') {
          setEstado({
            t: 'pin',
            mensagem: (corpo['message'] as string) ?? 'Este link pede um PIN.',
            restantes: (corpo['tentativasRestantes'] as number) ?? null,
          });
        } else {
          setEstado({
            t: 'indisponivel',
            mensagem: (corpo['message'] as string) ?? 'Este link não está mais disponível.',
          });
        }
      } catch {
        setEstado({ t: 'indisponivel', mensagem: 'Não consegui carregar. Confere a conexão e tenta de novo.' });
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
    <main className="mx-auto min-h-screen max-w-2xl px-5 py-10 text-white">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-widest text-white/40">Xarlote · resumo clínico</p>
        {estado.t === 'ok' && (
          <>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">
              {estado.resumo.paciente.nome ?? 'Paciente'}
            </h1>
            <p className="mt-1 text-sm text-white/60">
              {estado.resumo.paciente.idade !== null ? `${estado.resumo.paciente.idade} anos · ` : ''}
              compartilhado em {dataBr(estado.resumo.gerado_em)}
            </p>
          </>
        )}
      </header>

      {estado.t === 'carregando' && <p className="text-white/50">Abrindo…</p>}

      {estado.t === 'indisponivel' && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <h2 className="text-lg font-semibold">Link indisponível</h2>
          <p className="mt-2 text-sm leading-relaxed text-white/60">{estado.mensagem}</p>
        </div>
      )}

      {estado.t === 'pin' && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <h2 className="text-lg font-semibold">Este link é protegido</h2>
          <p className="mt-2 text-sm text-white/60">{estado.mensagem}</p>
          <form
            className="mt-5 flex gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (pin.length === 4) void buscar(pin);
            }}
          >
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              inputMode="numeric"
              autoComplete="off"
              placeholder="0000"
              aria-label="PIN de 4 números"
              className="w-32 rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-center text-lg tracking-[0.4em] outline-none focus:border-white/30"
            />
            <button
              type="submit"
              disabled={pin.length !== 4 || enviando}
              className="rounded-xl bg-[#7c87ff] px-5 py-3 text-sm font-semibold disabled:opacity-40"
            >
              {enviando ? 'Conferindo…' : 'Abrir'}
            </button>
          </form>
          {estado.restantes !== null && (
            <p className="mt-3 text-xs text-white/40">
              {estado.restantes === 1
                ? 'Última tentativa antes de o link travar.'
                : `${estado.restantes} tentativas restantes.`}
            </p>
          )}
        </div>
      )}

      {estado.t === 'ok' && (
        <div className="space-y-8">
          {/* Alergias PRIMEIRO — é o que muda conduta. */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-rose-300">Alergias</h2>
            {estado.resumo.alergias.length === 0 ? (
              <p className="text-sm text-white/40">Nenhuma alergia registrada.</p>
            ) : (
              <ul className="space-y-2">
                {estado.resumo.alergias.map((a, i) => (
                  <li key={i} className="rounded-xl border border-rose-400/20 bg-rose-400/5 px-4 py-3">
                    <p className="font-semibold">{a.substancia}</p>
                    <p className="text-sm text-white/60">
                      {[a.reacao, a.gravidade].filter(Boolean).join(' · ') || 'sem detalhes'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Secao titulo="Medicamentos em uso" vazio="Nenhum medicamento registrado.">
            {estado.resumo.medicamentos.map((m, i) => (
              <Linha
                key={i}
                titulo={m.nome}
                sub={[m.dosagem, m.frequencia].filter(Boolean).join(' · ') || 'sem detalhes'}
              />
            ))}
          </Secao>

          <Secao titulo="Condições" vazio="Nenhuma condição registrada.">
            {estado.resumo.condicoes.map((c, i) => (
              <Linha key={i} titulo={c.nome} sub={c.desde ? `desde ${dataBr(c.desde)}` : ''} />
            ))}
          </Secao>

          <Secao titulo="Exames recentes" vazio="Nenhum exame registrado.">
            {estado.resumo.exames.map((e, i) => (
              <Linha key={i} titulo={e.tipo} sub={[dataBr(e.data), e.resumo].filter(Boolean).join(' · ')} />
            ))}
          </Secao>

          {estado.resumo.adesao_30d !== null && (
            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-white/50">
                Adesão (30 dias)
              </h2>
              <p className="text-2xl font-bold">{Math.round(estado.resumo.adesao_30d * 100)}%</p>
              <p className="text-xs text-white/40">
                doses confirmadas sobre doses registradas no período
              </p>
            </section>
          )}

          {/* O limite do que esta página é. O médico decide; a Xarlote organiza. */}
          <footer className="border-t border-white/10 pt-6 text-xs leading-relaxed text-white/35">
            Resumo organizado pela Xarlote a partir do que o paciente relatou e do que foi
            registrado no acompanhamento. Não é laudo nem diagnóstico, e pode estar
            incompleto. O paciente foi avisado de que este link foi aberto.
          </footer>
        </div>
      )}
    </main>
  );
}

function Secao({ titulo, vazio, children }: { titulo: string; vazio: string; children: React.ReactNode }) {
  const vazioDeVerdade = Array.isArray(children) && children.length === 0;
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/50">{titulo}</h2>
      {vazioDeVerdade ? <p className="text-sm text-white/40">{vazio}</p> : <ul className="space-y-2">{children}</ul>}
    </section>
  );
}

function Linha({ titulo, sub }: { titulo: string; sub: string }) {
  return (
    <li className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <p className="font-medium">{titulo}</p>
      {sub && <p className="text-sm text-white/50">{sub}</p>}
    </li>
  );
}
