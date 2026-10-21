import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import type { Connection, TransactionInstruction } from "@solana/web3.js";
import { SolbotError } from "../utils/errors.js";

/**
 * Cibles d'atterrissage du chemin Router.
 *
 * Trois manières de.submit une transaction déjà signée :
 * - `rpc` : notre propre nœud (`sendRawTransaction`) ;
 * - `tx_jup` : l'infrastructure `tx.jup.ag` (JSON-RPC) ;
 * - `jito` : un bundle Jito, avec tip vers un compte Jito.
 *
 * La distinction qui compte : une **erreur d'envoi** (4xx, preflight) signifie
 * que la transaction **n'a jamais été soumise** — on peut réessayer sans
 * risque. Une erreur 5xx ou un timeout signifie qu'on **ne sait pas** : la
 * transaction a pu passer. Dans ce cas, on ne réessaie **jamais** à l'aveugle :
 * on vérifie la signature.
 */

export interface LandingContext {
  /** Transaction sérialisée, base64. */
  signedBase64: string;
  /** Adresse signataire (pour le tip Jito). */
  taker: PublicKey;
  /** Montant du tip, en lamports. */
  tipLamports: number;
}

export interface LandingSendResult {
  /** Signature de la transaction (si connue). */
  signature: string | null;
  /** L'envoi a-t-il été **refusé** (donc jamais soumis) ? */
  rejected: boolean;
  detail: string;
}

export interface LandingConfirmation {
  confirmed: boolean;
  /** L'issue est **incertaine** : vérifier la signature manuellement. */
  unknown: boolean;
  detail: string;
}

export interface LandingTarget {
  readonly name: string;
  /** Tip minimum, en lamports. */
  readonly tipLamports?: number;
  /** Prépare la cible (récupération des comptes de tip, etc.). */
  warmup?(): Promise<void>;
  /** Instructions supplémentaires à ajouter (virement de tip). */
  prepare?(request: { taker: PublicKey; lamports: number }): Promise<TransactionInstruction[]>;
  send(context: LandingContext): Promise<LandingSendResult>;
  confirm(signature: string, context: LandingContext): Promise<LandingConfirmation>;
}

/** Erreur d'envoi dont on sait que la transaction **n'a pas** été soumise. */
export class LandingSendError extends SolbotError {
  constructor(message: string) {
    super(message);
    this.name = "LandingSendError";
  }
}

/* ──────────────────────────────────────────────────────────────
 * RPC
 * ────────────────────────────────────────────────────────────── */

export class RpcLanding implements LandingTarget {
  readonly name = "rpc";

  constructor(private readonly connection: Connection) {}

  async send(context: LandingContext): Promise<LandingSendResult> {
    const buffer = Buffer.from(context.signedBase64, "base64");
    try {
      const signature = await this.connection.sendRawTransaction(buffer, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: BigInt(3),
      });
      return { signature, rejected: false, detail: `envoyée via RPC (${signature})` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Un refus de preflight ou une erreur 4xx signifie que la transaction
      // n'a jamais été soumise : on peut réessayer.
      if (/blockhash not found|BlockhashNotFound|preflight|429/i.test(message)) {
        throw new LandingSendError(`RPC a refusé la transaction : ${message}`);
      }
      return { signature: null, rejected: false, detail: `envoi RPC incertain : ${message}` };
    }
  }

