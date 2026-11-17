#!/bin/bash
# Espera o dono decidir um cartão (pedido) e imprime a linha final do registro de ações.
# Uso: esperar-cartao.sh <pedido> [segundos_max]   (rode em segundo plano: o Claude acorda quando ele termina)
P="$1"; MAX="${2:-1800}"
F="${WA_ACOES:-$HOME/Library/Logs/whatsapp-claude/acoes.jsonl}"
[ -f "$F" ] || F="$(find "$HOME/Library/Logs" "$HOME/AppData" -path '*whatsapp-claude*' -name acoes.jsonl 2>/dev/null | head -1)"
[ -n "$P" ] && [ -f "$F" ] || { echo "sem registro ou sem pedido"; exit 2; }
for ((i=0; i<MAX; i++)); do
  L="$(grep "\"pedido\":\"$P\"" "$F" | grep -E '"evento":"cancelado"|"confirmacao":|"evento":"erro"' | tail -1)"
  [ -n "$L" ] && { echo "$L" | cut -c1-400; exit 0; }
  sleep 1
done
echo "cartão $P sem decisão em ${MAX}s"; exit 1
