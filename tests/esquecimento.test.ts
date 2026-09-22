/**
 * O apagamento que apagava sem pedir (auditoria 22/09, P0-3).
 *
 * Os três casos que motivaram o guard estão aqui como teste nomeado: "não confirmo
 * apagar nada", "quero sair de casa às 8h" e a confirmação solta sem pedido.
 */
import { describe, it, expect } from 'vitest';
import {
  decidirEsquecimento,
  pediuEsquecimento,
  confirmouEsquecimento,
  mensagemDeConfirmacaoDeEsquecimento,
  JANELA_DE_CONFIRMACAO_MS,
} from '../packages/shared/src/esquecimento.js';

const AGORA = Date.parse('2026-09-22T14:00:00-03:00');
const HA_UM_MINUTO = AGORA - 60_000;

describe('negação nunca apaga', () => {
  for (const frase of [
    'não! eu não confirmo apagar nada',
    'nao confirmo apagar',
    'não confirmo apagar meus dados',
    'jamais confirmo apagar',
    'confirmo apagar? não entendi',
    'você disse pra eu escrever CONFIRMO APAGAR mas não quero',
  ]) {
    it(`"${frase}" → não apaga`, () => {
      expect(confirmouEsquecimento(frase)).toBe(false);
      expect(decidirEsquecimento(frase, HA_UM_MINUTO, AGORA).acao).not.toBe('apagar');
    });
  }
});

describe('a confirmação de verdade', () => {
  for (const frase of [
    'CONFIRMO APAGAR',
    'confirmo apagar',
    '*CONFIRMO APAGAR*',
    'Confirmo apagar.',
    'confirmo apagar tudo',
    'CONFIRMO APAGAR MEUS DADOS!!',
    '  confirmo   apagar  ',
  ]) {
    it(`"${frase}" apaga quando há pedido pendente`, () => {
      expect(decidirEsquecimento(frase, HA_UM_MINUTO, AGORA)).toEqual({ acao: 'apagar' });
    });
  }

  it('sem pedido pendente, NÃO apaga — pergunta de novo', () => {
    expect(decidirEsquecimento('CONFIRMO APAGAR', null, AGORA)).toEqual({
      acao: 'perguntar',
      motivo: 'confirmou_sem_pedido',
    });
  });

  it('pedido frio (fora da janela) NÃO apaga', () => {
    const velho = AGORA - JANELA_DE_CONFIRMACAO_MS - 1;
    expect(decidirEsquecimento('CONFIRMO APAGAR', velho, AGORA)).toEqual({
      acao: 'perguntar',
      motivo: 'confirmou_tarde',
    });
  });

  it('na borda da janela ainda vale', () => {
    const naBorda = AGORA - JANELA_DE_CONFIRMACAO_MS;
    expect(decidirEsquecimento('confirmo apagar', naBorda, AGORA).acao).toBe('apagar');
  });
});

describe('"quero sair" precisa de objeto — o turno não pode ser engolido', () => {
  for (const frase of [
    'quero sair de casa às 8h, me lembra?',
    'não quero sair com essa dor',
    'quero sair pra caminhar amanhã cedo',
    'a médica falou que posso sair do hospital sexta',
    'quero sair da dieta hoje kkkk',
  ]) {
    it(`"${frase}" segue o turno normal`, () => {
      expect(pediuEsquecimento(frase)).toBe(false);
      expect(decidirEsquecimento(frase, null, AGORA)).toEqual({ acao: 'seguir' });
    });
  }

  for (const frase of [
    'quero sair do Xarlote',
    'quero sair do app',
    'queria sair do aplicativo',
    'quero sair do cadastro de vocês',
  ]) {
    it(`"${frase}" pergunta se é pra apagar`, () => {
      expect(decidirEsquecimento(frase, null, AGORA)).toEqual({ acao: 'perguntar', motivo: 'pediu' });
    });
  }
});

describe('pedidos legítimos de esquecimento', () => {
  for (const frase of [
    'quero apagar meus dados',
    'apaga meus dados por favor',
    'quero esquecer meus dados',
    'deletar minha conta',
    'quero excluir minha conta',
    'cancelar cadastro',
    'revogar consentimento',
    'quero ser esquecida',
    'estou exercendo meu direito ao esquecimento',
  ]) {
    it(`"${frase}" → perguntar`, () => {
      expect(decidirEsquecimento(frase, null, AGORA)).toEqual({ acao: 'perguntar', motivo: 'pediu' });
    });
  }

  for (const frase of [
    'não quero apagar meus dados',
    'não vou excluir minha conta, só queria entender',
    'nunca quis cancelar cadastro nenhum',
  ]) {
    it(`negado: "${frase}" segue o turno`, () => {
      expect(decidirEsquecimento(frase, null, AGORA)).toEqual({ acao: 'seguir' });
    });
  }
});

describe('formas que a revisão mostrou de fora (o direito não pode ficar difícil)', () => {
  for (const f of [
    'apague meus dados',
    'apaga meus dados',
    'quero apagar o meu histórico',
    'quero deletar tudo que você sabe sobre mim',
    'apaga tudo sobre mim',
    'exclua meus registros',
  ]) {
    it(`"${f}" → perguntar`, () => {
      expect(decidirEsquecimento(f, null, AGORA)).toEqual({ acao: 'perguntar', motivo: 'pediu' });
    });
  }

  it('"sim, confirmo apagar" confirma (a pessoa está respondendo a pergunta)', () => {
    expect(decidirEsquecimento('sim, confirmo apagar', HA_UM_MINUTO, AGORA)).toEqual({ acao: 'apagar' });
    expect(decidirEsquecimento('ok confirmo apagar', HA_UM_MINUTO, AGORA)).toEqual({ acao: 'apagar' });
  });

  it('mas "não, confirmo apagar" segue AMBÍGUO e não apaga', () => {
    expect(decidirEsquecimento('não, confirmo apagar', HA_UM_MINUTO, AGORA).acao).not.toBe('apagar');
  });
});

describe('conversa comum não vira apagamento', () => {
  for (const frase of [
    'pode apagar aquele lembrete das 8h?',
    'apaga a cotação da dipirona',
    'quero cancelar a consulta de quinta',
    'esqueci de tomar o remédio ontem',
    'apaguei a luz e fui dormir',
    'cancela meu pedido na farmácia',
  ]) {
    it(`"${frase}" segue o turno`, () => {
      expect(decidirEsquecimento(frase, null, AGORA)).toEqual({ acao: 'seguir' });
    });
  }
});

describe('mensagem', () => {
  it('diz o que some, que é irreversível e o prazo quando esfriou', () => {
    expect(mensagemDeConfirmacaoDeEsquecimento('pediu')).toContain('CONFIRMO APAGAR');
    expect(mensagemDeConfirmacaoDeEsquecimento('pediu')).toContain('irreversível');
    expect(mensagemDeConfirmacaoDeEsquecimento('confirmou_tarde')).toContain('15 minutos');
    expect(mensagemDeConfirmacaoDeEsquecimento('confirmou_sem_pedido')).toContain('sem querer');
  });

  it('texto vazio/nulo não decide nada', () => {
    expect(decidirEsquecimento('', null, AGORA)).toEqual({ acao: 'seguir' });
    expect(decidirEsquecimento(null, HA_UM_MINUTO, AGORA)).toEqual({ acao: 'seguir' });
  });
});