  async confirm(signature: string): Promise<LandingConfirmation> {
    try {
      const result = await this.connection.confirmTransaction(
        {
          signature: signature,
          blockhash: undefined as never,
          lastValidBlockHeight: undefined as never,
        },
        "confirmed",
      );
      const error = result.value.err;
      return {
        confirmed: error === null,
        unknown: false,
        detail: error === null ? "confirmée" : `erreur on-chain : ${JSON.stringify(error)}`,
      };
    } catch (error) {
      return {
        confirmed: false,
        unknown: true,
        detail: `confirmation incertaine : ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/* ──────────────────────────────────────────────────────────────
 * tx.jup.ag
 * ────────────────────────────────────────────────────────────── */

/** Tip minimum exigé par tx.jup.ag. */
export const TX_JUP_MIN_TIP_LAMPORTS = 1_000_000;

export class JupiterTxLanding implements LandingTarget {
  readonly name = "tx_jup";
  readonly tipLamports = TX_JUP_MIN_TIP_LAMPORTS;

  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://tx.jup.ag/api/v1/transaction",
  ) {}

  async send(context: LandingContext): Promise<LandingSendResult> {
    if (!this.apiKey) {
      throw new LandingSendError("tx.jup.ag exige une clé API Jupiter");
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        transaction: context.signedBase64,
        skipPreflight: false,
        maxRetries: BigInt(3),
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      // 4xx : refus explicite, la transaction n'a pas été soumise.
      throw new LandingSendError(`tx.jup.ag a refusé (${response.status}) : ${text.slice(0, 200)}`);
    }

    let signature: string | null = null;
    try {
      signature = (JSON.parse(text) as { signature?: string }).signature ?? null;
    } catch {
      // réponse illisible : la signature sera vérifiée par le RPC
    }
    return {
      signature,
      rejected: false,
      detail: `envoyée via tx.jup.ag${signature ? ` (${signature})` : ""}`,
    };
  }

  confirm(signature: string): Promise<LandingConfirmation> {
    // La confirmation se fait par le RPC : tx.jup.ag n'expose pas de
    // confirmation d'atterrissage.
    return Promise.resolve({
      confirmed: false,
      unknown: true,
      detail: `vérification manuelle requise (${signature})`,
    });
  }
}

/* ──────────────────────────────────────────────────────────────
 * Jito
 * ────────────────────────────────────────────────────────────── */

/** URL du Block Engine Jito par région. */
export const JITO_REGIONS = {
  global: "https://mainnet.block-engine.jito.wtf",
  amsterdam: "https://amsterdam.mainnet.block-engine.jito.wtf",
  frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf",
  london: "https://london.mainnet.block-engine.jito.wtf",
  ny: "https://ny.mainnet.block-engine.jito.wtf",
  slc: "https://slc.mainnet.block-engine.jito.wtf",
  singapore: "https://singapore.mainnet.block-engine.jito.wtf",
  tokyo: "https://tokyo.mainnet.block-engine.jito.wtf",
} as const;

export type JitoRegion = keyof typeof JITO_REGIONS;

/** Tip minimum recommandé par Jito. */
export const JITO_MIN_TIP_LAMPORTS = 1_000_000;

export class JitoLanding implements LandingTarget {
  readonly name = "jito";
  readonly tipLamports = JITO_MIN_TIP_LAMPORTS;

  /** Comptes de tip Jito — récupérés dynamiquement, jamais codés en dur. */
  private tipAccounts: PublicKey[] | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly region: JitoRegion = "global",
  ) {
    void this.connection;
  }

  /**
   * Prépare la cible : récupération des comptes de tip.
   *
   * L'appel est mémorisé : `warmup` et `prepare` partagent le même aller-
   *retour réseau.
   */
  async warmup(): Promise<void> {
    await this.tipAccounts_();
  }

  /**
   * Construit le virement de tip vers un compte Jito.
   *
   * Les comptes de tip sont **récupérés dynamiquement** : ils changent, et
   * un compte codé en dur enverrait le tip dans le vide.
   */
  async prepare(request: {
    taker: PublicKey;
    lamports: number;
  }): Promise<TransactionInstruction[]> {
    const accounts = await this.tipAccounts_();
    if (accounts.length === 0) return [];
    const tipAccount = accounts[0];
    if (!tipAccount) return [];

    return [
      SystemProgram.transfer({
        fromPubkey: request.taker,
        toPubkey: tipAccount,
        lamports: request.lamports,
      }),
    ];
  }

  async send(context: LandingContext): Promise<LandingSendResult> {
    const response = await fetch(`${JITO_REGIONS[this.region]}/api/v1/bundles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [[context.signedBase64]],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new LandingSendError(`Jito a refusé (${response.status}) : ${text.slice(0, 200)}`);
    }

    let bundleId: string | null = null;
    try {
      const parsed = JSON.parse(text) as { result?: string; error?: unknown };
      bundleId = parsed.result ?? null;
    } catch {
      // réponse illisible : le bundle est considéré comme refusé
    }
    if (!bundleId) {
      // Le bundle n'a pas été accepté : rien n'a été soumis.
      throw new LandingSendError(`Jito n'a pas accepté le bundle : ${text.slice(0, 200)}`);
    }

    return { signature: null, rejected: false, detail: `bundle ${bundleId} soumis` };
  }

  confirm(): Promise<LandingConfirmation> {
    // Un bundle Jito n'a pas de signature propre : la transaction à
    // l'intérieur est confirmée par le RPC.
    return Promise.resolve({
      confirmed: false,
      unknown: true,
      detail: "confirmation via RPC nécessaire (bundle Jito)",
    });
  }

  /** Comptes de tip Jito, récupérés une fois et mémorisés. */
  private async tipAccounts_(): Promise<PublicKey[]> {
    if (this.tipAccounts !== null) return this.tipAccounts;

    const response = await fetch(`${JITO_REGIONS[this.region]}/api/v1/tip_accounts`);
    const text = await response.text();
    if (!response.ok) {
      this.tipAccounts = [];
      return this.tipAccounts;
    }
    try {
      const accounts = JSON.parse(text) as string[];
      this.tipAccounts = accounts.map((address) => new PublicKey(address));
    } catch {
      this.tipAccounts = [];
    }
    return this.tipAccounts;
  }
}

/** Fabrique la cible d'atterrissage demandée. */
export function createLandingTarget(options: {
  choice: "rpc" | "tx_jup" | "jito";
  connection: Connection;
  apiKey: string;
  jitoRegion?: JitoRegion;
}): LandingTarget {
  switch (options.choice) {
    case "tx_jup":
      return new JupiterTxLanding(options.apiKey);
    case "jito":
      return new JitoLanding(options.connection, options.jitoRegion ?? "global");
    case "rpc":
    default:
      return new RpcLanding(options.connection);
  }
}

/** Convertit des lamports en SOL (pour l'affichage). */
export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}
