/**
 * Erreurs applicatives.
 *
 * Toute erreur exposée à l'utilisateur porte un `hint` actionnable : le CLI
 * l'affiche sous le message, ce qui évite les dead-ends sans documentation.
 */

export class SolbotError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, options?: { hint?: string; cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.hint !== undefined) this.hint = options.hint;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Configuration invalide — le démarrage doit échouer immédiatement. */
export class ConfigError extends SolbotError {}

/** Problème de wallet (clé absente, invalide, écriture impossible). */
export class WalletError extends SolbotError {}

/** RPC injoignable ou en erreur. */
export class RpcError extends SolbotError {}

/** Extrait un message lisible de n'importe quelle valeur levée. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
