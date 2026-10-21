import { z } from "zod";
import type { JupiterClient } from "./client.js";

/**
 * Swap API V2 — `/swap/v2/order` et `/swap/v2/execute`.
 *
 * Les schémas sont **tolérants** (`looseObject`) : l'API V2 est récente et
 * ses champs évoluent. Seuls les champs dont on a réellement besoin sont
 * validés.
 */

const routePlanStepSchema = z.looseObject({
  swapInfo: z
    .looseObject({
      ammKey: z.string().optional(),
      label: z.string().optional(),
      inputMint: z.string().optional(),
      outputMint: z.string().optional(),
      inAmount: z.string().optional(),
      outAmount: z.string().optional(),
    })
    .optional(),
  percent: z.number().optional(),
  bps: z.number().optional(),
  usdValue: z.number().optional(),
});

const platformFeeSchema = z.looseObject({
  amount: z.string().optional(),
  feeBps: z.number().optional(),
  feeMint: z.string().optional(),
});

export const orderResponseSchema = z.looseObject({
  mode: z.string().optional(),
  inputMint: z.string().optional(),
  outputMint: z.string().optional(),
  inAmount: z.string().optional(),
  outAmount: z.string().default("0"),
  inUsdValue: z.number().optional(),
  outUsdValue: z.number().optional(),
  /** Impact de prix, en points de pourcentage (ex. -0,1 = -0,1 %). */
  priceImpact: z.number().optional(),
  otherAmountThreshold: z.string().optional(),
  swapMode: z.string().optional(),
  slippageBps: z.number().optional(),
  routePlan: z.array(routePlanStepSchema).optional(),
  feeMint: z.string().optional(),
  feeBps: z.number().optional(),
  platformFee: platformFeeSchema.optional(),
  router: z.string().optional(),
  transactionVersion: z.union([z.number(), z.string()]).optional(),
  /** Base64 ; `null` si `taker` absent, `""` si la transaction n'a pas pu être construite. */
  transaction: z.string().nullable().optional(),
  lastValidBlockHeight: z.string().optional(),
  gasless: z.boolean().optional(),
  signatureFeePayer: z.string().nullable().optional(),
  requestId: z.string().optional(),
  taker: z.string().nullable().optional(),
  quoteId: z.string().optional(),
  maker: z.string().optional(),
  /** Expiration RFQ (JupiterZ). */
  expireAt: z.string().optional(),
  errorCode: z.number().optional(),
  errorMessage: z.string().optional(),
  error: z.string().optional(),
});

export type OrderResponse = z.infer<typeof orderResponseSchema>;

