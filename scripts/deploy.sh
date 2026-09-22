#!/usr/bin/env bash
#
# Deploy da API/worker no Railway — com os portões que faltavam.
#
# Até 22/09/2026 o deploy era `railway up` direto do diretório local: subia o working
# tree COMO ESTÁ (inclusive arquivo não salvo no git), sem typecheck, sem teste, e sem
# nenhuma garantia de que aquele código existia em algum lugar além deste Mac.
#
#   ./scripts/deploy.sh api      # ia-da-saude-api
#   ./scripts/deploy.sh worker   # worker
#   ./scripts/deploy.sh ambos
#
# Variáveis:
#   PULAR_TESTES=1   pula typecheck+teste (só pra emergência declarada; avisa alto)
#   FORCAR_SUJO=1    permite deploy com working tree sujo (idem)
set -euo pipefail

ALVO="${1:-}"
case "$ALVO" in
  api)    SERVICOS=("ia-da-saude-api") ;;
  worker) SERVICOS=("worker") ;;
  ambos)  SERVICOS=("ia-da-saude-api" "worker") ;;
  *) echo "uso: $0 api|worker|ambos" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

echo "▸ 1/4 working tree"
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "${FORCAR_SUJO:-}" == "1" ]]; then
    echo "  ⚠️  árvore SUJA e FORCAR_SUJO=1 — o que sobe não é o que está no git:"
    git status --short | sed 's/^/     /'
  else
    echo "  ✗ árvore suja. O deploy manda o DIRETÓRIO, não o commit: o que subir aqui pode" >&2
    echo "    não existir em lugar nenhum. Comite (ou FORCAR_SUJO=1 se for emergência)." >&2
    git status --short | sed 's/^/     /' >&2
    exit 1
  fi
fi

echo "▸ 2/4 o commit existe fora deste computador?"
HEAD_SHA="$(git rev-parse HEAD)"
if git branch -r --contains "$HEAD_SHA" 2>/dev/null | grep -q .; then
  echo "  ✓ $(git rev-parse --short HEAD) está em pelo menos um branch remoto"
else
  echo "  ⚠️  $(git rev-parse --short HEAD) NÃO está em nenhum branch remoto."
  echo "     Se este disco falhar, produção fica sem fonte. Rode: git push -u origin $(git rev-parse --abbrev-ref HEAD)"
  # Aviso, não bloqueio: pode haver a emergência em que subir vale mais que o push.
fi

if [[ "${PULAR_TESTES:-}" == "1" ]]; then
  echo "▸ 3/4 typecheck + testes PULADOS (PULAR_TESTES=1) ⚠️"
else
  echo "▸ 3/4 typecheck + testes"
  pnpm -r typecheck
  CI=true pnpm test
fi

echo "▸ 4/4 railway up"
for s in "${SERVICOS[@]}"; do
  echo "  → $s"
  railway up -s "$s" --detach
done

echo
echo "Prova do deploy (o marcador é o uptime zerado, não o 'Build succeeded'):"
echo "  curl -s https://<api>/health | jq '.uptime_s'     # tem que ter reiniciado"
echo "  railway logs -s worker | grep 'Workers ON'        # linha NOVA"
