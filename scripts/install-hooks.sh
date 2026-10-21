#!/bin/sh
# Installe le hook de pré-commit de solbot3.
#
#   sh scripts/install-hooks.sh
#
# Le dépôt doit être un dépôt Git (`git init` au besoin).
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)

if [ ! -d "$ROOT/.git" ]; then
  echo "  ✘ ce dossier n'est pas un dépôt Git — lancez d'abord : git init" >&2
  exit 1
fi

chmod +x "$ROOT/.githooks/pre-commit"
git -C "$ROOT" config core.hooksPath .githooks

echo "  ✔ hook de pré-commit installé (core.hooksPath = .githooks)"
echo "  ✔ les clés privées committées par accident bloqueront le commit"
