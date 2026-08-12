/**
 * "Qual versão você tem?" — a resposta que o suporte precisa, sem poder derrubar o app.
 *
 * ## Por que este arquivo existe (custou DOIS crashes)
 *
 * **Tentativa 1.** `import * as Updates from 'expo-updates'` no topo da tela de Perfil.
 * O app fechou na abertura em qualquer binário compilado antes de o pacote existir:
 *
 *     Uncaught Error: Cannot find native module 'ExpoUpdates'
 *
 * Módulo nativo não chega por bundle de JS; chega por build. O dev client instalado no
 * simulador era anterior ao `expo-updates`, e um import estático é avaliado no
 * carregamento do módulo — antes de qualquer proteção poder ajudar.
 *
 * **Tentativa 2.** Trocar por `require('expo-updates')` dentro de `try/catch`. Parecia
 * óbvio, e **não funcionou**: o mesmo crash, agora com a linha do `require` dentro do
 * `try` apontada no stack. Em React Native, `require` de um módulo nativo ausente não é
 * um throw que o `catch` do chamador absorve de forma confiável — o `require` do Metro
 * não é o do Node, e envolvê-lo em try/catch é uma intuição de Node que não transfere.
 *
 * **O que funciona** é a API que a Expo criou para exatamente esta pergunta:
 * `requireOptionalNativeModule` devolve `null` quando o módulo não está no binário, em
 * vez de lançar. Lendo os campos direto do módulo nativo, `expo-updates` nunca precisa
 * ser importado — e o arquivo deixa de ter como quebrar.
 *
 * A lição vale além daqui: **a guarda certa pra módulo nativo é perguntar se ele existe,
 * não tentar usá-lo e torcer pro erro ser pegável.**
 *
 * ## Por que isto importa em produção, e não só no simulador
 *
 * A mesma situação existe em qualquer janela em que um binário antigo receba JS novo —
 * que é precisamente o que o expo-updates serve pra fazer. Um rótulo de versão no pé da
 * tela de Perfil não pode ser capaz de impedir o paciente de abrir o próprio prontuário.
 */
import Constants from 'expo-constants';
// Vem de `expo` e não de `expo-modules-core`: sob pnpm estrito, o core não é dependência
// direta deste app — e o pacote `expo` reexporta o helper justamente pra isso.
import { requireOptionalNativeModule } from 'expo';

/** O contrato mínimo que a gente lê. O módulo nativo expõe muito mais. */
interface UpdatesNativo {
  isEnabled?: boolean;
  updateId?: string | null;
  runtimeVersion?: string | null;
  channel?: string | null;
  isEmbeddedLaunch?: boolean;
}

export interface VersaoDoApp {
  /** A versão que o paciente reconhece (a mesma da loja). */
  versao: string;
  /** Compatibilidade nativa — muda quando o binário muda (política `fingerprint`). */
  runtime: string | null;
  /** Os 8 primeiros caracteres do update OTA em uso, ou null se é o JS embutido. */
  update: string | null;
  /** O canal de EAS Update deste binário (`development`/`preview`/`production`). */
  canal: string | null;
  /** O módulo nativo de OTA existe neste binário? */
  otaDisponivel: boolean;
}

let cache: VersaoDoApp | null = null;

export function versaoDoApp(): VersaoDoApp {
  if (cache) return cache;

  const versao = Constants.expoConfig?.version ?? '—';
  // `null` quando o binário não tem o módulo — nenhum throw, nenhum try/catch.
  const nativo = requireOptionalNativeModule<UpdatesNativo>('ExpoUpdates');

  cache = nativo
    ? {
        versao,
        runtime: nativo.runtimeVersion ?? null,
        update: nativo.updateId ? nativo.updateId.slice(0, 8) : null,
        canal: nativo.channel ?? null,
        otaDisponivel: true,
      }
    : { versao, runtime: null, update: null, canal: null, otaDisponivel: false };

  return cache;
}

/**
 * Uma linha pronta pro pé da tela.
 *
 * Quando o binário não tem OTA, o rótulo DIZ isso ("sem OTA neste build") em vez de
 * omitir: um build sem canal de atualização é um build que não pode ser corrigido
 * remotamente, e quem está diagnosticando precisa saber disso de imediato.
 */
export function rotuloDeVersao(): string {
  const v = versaoDoApp();
  const sufixo = !v.otaDisponivel ? 'sem OTA neste build' : (v.update ?? 'embutida');
  return `Xarlote ${v.versao} · ${sufixo}`;
}
