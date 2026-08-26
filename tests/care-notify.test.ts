/**
 * Quem é avisado quando alguém mexe no seu registro.
 *
 * Consentimento dado uma vez não é vigilância permanente: quem autorizou o filho em março
 * precisa continuar enxergando, em agosto, o que ele anda fazendo. E o aviso tem função de
 * segurança concreta — se aparecer um que ela não esperava, ela descobre AGORA que precisa
 * revogar, e não seis meses depois.
 */
import { describe, it, expect } from 'vitest';
import { acaoPesa, ACOES_QUE_PESAM } from '../apps/api/src/handlers/care-notify.js';
import { TOOLS_COM_SUJEITO, aceitaSujeito } from '../packages/shared/src/care-tools.js';

describe('avisar sobre o que MUDA o registro', () => {
  it.each([
    'create_reminder', 'cancel_reminders', 'save_exam_result',
    'log_medication_taken', 'log_symptom', 'save_user_profile_fact',
  ])('%s avisa o dono', (t) => {
    expect(acaoPesa(t)).toBe(true);
  });

  it('cancelar lembrete é o aviso que mais importa', () => {
    // Silenciar um lembrete de remédio sem a pessoa saber é o pior efeito possível de um
    // acesso legítimo — e é justamente o que ela não teria como perceber sozinha.
    expect(acaoPesa('cancel_reminders')).toBe(true);
  });
});

describe('o que NÃO avisa, e por quê', () => {
  it('leitura não avisa', () => {
    // Um filho que abre a tela da mãe todo dia geraria uma mensagem diária, e ela pararia
    // de ler todas — inclusive a que importa.
    expect(acaoPesa('list_reminders')).toBe(false);
  });

  it('emergência não avisa', () => {
    // No meio de uma emergência, a última coisa que ajuda é o telefone dela apitar com
    // aviso de sistema.
    expect(acaoPesa('red_flag_check')).toBe(false);
  });

  it('tool inexistente não avisa', () => {
    expect(acaoPesa('tool_que_nao_existe')).toBe(false);
  });
});

describe('as duas listas se sustentam', () => {
  it('🔴 toda ação que avisa TEM que ser redirecionável', () => {
    // Avisar sobre uma tool que não pode agir por terceiro é código morto: o aviso nunca
    // dispararia, e alguém contaria com uma transparência que não existe.
    for (const t of ACOES_QUE_PESAM) {
      expect(aceitaSujeito(t), `"${t}" avisa mas não aceita \`para_quem\``).toBe(true);
    }
  });

  it('e as redirecionáveis que NÃO avisam são só as duas justificadas', () => {
    // Qualquer tool nova em TOOLS_COM_SUJEITO cai aqui até alguém decidir, por escrito,
    // se ela avisa o dono do registro. Silêncio por esquecimento é o que este teste impede.
    const semAviso = TOOLS_COM_SUJEITO.filter((t) => !acaoPesa(t)).sort();
    expect(semAviso).toEqual(['list_reminders', 'red_flag_check']);
  });
});
