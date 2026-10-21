/**
 * Constantes partagées du projet.
 *
 * Les mints et les barèmes de frais sont regroupés ici pour éviter les
 * divergences entre le moteur, le modèle de coûts et l'interface.
 */

/** Mint du SOL natif (wrapped SOL). */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** USDC (Circle) sur mainnet-beta. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Mints des stablecoins principaux (USDC, USDT) — utilisés pour le barème de frais. */
export const STABLE_MINTS: ReadonlySet<string> = new Set([
  USDC_MINT,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

/** Base des API Jupiter. */
export const JUPITER_API_BASE = "https://api.jup.ag";

/** RPC public mainnet-beta (suffisant pour les tests, discouraged en live). */
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

/** `node:sqlite` exige Node >= 22.5. */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 5;

/** Frais de base d'une transaction Solana (lamports). */
export const BASE_FEE_LAMPORTS = 5_000;

/** Loyer minimal d'un compte token associated (ATA), en SOL. */
export const ATA_RENT_SOL = 0.0020412;

/**
 * Barème de frais de plateforme Jupiter (bps) par paire.
 *
 * 0 bps : stable ↔ stable
 * 2 bps : SOL ↔ stable
 * 5 bps : LST ↔ stable
 * 10 bps : toute autre paire
 *
 * Les tokens de moins de 24 h sont facturés 50 bps — ils sont exclus de
 * l'univers par défaut (`universe.min_age_hours`).
 */
export function jupiterPairFeeBps(inputMint: string, outputMint: string): number {
  if (STABLE_MINTS.has(inputMint) && STABLE_MINTS.has(outputMint)) return 0;
  if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
    const other = inputMint === SOL_MINT ? outputMint : inputMint;
    if (STABLE_MINTS.has(other)) return 2;
  }
  return 10;
}
