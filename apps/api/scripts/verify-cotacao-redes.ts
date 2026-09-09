/**
 * Verificador do pool de cotação por plataforma — quem responde HOJE, e com quê.
 *
 * Nasceu de uma pergunta simples que ninguém sabia responder sem adivinhar: "a
 * Drogasil está entrando nas cotações?". O adaptador da RD falha em SILÊNCIO por
 * desenho (sem `ZENROWS_API_KEY` ele devolve `[]` e a rede some do pool sem um
 * único log) — o que é certo pra não derrubar o fluxo do paciente, e péssimo pra
 * saber que o fluxo está degradado. Este script é o "estado vazio precisa FALAR".
 *
 * Rode COM o ambiente de produção, senão você mede o seu .env e não o que o
 * paciente recebe:
 *
 *   railway run --service api ./apps/api/node_modules/.bin/tsx apps/api/scripts/verify-cotacao-redes.ts
 *
 * Só faz leitura em API pública de e-commerce. Nenhum dado de paciente envolvido:
 * o que vai é nome de medicamento e CEP.
 */
import { quotePlatforms, activeNetworks } from '@iasaude/integrations';
import { ordenarCotacoesDeRede, faixaDePrazo } from '@iasaude/shared';

/** CEP de Goiânia (Setor Bueno) — a cidade onde a Xarlote atende hoje. */
const CEP = '74223060';

/** Remédios comuns e baratos: se a rede não casa NENHUM destes, o problema é dela. */
const TERMOS = ['dipirona 500mg', 'losartana 50mg', 'omeprazol 20mg'];

function reais(n: number): string {
  return `R$ ${n.toFixed(2)}`;
}

async function main(): Promise<void> {
  const temZenrows = !!(process.env['ZENROWS_API_KEY'] ?? '').trim();
  const ativas = activeNetworks();
  const rdAtiva = ativas.some((n) => n.access === 'akamai');

  console.log('─'.repeat(72));
  console.log(`ZENROWS_API_KEY: ${temZenrows ? 'PRESENTE' : 'AUSENTE'}`);
  console.log(`Redes no pool  : ${ativas.length} → ${ativas.map((n) => n.id).join(', ')}`);
  console.log(`Grupo RD       : ${rdAtiva ? 'no pool' : 'FORA DO POOL (sem proxy, some em silêncio)'}`);
  console.log('─'.repeat(72));

  // Quem respondeu ao menos uma vez, somando as rodadas — é isso que separa "a
  // rede está fora do pool" de "a rede está no pool e não achou este remédio".
  const respondeu = new Set<string>();

  for (const termo of TERMOS) {
    const t0 = Date.now();
    const quotes = await quotePlatforms(termo, CEP, { timeoutMs: 28000 });
    console.log(`\n▸ ${termo}  (${Date.now() - t0}ms · ${quotes.length} resposta(s))`);

    if (!quotes.length) {
      console.log('   nenhuma rede respondeu');
      continue;
    }

    // Usa o MESMO comparador da produção (`compararCotacoesDeRede`). Um diagnóstico
    // que ordena por conta própria mente com boa intenção: mostra uma ordem que o
    // paciente nunca vai ver.
    const ordenadas = ordenarCotacoesDeRede(
      quotes.map((q) => ({ ...q, lines: [q.sku], total: q.price })),
    );

    for (const q of ordenadas) {
      respondeu.add(q.networkLabel);
      const total = q.delivery ? reais(q.price + q.delivery.feeReais) : '—';
      const faixa = faixaDePrazo(q);
      const prazo = q.delivery
        ? `${q.delivery.etaText}, frete ${reais(q.delivery.feeReais)}`
        : 'SEM ENTREGA pra este CEP';
      console.log(`   ${q.networkLabel.padEnd(22)} ${reais(q.price).padStart(9)}  total ${total.padStart(9)}  [${faixa}] ${prazo}`);
    }
  }

  console.log(`\n${'─'.repeat(72)}`);
  const mudas = ativas.filter((n) => !respondeu.has(n.label)).map((n) => n.label);
  console.log(`Responderam: ${[...respondeu].join(', ') || 'ninguém'}`);
  console.log(`No pool e MUDAS em todas as rodadas: ${mudas.join(', ') || 'nenhuma'}`);
  if (rdAtiva && ![...respondeu].some((r) => /drogasil|raia|onofre/i.test(r))) {
    console.log('\n⚠️  A RD está no pool e não respondeu NENHUMA vez com remédio comum.');
    console.log('    Suspeitos, nesta ordem: crédito do ZenRows esgotado · chave inválida ·');
    console.log('    shape do __NEXT_DATA__ da Drogasil mudou (ver rd-adapter.ts).');
  }
}

void main();
