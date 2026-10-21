#!/usr/bin/env node
/**
 * Garde-fou de pré-commit : refuse qu'une clé privée (ou un secret) soit
 * committé par accident.
 *
 * Usage :
 *   node scripts/check-secrets.mjs <fichier> [fichier…]
 *   git diff --cached --name-only --diff-filter=ACM | node scripts/check-secrets.mjs
 *
 * Sortie : code 0 si aucun secret trouvé, code 1 sinon (le commit est avorté).
 */
import fs from "node:fs";

/** Motifs interdits : nom de la variable + valeur d'au moins N caractères. */
const PATTERNS = [
  {
    name: "clé privée Solana (base58)",
    regex: /BS58_PRIVATE_KEY\s*[=:]\s*["']?[1-9A-HJ-NP-Za-km-z]{86,90}/,
  },
  {
    name: "clé Jupiter",
    regex: /JUPITER_API_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{32,}/,
  },
  {
    name: "clé GeckoTerminal",
    regex: /GECKO_API_KEY\s*[=:]\s*["']?CG-[A-Za-z0-9_-]{16,}/,
  },
  {
    name: "jeton Telegram",
    regex: /TELEGRAM_BOT_TOKEN\s*[=:]\s*["']?\d{6,}:[A-Za-z0-9_-]{30,}/,
  },
  {
    name: "tableau de 64 octets (clé ed25519 brute)",
    regex: /\[\s*\d{1,3}\s*(,\s*\d{1,3}\s*){63}\]/,
  },
];

/** Fichiers jamais scannés (typiquement déjà ignorés par `.gitignore`). */
const EXCLUDED = new Set([".env", ".env.example", ".env.local"]);

export function findSecrets(content) {
  const found = [];
  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(content);
    if (match) {
      found.push({
        name: pattern.name,
        // On n'affiche jamais le secret lui-même, seulement un extrait masqué.
        excerpt: `${match[0].slice(0, 12)}…${match[0].slice(-4)}`,
      });
    }
  }
  return found;
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage : node scripts/check-secrets.mjs <fichier>…");
    process.exit(2);
  }

  let violations = 0;
  for (const file of files) {
    if (EXCLUDED.has(file)) continue;
    if (!fs.existsSync(file)) continue;

    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const secret of findSecrets(content)) {
      violations += 1;
      console.error(`  ✘ ${file} : ${secret.name} détecté (${secret.excerpt})`);
    }
  }

  if (violations > 0) {
    console.error("");
    console.error("  Commit avorté : un secret semble avoir été ajouté.");
    console.error("  Retirez le secret du fichier et utilisez .env (ignoré par Git).");
    process.exit(1);
  }

  process.exit(0);
}

// Le module est aussi importable par les tests : on n'exécute `main` que
// lorsqu'il est invoqué directement.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
