import { SOL_MINT } from "../constants.js";
import type { TokenInfo } from "../jupiter/tokens.js";
import { blank, heading, info, note, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface PriceOptions {
  root?: string;
}

/** Mints connus sans appel API (raccourcis). */
const KNOWN_MINTS: Record<string, string> = {
  SOL: SOL_MINT,
  WSOL: SOL_MINT,
};

/**
 * Prix en direct d'une paire, via Price v3.
 *
 * Les entrées peuvent être un symbole (`SOL`), un mint, ou un couple où
 * l'entrée est la devise de référence : `SOL USDC` = prix de SOL en USDC.
 */
export async function runPrice(
  input: string,
  output: string,
  options: PriceOptions = {},
): Promise<void> {
  const runtime = createRuntime({ root: options.root });
  try {
    const inputMint = await resolveMint(runtime, input);
    const outputMint = await resolveMint(runtime, output);

    if (!inputMint || !outputMint) {
      warn("paire introuvable", `${input} / ${output}`);
      return;
    }

    const prices = await runtime.priceApi.refresh([inputMint, outputMint], { fresh: true });
    const row = prices.get(inputMint);
    const inverse = prices.get(outputMint);

    heading(`solbot3 price — ${input} → ${output}`);

    if (!row) {
      warn("aucun prix renvoyé pour l'entrée", inputMint);
      return;
    }

    ok(`${priceLabel(input, output)}`, `${row.usdPrice} $`);
    info(
      "liquidité",
      row.liquidity !== undefined
        ? `${Math.round(row.liquidity).toLocaleString("fr-FR")} $`
        : "n/d",
    );
    if (row.priceChange24h !== undefined) {
      info(
        "variation 24 h",
        `${row.priceChange24h >= 0 ? "+" : ""}${row.priceChange24h.toFixed(2)} %`,
      );
    }
    info("mint", inputMint);
    if (inverse?.usdPrice !== undefined) {
      info("inverse", `1 ${output} = ${inverse.usdPrice} $`);
    }
    blank();
    note(`base : ${SOL_MINT === inputMint ? "SOL" : inputMint}`);
    blank();
  } finally {
    closeRuntime(runtime);
  }
}

function priceLabel(input: string, output: string): string {
  return `1 ${input} en ${output}`;
}

/** Résout un symbole ou un mint en adresse. */
async function resolveMint(
  runtime: ReturnType<typeof createRuntime>,
  query: string,
): Promise<string | null> {
  const trimmed = query.trim();
  if (trimmed === "") return null;

  const known = KNOWN_MINTS[trimmed.toUpperCase()];
  if (known) return known;

  // Un mint est directement utilisable.
  if (trimmed.length >= 32 && trimmed.length <= 64) {
    try {
      const tokens = await runtime.tokensApi.searchMints([trimmed]);
      if (tokens.has(trimmed)) return trimmed;
    } catch {
      // on tente la recherche par symbole ci-dessous
    }
  }

  try {
    const found = await runtime.tokensApi.search(trimmed);
    const exact = pickExact(found, trimmed);
    return exact ? exact.mint : (found[0]?.mint ?? null);
  } catch {
    return null;
  }
}

/** Préfère le symbole exactement identique (évite « SOL » → « Wrapped SOL » vs « Solend »). */
function pickExact(tokens: TokenInfo[], query: string): TokenInfo | undefined {
  const upper = query.toUpperCase();
  return tokens.find((token) => token.symbol.toUpperCase() === upper);
}
