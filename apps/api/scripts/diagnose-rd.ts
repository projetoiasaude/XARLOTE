/**
 * A RD (Drogasil) tem conserto? — sobe a escada de opções do ZenRows e mede cada degrau.
 *
 * Diagnóstico de 01/09/2026: o proxy responde HTTP 200, mas com ~2.4KB contendo o
 * SENSOR do Akamai Bot Manager (`<script src="/<hash>/<hash>/ax/...">`) em vez da
 * página. O `rd-adapter` chama o ZenRows sem NENHUMA opção — proxy puro, sem executar
 * JavaScript — então recebe o desafio e nunca o resolve. Em 14/07 proxy puro bastava;
 * o Akamai apertou desde então.
 *
 * Este script não conserta: ele MEDE qual combinação vence hoje, pra decidir com dado
 * em vez de tentativa no código de produção.
 *
 *   railway run --service ia-da-saude-api ./apps/api/node_modules/.bin/tsx apps/api/scripts/diagnose-rd.ts
 *
 * ⚠️ CUSTO: cada degrau consome créditos, e `js_render`+`premium_proxy` custa MUITO mais
 * que proxy puro (ordem de 25× na tabela do ZenRows). A corrida inteira gasta algumas
 * dezenas de créditos. É diagnóstico, não é pra rodar em laço.
 */
import axios from 'axios';
import { extractNextData, parseRDSearch } from '@iasaude/integrations';

const ALVO = 'https://www.drogasil.com.br/search?w=dipirona';

/** Os degraus, do mais barato ao mais caro. O primeiro que vencer é a resposta. */
const DEGRAUS: Array<{ nome: string; params: Record<string, string> }> = [
  { nome: 'proxy puro (o que está em produção hoje)', params: {} },
  { nome: 'js_render', params: { js_render: 'true' } },
  { nome: 'js_render + premium_proxy BR', params: { js_render: 'true', premium_proxy: 'true', proxy_country: 'br' } },
  { nome: 'js_render + premium BR + antibot + wait 5s', params: { js_render: 'true', premium_proxy: 'true', proxy_country: 'br', antibot: 'true', wait: '5000' } },
];

/** O sensor do Akamai: script com caminho de segmentos aleatórios terminando em /ax/. */
function pareceDesafioAkamai(html: string): boolean {
  return /<script[^>]+src="\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{8,}\//.test(html) || /Access Denied|Reference #\d/i.test(html);
}

async function main(): Promise<void> {
  const apikey = (process.env['ZENROWS_API_KEY'] ?? '').trim();
  if (!apikey) {
    console.log('ZENROWS_API_KEY ausente — rode com `railway run`, senão você mede o seu .env.');
    return;
  }
  console.log(`alvo: ${ALVO}\n${'─'.repeat(76)}`);

  for (const degrau of DEGRAUS) {
    let linha = `▸ ${degrau.nome}\n   `;
    try {
      const res = await axios.get('https://api.zenrows.com/v1/', {
        params: { apikey, url: ALVO, ...degrau.params },
        timeout: 90000, // js_render é lento; 40s não bastava
        responseType: 'text',
        transformResponse: [(d) => d],
        validateStatus: () => true,
      });
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

      // O ZenRows devolve o custo em header — é o dado que decide se vale a pena.
      const custo = Object.entries(res.headers as Record<string, unknown>)
        .filter(([k]) => /cost|credit|concurren/i.test(k))
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' · ');

      if (res.status !== 200) {
        console.log(`${linha}HTTP ${res.status} — ${html.slice(0, 160).replace(/\s+/g, ' ')}`);
        continue;
      }

      const nd = extractNextData(html);
      const hits = nd ? parseRDSearch(nd) : [];
      const veredito = hits.length
        ? `✅ VENCEU — ${hits.length} produtos (${hits.filter((h) => !h.isKit).length} fora de kit)`
        : nd
          ? '⚠️  passou o Akamai mas o shape do __NEXT_DATA__ não bate'
          : pareceDesafioAkamai(html)
            ? '❌ desafio do Akamai (sensor), não resolvido'
            : '❌ sem __NEXT_DATA__ e sem cara de desafio — página inesperada';

      console.log(`${linha}${String(html.length).padStart(7)} bytes · ${veredito}${custo ? `\n   custo: ${custo}` : ''}`);
      if (hits.length) {
        for (const h of hits.slice(0, 3)) console.log(`      ${h.isKit ? '[kit] ' : '      '}${h.name.slice(0, 54)}`);
        console.log(`\n→ Use ESTES parâmetros no rd-adapter.ts: ${JSON.stringify(degrau.params)}`);
        return; // primeiro que vence é o mais barato que vence — não gasta os degraus acima
      }
    } catch (err) {
      console.log(`${linha}falhou: ${err instanceof Error ? err.message.slice(0, 90) : String(err)}`);
    }
  }

  console.log(`\n${'─'.repeat(76)}`);
  console.log('Nenhum degrau venceu. O ZenRows não passa mais no Akamai da RD.');
  console.log('Aí a decisão deixa de ser técnica: trocar de provedor anti-bot, ou aceitar');
  console.log('a RD fora do pool e apoiar a cotação nas 3 redes que entregam em 60 min.');
}

void main();
