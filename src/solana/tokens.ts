/**
 * Lecture typée d'un compte de token renvoyé par le RPC.
 *
 * Le RPC renvoie un `ParsedAccountData` dont le champ `info` n'est pas typé
 * par le SDK : on le cadre ici une fois pour toute la base de code.
 */
export interface ParsedTokenInfo {
  mint?: string;
  owner?: string;
  tokenAmount?: { amount?: string; decimals?: number; uiAmount?: number };
}

export interface ParsedTokenAccount {
  data: { parsed?: unknown };
}

/** Informations d'un compte de token, typées. */
export function tokenInfoOf(account: ParsedTokenAccount): ParsedTokenInfo {
  const parsed = account.data.parsed as { info?: ParsedTokenInfo } | undefined;
  return parsed?.info ?? {};
}

/** Quantité d'un compte de token, en unités de base. */
export function tokenAmountOf(account: ParsedTokenAccount): number {
  const amount = Number(tokenInfoOf(account).tokenAmount?.amount ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

/** Décimales d'un compte de token. */
export function tokenDecimalsOf(account: ParsedTokenAccount): number {
  const decimals = tokenInfoOf(account).tokenAmount?.decimals;
  return typeof decimals === "number" ? decimals : 6;
}
