import { z } from "zod";
import type { JupiterClient } from "./client.js";

/**
 * Swap API V2 — `/swap/v2/build` (chemin Router).
 *
 * Le chemin Router renvoie des **instructions brutes** : l'assemblage de la
 * transaction est à notre charge (voir `src/execution/router.ts`).
 */

const accountMetaSchema = z.object({
  pubkey: z.string(),
  isWritable: z.boolean(),
  isSigner: z.boolean(),
});

/** Instruction brute (base64) renvoyée par `/build`. */
export const apiInstructionSchema = z.object({
  programId: z.string(),
  accounts: z.array(accountMetaSchema),
  data: z.string(),
});

export type ApiInstruction = z.infer<typeof apiInstructionSchema>;

/** `swapInstruction` porte `{ error }` quand aucune route exploitable n'existe. */
export type BuildSwapInstruction = ApiInstruction | { error: string };

const blockhashWithMetadataSchema = z.object({
  blockhash: z.array(z.number().int().min(0).max(255)),
  lastValidBlockHeight: z.number(),
  fetchedAt: z.object({ secs_since_epoch: z.number(), nanos_since_epoch: z.number() }).optional(),
});

export const buildResponseSchema = z.object({
  computeBudgetInstructions: z.array(apiInstructionSchema),
  setupInstructions: z.array(apiInstructionSchema),
  swapInstruction: z.union([apiInstructionSchema, z.object({ error: z.string() })]),
  cleanupInstruction: apiInstructionSchema.nullish(),
  otherInstructions: z.array(apiInstructionSchema),
  tipInstruction: apiInstructionSchema.nullish(),
  blockhashWithMetadata: blockhashWithMetadataSchema.optional(),
  addressesByLookupTableAddress: z.record(z.string(), z.array(z.string())).nullish(),
  forJitoBundle: z.boolean().optional(),
  tipAmount: z.number().optional(),
});

export type BuildResponse = z.infer<typeof buildResponseSchema>;

export interface BuildRequest {
  inputMint: string;
  outputMint: string;
  /** Montant en unités de base. */
  amount: string;
  taker: string;
  /** Borne de slippage en bps. */
  slippageBps?: number;
  /** Force la route on-chain (pas de RFQ). */
  onlyDirectRoutes?: boolean;
  /** Marge de prix maximale acceptée, en bps. */
  maxAccounts?: number;
  /** Mode rapide : latence réduite, routage légèrement moins optimal. */
  fastMode?: boolean;
}

export class BuildApi {
  constructor(private readonly client: JupiterClient) {}

  async build(request: BuildRequest): Promise<BuildResponse> {
    return this.client.get(
      "/swap/v2/build",
      {
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amount: request.amount,
        taker: request.taker,
        slippageBps: request.slippageBps,
        onlyDirectRoutes: request.onlyDirectRoutes ? "true" : undefined,
        maxAccounts: request.maxAccounts,
        fastMode: request.fastMode ? "true" : undefined,
      },
      (raw) => buildResponseSchema.parse(raw),
      { timeoutMs: 30_000 },
    );
  }
}
