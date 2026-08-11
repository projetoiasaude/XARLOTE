/**
 * Push notification — o único caminho pra alcançar o paciente com o app FECHADO.
 *
 * O SSE cobre o app aberto e morre no background de propósito (bateria). Então quem
 * avisa "hora do remédio" ou "seu médico abriu seu prontuário" às 8 da manhã com o
 * celular no bolso é isto.
 *
 * ## Por que Firebase nos DOIS lados
 *
 * O backend (`packages/integrations/src/push.ts`) já fala FCM HTTP v1 e está em
 * produção há meses. Usar FCM também no iOS (em vez de APNs direto) mantém UM backend
 * só: o Firebase repassa pro APNs. O preço é depender da APNs Auth Key subida no
 * console do Firebase — sem ela, o iOS registra e nada chega.
 *
 * ## O que este arquivo NÃO faz
 *
 * Não pede permissão no arranque. Um app de saúde que pede notificação antes de a
 * pessoa entender o que ele faz é negado na hora — e permissão negada no iOS **não
 * pode ser pedida de novo** pelo app, só nos Ajustes do sistema. Então o pedido é
 * feito no momento em que o valor está óbvio (ao criar o primeiro lembrete, ou na
 * tela de perfil), nunca antes.
 */
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { apiFetch } from './api/client';

/** Só existe aparelho de verdade pra registrar — simulador não recebe push de iOS. */
export function podeReceberPush(): boolean {
  return Device.isDevice;
}

function plataforma(): 'ios' | 'android' | 'web' {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/**
 * Manda o token pro servidor amarrado ao paciente logado.
 *
 * O `userId` vem do JWT no servidor, NUNCA do corpo — é o que fecha o buraco do
 * registro legado, onde qualquer um podia registrar o próprio aparelho no telefone de
 * outra pessoa e passar a receber os lembretes clínicos dela.
 */
export async function registrarToken(token: string, appVersion?: string): Promise<void> {
  await apiFetch('/app/devices', {
    method: 'POST',
    body: { token, platform: plataforma(), ...(appVersion ? { appVersion } : {}) },
  });
}

/**
 * Dá baixa no token. Chamado no logout — e é importante: sem isto, o aparelho continua
 * recebendo os lembretes de quem saiu da conta. Num celular compartilhado (comum entre
 * pacientes idosos e cuidadores) isso vaza dado clínico pra outra pessoa.
 */
export async function darBaixaToken(token: string): Promise<void> {
  try {
    await apiFetch('/app/devices', { method: 'DELETE', body: { token } });
  } catch {
    // Logout não pode falhar por causa disto. O servidor também limpa token morto
    // quando o FCM reporta que ele não existe mais.
  }
}
