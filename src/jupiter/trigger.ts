import { z } from "zod";
import type { JupiterClient } from "./client.js";

/**
 * Trigger API V2 — ordres limites et DCA on-chain.
 *
 * Un take-profit déposé on-chain **survit à l'arrêt du bot** : c'est le
 * seul filet qui fonctionne quand le processus ne tourne plus. C'est
 * précisément ce que le README appelle d'ordre de protection.
 *
 * ⚠ Un stop-loss on-chain est plus délicat : il peut se déclencher sur une
 * mèche de prix. Son usage est donc **désactivé par défaut** et doit faire
 * l'objet d'un backtest dédié.
 */

export const triggerOrderSchema = z.looseObject({
  orderId: z.string().optional(),
  publicKey: z.string().optional(),
  status: z.string().optional(),
  inputMint: z.string().optional(),
  outputMint: z.string().optional(),
  inAmount: z.string().optional(),
  outAmount: z.string().optional(),
  /** Prix limite, en UI units du token d'entrée. */
  price: z.string().optional(),
  errorCode: z.number().optional(),
  errorMessage: z.string().optional(),
});

export type TriggerOrder = z.infer<typeof triggerOrderSchema>;

/** L'API Trigger renvoie ses erreurs sous forme de **liste d'issues** (Zod). */
const apiErrorSchema = z.looseObject({
  success: z.boolean().optional(),
  error: z
    .union([
      z.string(),
      z.looseObject({
        issues: z.array(z.looseObject({ message: z.string().optional() })).optional(),
      }),
    ])
    .optional(),
});

const createOrderSchema = apiErrorSchema.extend({
  requestId: z.string().optional(),
  order: triggerOrderSchema.optional(),
});

const listOrdersSchema = apiErrorSchema.extend({
  orders: z.array(triggerOrderSchema).optional(),
  total: z.number().optional(),
});

/** Extrait un message d'erreur lisible de la réponse de l'API. */
function errorMessage(response: { error?: unknown }): string | null {
  if (response.error === undefined) return null;
  if (typeof response.error === "string") return response.error;
  const issues = (response.error as { issues?: { message?: string }[] }).issues ?? [];
  if (issues.length === 0) return "erreur inconnue";
  return issues.map((issue) => issue.message ?? "?").join(" ; ");
}

export interface CreateTriggerOrderRequest {
  inputMint: string;
  outputMint: string;
  /** Montant en unités de base du token d'entrée. */
  inAmount: string;
  /** Prix limite, en UI units. */
  price: number;
  /** Expiration de l'ordre, en secondes. */
  expiry?: number;
}

export class TriggerApi {
  constructor(private readonly client: JupiterClient) {}

  /**
   * Crée un ordre limite de vente.
   *
   * L'ordre est déposé **par Jupiter sur la chaîne** : il s'exécutera même
   * si le bot est arrêté.
   */
  async createLimitOrder(request: CreateTriggerOrderRequest): Promise<TriggerOrder> {
    const response = await this.client.post(
      "/trigger/v1/createOrder",
      {
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        inAmount: request.inAmount,
        price: request.price.toString(),
        expiry: request.expiry,
      },
      (raw) => createOrderSchema.parse(raw),
      { timeoutMs: 30_000 },
    );

    const failure = errorMessage(response);
    if (failure) {
      throw new Error(`Trigger API : ${failure}`);
    }
    return response.order ?? {};
  }

  /**
   * Ordres du taker.
   *
   * `orderStatus` est **obligatoire** côté API : `active` pour les ordres
   * ouverts, `history` pour les ordres passés.
   */
  async listOrders(status: "active" | "history" = "active"): Promise<TriggerOrder[]> {
    const response = await this.client.get(
      "/trigger/v1/getTriggerOrders",
      { orderStatus: status },
      (raw) => listOrdersSchema.parse(raw),
      { timeoutMs: 30_000 },
    );
    const failure = errorMessage(response);
    if (failure) {
      throw new Error(`Trigger API : ${failure}`);
    }
    return response.orders ?? [];
  }

  /** Annule un ordre. */
  async cancelOrder(orderId: string): Promise<boolean> {
    const response = await this.client.post(
      "/trigger/v1/cancelOrder",
      { orderId },
      (raw) => createOrderSchema.parse(raw),
      { timeoutMs: 30_000 },
    );
    return errorMessage(response) === null;
  }
}