export const executeResponseSchema = z.looseObject({
  status: z.string(),
  signature: z.string().nullable().optional(),
  code: z.number(),
  totalInputAmount: z.string().nullable().optional(),
  totalOutputAmount: z.string().nullable().optional(),
  inputAmountResult: z.string().nullable().optional(),
  outputAmountResult: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export type ExecuteResponse = z.infer<typeof executeResponseSchema>;

/* ──────────────────────────────────────────────────────────────
 * Taxonomie des erreurs
 * ────────────────────────────────────────────────────────────── */

/** Stratégie de réaction après un échec d'exécution. */
export type ExecuteStrategy = "requote" | "abort";

export interface ExecuteErrorInfo {
  label: string;
  strategy: ExecuteStrategy;
  /** Ce qu'il faut faire pour changer d'issue. */
  hint?: string;
}

/**
 * Codes `/execute` — 0 = succès ; négatifs = erreurs (agrégateur puis RFQ).
 *
 * La distinction `requote` / `abort` est **la** décision importante : rejouer
 * un ordre qui n'a pas pu aboutir, c'est risquer une double exécution.
 */
export const EXECUTE_ERRORS: Readonly<Record<number, ExecuteErrorInfo>> = {
  [-1]: {
    label: "commande en cache introuvable (requestId inconnu ou expiré)",
    strategy: "requote",
  },
  [-2]: { label: "transaction signée invalide", strategy: "abort" },
  [-3]: { label: "octets de message invalides", strategy: "abort" },
  [-1000]: { label: "échec d'atterrissage (agrégateur)", strategy: "requote" },
  [-1001]: { label: "erreur inconnue (agrégateur)", strategy: "requote" },
  [-1002]: { label: "transaction invalide (agrégateur)", strategy: "abort" },
  [-1003]: { label: "transaction partiellement signée (agrégateur)", strategy: "abort" },
  [-1004]: { label: "block height invalide (agrégateur)", strategy: "requote" },
  [-1005]: {
    label: "transaction expirée avant atterrissage (blockhash périmé)",
    strategy: "requote",
    hint: "Signez et soumettez plus vite, ou relancez un ordre frais.",
  },
  [-2000]: { label: "échec d'atterrissage (RFQ)", strategy: "requote" },
  [-2001]: { label: "erreur inconnue (RFQ)", strategy: "requote" },
  [-2002]: { label: "payload invalide (RFQ)", strategy: "abort" },
  [-2003]: { label: "citation expirée (RFQ)", strategy: "requote" },
  [-2004]: {
    label: "swap rejeté par le market maker (RFQ)",
    strategy: "requote",
    hint: "Rejet last-look du MM — un ordre frais ou un autre routeur peut passer.",
  },
};

export function describeExecuteError(code: number): ExecuteErrorInfo {
  return EXECUTE_ERRORS[code] ?? { label: `code d'erreur inconnu (${code})`, strategy: "abort" };
}

/**
 * Codes `/order` quand `transaction` est vide. Le sens dépend du routeur :
 * sur le Meta-Aggregator, 1 = fonds insuffisants, 2 = compte de token
 * (ATA) manquant, 3 = montant sous le minimum gasless.
 */
export function describeOrderFailure(router: string | undefined, code: number | undefined): string {
  const isJupiterZ = router?.toLowerCase().includes("jupiterz");
  if (isJupiterZ) {
    switch (code) {
      case 1:
        return "fonds insuffisants (solde du taker)";
      case 2:
        return "compte de token associé (ATA) manquant ou provision insuffisante";
      case 3:
        return "montant sous le minimum « gasless »";
      default:
        return `échec de l'ordre (code ${code ?? "?"})`;
    }
  }
  switch (code) {
    case 1:
      return "solde insuffisant pour couvrir le montant et les frais";
    case 2:
      return "compte de token associé (ATA) manquant, ou provision SOL insuffisante";
    case 3:
      return "montant sous le minimum « gasless »";
    default:
      return `échec de l'ordre (code ${code ?? "?"})`;
  }
}

export interface OrderRequest {
  inputMint: string;
  outputMint: string;
  /** Montant en unités de base du token d'entrée. */
  amount: string;
  /** Adresse du taker (obligatoire pour obtenir une transaction signable). */
  taker?: string;
  /** Borne de slippage en bps. Absent = RTSE (automatique). */
  slippageBps?: number;
  maxSupportedTransactionVersion?: "0" | "1";
}

export class SwapApi {
  constructor(private readonly client: JupiterClient) {}

  /**
   * Meta-Aggregator : devis **et** transaction assemblée.
   *
   * C'est le chemin par défaut : la protection MEV et l'atterrissage sont
   * gérés par Jupiter, et aucun RPC n'est nécessaire pour l'exécution.
   */
  async order(request: OrderRequest): Promise<OrderResponse> {
    const params: Record<string, string | number | undefined> = {
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount,
      taker: request.taker,
      slippageBps: request.slippageBps,
      maxSupportedTransactionVersion: request.maxSupportedTransactionVersion,
    };

    return this.client.get("/swap/v2/order", params, (raw) => orderResponseSchema.parse(raw), {
      timeoutMs: 30_000,
    });
  }

  /**
   * Exécution de la transaction signée.
   *
   * `requestId` est **indispensable** : c'est lui qui relie l'exécution à la
   * commande déjà enregistrée par `/order`. Sans lui, Jupiter ne sait pas
   * quoi exécuter.
   */
  async execute(body: {
    signedTransaction: string;
    requestId: string;
    lastValidBlockHeight?: string;
  }): Promise<ExecuteResponse> {
    return this.client.post("/swap/v2/execute", body, (raw) => executeResponseSchema.parse(raw), {
      timeoutMs: 60_000,
    });
  }
}
