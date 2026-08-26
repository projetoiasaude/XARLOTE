/**
 * A separação da regex de emergência não pode ter mudado nada pra quem não tem vínculo.
 *
 * `PAST_OR_OTHER_RE` era UM regex com 23 alternativas, misturando dois motivos distintos
 * de não acionar o SAMU: PASSADO ("semana passada", "já tive") e TERCEIRA PESSOA ("minha
 * mãe"). A F3 separou os dois, porque com vínculo o segundo motivo deixa de valer.
 *
 * O risco da separação é silencioso e grave nas duas direções: um termo perdido faria uma
 * emergência antes suprimida passar a disparar o SAMU (alarme falso), e um termo duplicado
 * ou mal transcrito faria o contrário — silêncio sobre um caso real.
 *
 * Este teste guarda a fronteira: a UNIÃO dos dois regexes tem que ser exatamente o regex
 * antigo, termo a termo.
 */
import { describe, it, expect } from 'vitest';
import { PASSADO_RE, TERCEIRO_RE } from '../packages/shared/src/care-tools.js';

/** O regex ORIGINAL, copiado de `inbound-user.ts` antes da separação. */
const ORIGINAL =
  /\b(semana passada|m[êe]s passado|ano passado|ontem|anteontem|passad[oa]|minha m[ãa]e|meu pai|minha av[óo]|meu av[ôo]|minha filha|meu filho|minha esposa|meu marido|um amigo|uma amiga|j[áa] tive|tinha tido|ele teve|ela teve|costumo ter|as vezes tenho|[àa]s vezes tenho)\b/i;

/** Um exemplo de CADA uma das 23 alternativas do regex original. */
const TERMOS = [
  'semana passada', 'mês passado', 'mes passado', 'ano passado', 'ontem', 'anteontem',
  'passado', 'passada', 'minha mãe', 'minha mae', 'meu pai', 'minha avó', 'minha avo',
  'meu avô', 'meu avo', 'minha filha', 'meu filho', 'minha esposa', 'meu marido',
  'um amigo', 'uma amiga', 'já tive', 'ja tive', 'tinha tido', 'ele teve', 'ela teve',
  'costumo ter', 'as vezes tenho', 'às vezes tenho',
];

const suprimeAgora = (t: string): boolean => PASSADO_RE.test(t) || TERCEIRO_RE.test(t);

describe('a união dos dois regexes é o regex antigo', () => {
  it.each(TERMOS)('"%s" continua suprimindo', (termo) => {
    const frase = `${termo} com dor no peito`;
    expect(suprimeAgora(frase)).toBe(true);
  });

  it('🔴 três alternativas do ORIGINAL estavam mortas — e agora funcionam', () => {
    // `\b` em JS só conhece [A-Za-z0-9_]. Depois de um acento não há transição, então
    // `minha av[óo]\b` nunca casou com "minha avó". Estas três nunca suprimiram nada em
    // produção; a preempção de emergência disparava nelas.
    for (const morto of ['minha avó com dor no peito', 'meu avô com dor no peito', 'às vezes tenho dor no peito']) {
      expect(ORIGINAL.test(morto), `o original NÃO casava com "${morto}" — era o defeito`).toBe(false);
      expect(suprimeAgora(morto), `e agora casa`).toBe(true);
    }
  });

  it('e nada NOVO passou a suprimir', () => {
    // Frases de emergência de PRIMEIRA pessoa, que sempre dispararam e têm que continuar.
    for (const frase of [
      'estou com dor no peito',
      'to com falta de ar',
      'não consigo respirar',
      'acho que estou tendo um AVC',
      'minha cabeça está doendo muito forte',
    ]) {
      expect(ORIGINAL.test(frase)).toBe(false);
      expect(suprimeAgora(frase), `"${frase}" passou a ser suprimida`).toBe(false);
    }
  });

  it('cada termo cai em UM e apenas um dos dois motivos', () => {
    // Sobreposição significaria que o mesmo termo é tratado como passado E terceira
    // pessoa — e a correção da F3 depende de os dois conjuntos serem disjuntos.
    for (const termo of TERMOS) {
      const p = PASSADO_RE.test(termo);
      const t = TERCEIRO_RE.test(termo);
      expect(p !== t, `"${termo}" casa nos dois (ou em nenhum): passado=${p} terceiro=${t}`).toBe(true);
    }
  });
});

describe('a fronteira que a F3 move', () => {
  it('só a metade de TERCEIRA PESSOA é a que pode deixar de suprimir', () => {
    expect(TERCEIRO_RE.test('minha mãe')).toBe(true);
    expect(PASSADO_RE.test('minha mãe')).toBe(false);
  });

  it('a metade de PASSADO permanece intocável — nem com vínculo ela cede', () => {
    expect(PASSADO_RE.test('semana passada minha mãe teve dor no peito')).toBe(true);
  });
});
