import { Connection, PublicKey } from "@solana/web3.js";
import { USDC_MINT } from "../constants.js";
import { SwapApi } from "../jupiter/swap.js";
import type { TokensApi } from "../jupiter/tokens.js";
import { evaluateGuard } from "../risk/guard.js";
import type { DB } from "../state/db.js";
import { listPositions } from "../state/portfolio-repo.js";
import { tokenAmountOf } from "../solana/tokens.js";
import { EnvSigner } from "../wallet/signer.js";
import { JupiterExecutor } from "../execution/jupiter-executor.js";
import { blank, fail, heading, info, note, ok } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

/**
 * `solbot3 swap` — swap manuel, avec les mêmes garde-fous que le bot.
 *
 * C'est la commande de **secours** : elle permet de sortir d'une position ou
 * d'entrer à la main quand le bot est bloqué. Elle n'est donc pas plus
 * permissive que le moteur — au contraire.
 */

export interface SwapOptions {
  root?: string;
  input: string;
  output: string;
  /** Montant en USDC, ou `max` pour tout le solde disponible. */
  amount: string;
  /** Mode forcé. */
  mode?: "dry_run" | "live";
  /** Valide la confirmation interactive (automatisation). */
  yes?: boolean;
}

/** Résout un symbole ou un mint en adresse. */
async function resolveMint(tokens: TokensApi, query: string): Promise<string | null> {
  const trimmed = query.trim();
  if (trimmed === "") return null;
  if (trimmed === "SOL") return "So11111111111111111111111111111111111111112";
  if (trimmed === "USDC") return USDC_MINT;

  try {
    const found = await tokens.search(trimmed);
    const exact = found.find((token) => token.symbol.toUpperCase() === trimmed.toUpperCase());
    return (exact ?? found[0])?.mint ?? null;
  } catch {
    return null;
  }
}

export async function runSwap(options: SwapOptions): Promise<void> {
  const runtime = createRuntime({ root: options.root });
  try {
    const cfg = runtime.config;
    const env = process.env;
    const mode = options.mode ?? (cfg.mode === "live" ? "live" : "dry_run");

    heading(`solbot3 swap — ${options.input} → ${options.output}`);

    // ── Garde-fou live ────────────────────────────────────────────────
    if (mode === "live") {
      if (!cfg.confirm_live) {
        fail("live refusé", "confirm_live n'est pas activé dans la configuration");
        process.exitCode = 1;
        return;
      }
      const guard = evaluateGuard({ db: runtime.db, cfg });
      if (!guard.ok) {
        fail("live refusé par le garde-fou", guard.reasons.join(" ; "));
        process.exitCode = 1;
        return;
      }
      ok("garde-fou", "tous les critères sont remplis");
    } else {
      info("mode", "dry-run (vrais devis, transaction simulée, aucun ordre envoyé)");
    }

    const inputMint = await resolveMint(runtime.tokensApi, options.input);
    const outputMint = await resolveMint(runtime.tokensApi, options.output);
    if (!inputMint || !outputMint) {
      fail("actif introuvable", `${options.input} / ${options.output}`);
      process.exitCode = 1;
      return;
    }
    info("actifs", `${inputMint.slice(0, 8)}… → ${outputMint.slice(0, 8)}…`);

    // ── Montant ───────────────────────────────────────────────────────
    const isSell = inputMint === USDC_MINT;
    let amountUsd: number;

    if (options.amount === "max") {
      if (!isSell) {
        fail("« max » n'est supporté que pour vendre (USDC en entrée)");
        process.exitCode = 1;
        return;
      }
      const prices = await runtime.priceApi.refresh([USDC_MINT], { fresh: true });
      const usdcPrice = prices.get(USDC_MINT)?.usdPrice ?? 1;
      const balance = await usdcBalance();
      // On garde la réserve de gaz : on ne vend pas le SOL des frais.
      amountUsd = Math.max(0, balance - 0.5);
      info("montant", `max (${amountUsd.toFixed(2)} $ sur ${(balance * usdcPrice).toFixed(2)} $)`);
    } else {
      amountUsd = Number(options.amount);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        fail("montant invalide", options.amount);
        process.exitCode = 1;
        return;
      }
      info("montant", `${amountUsd.toFixed(4)} $`);
    }

    // ── Exécution ─────────────────────────────────────────────────────
    const connection = new Connection(
      env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
    const signer = await EnvSigner.fromEnv(env);

    const executor = new JupiterExecutor({
      db: runtime.db,
      swapApi: new SwapApi(runtime.jupiter),
      connection,
      signer,
      mode,
      retries: cfg.execution.retries,
      slippageBumpFactor: 2,
      maxSlippageBps: cfg.risk.max_slippage_bps,
      slippageMode: cfg.execution.slippage,
      adaptive: {
        timeframe: "15m",
        period: 14,
        multiplier: 1,
        minBps: 10,
        maxBps: cfg.risk.max_slippage_bps,
      },
      confirm: async (summary) => {
        note(summary);
        if (options.yes === true) return true;
        const answer = await prompt("Confirmer ? (oui/non) : ");
        return answer.trim().toLowerCase() === "oui";
      },
    });

    const result = await executor.execute({
      mint: isSell ? outputMint : inputMint,
      symbol: options.output,
      side: isSell ? "sell" : "buy",
      strategy: "manual",
      priceUsd: 0,
      liquidityUsd: null,
      spendUsd: amountUsd,
      qty: isSell ? undefined : amountUsd,
      reason: "swap manuel",
      stopLossPct: cfg.risk.stop_loss_pct,
      takeProfitPct: cfg.risk.take_profit_pct,
      decimals: 6,
      needsAta: true,
    });

    blank();
    if (result.ok) {
      ok(
        mode === "live" ? "swap exécuté" : "swap simulé",
        result.signature ? `signature ${result.signature}` : (result.note ?? "ok"),
      );
    } else {
      fail("swap échoué", result.note ?? "raison inconnue");
      process.exitCode = 1;
    }
    blank();

    async function usdcBalance(): Promise<number> {
      const accounts = await connection.getParsedTokenAccountsByOwner(
        new PublicKey(signer.address),
        {
          mint: new PublicKey(USDC_MINT),
        },
      );
      let total = 0;
      for (const { account } of accounts.value) {
        total += tokenAmountOf(account);
      }
      return total / 1e6;
    }
  } finally {
    closeRuntime(runtime);
  }
}

/** Invite de confirmation en ligne de commande. */
async function prompt(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Positions ouvertes, pour le contexte d'un swap manuel. */
export function openPositions(db: DB): number {
  return listPositions(db).length;
}
