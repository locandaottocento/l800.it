#!/bin/bash
# Ripristina i link Octotable free (senza widget) dopo la scadenza dell'abbonamento a pagamento.
# Uso: ./ripristina.sh   (da eseguire dalla root del repo l800.it)
set -e
cd "$(dirname "$0")/../.."

cp .backup-preAgosto2026/it/prenota.html prenota.html
cp .backup-preAgosto2026/it/index.html index.html
cp .backup-preAgosto2026/en/prenota.html en/prenota.html
cp .backup-preAgosto2026/en/index.html en/index.html

echo "File ripristinati alla versione pre-widget Octotable."
echo "Ora rivedi il diff con 'git diff', poi:"
echo "  git add prenota.html index.html en/prenota.html en/index.html"
echo "  git rm -r .backup-preAgosto2026"
echo "  git commit -m 'chore: rimuove widget Octotable a pagamento, torna a link free'"
echo "  git push origin main"
