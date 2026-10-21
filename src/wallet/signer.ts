import { Keypair } from "@solana/web3.js";
import type { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { WalletError } from "../utils/errors.js";

/**
 * Abstraction de signature.
 *
 * Le moteur ne connaît jamais la forme de la clé : il ne voit qu'une adresse
 * et une méthode de signature. C'est ce qui permettra, en phase 7, de brancher
 * un keystore chiffré ou un service de signature distant sans toucher au reste
 * du code.
 */
export interface Signer {
  readonly address: string;
  readonly publicKey: PublicKey;
  /** Signe une transaction versionnée en place et la retourne. */
  signVersionedTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
}

/** Clé privée base58 → 64 octets (seed 32 + pubkey 32), format compatible Phantom. */
export function decodeSecretKey(secretKeyBase58: string): Uint8Array {
  const trimmed = secretKeyBase58.trim();
  if (trimmed === "") {
    throw new WalletError("BS58_PRIVATE_KEY est vide", {
      hint: "lancez `npm run solbot3 -- init` pour générer un wallet",
    });
  }
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(trimmed);
  } catch {
    throw new WalletError("BS58_PRIVATE_KEY n'est pas du base58 valide");
  }
  if (bytes.length !== 64) {
    throw new WalletError(`BS58_PRIVATE_KEY doit faire 64 octets (reçu ${bytes.length})`, {
      hint: "la clé attendue est le format Solana 64 octets encodé en base58",
    });
  }
  return bytes;
}

export function encodeSecretKey(secretKey: Uint8Array): string {
  return bs58.encode(secretKey);
}

/**
 * Signer adossé à une clé privée en base58 (issue de `.env`).
 *
 * La clé ne quitte jamais le processus : elle n'est jamais journalisée et ne
 * transite par aucun logger.
 */
export class EnvSigner implements Signer {
  private constructor(
    private readonly keypair: Keypair,
    readonly publicKey: PublicKey,
  ) {}

  static async fromSecretKeyBase58(secretKeyBase58: string): Promise<EnvSigner> {
    const bytes = decodeSecretKey(secretKeyBase58);
    const keypair = await Keypair.fromSecretKey(bytes);
    return new EnvSigner(keypair, keypair.publicKey);
  }

  static async fromEnv(env: NodeJS.ProcessEnv = process.env): Promise<EnvSigner> {
    const secret = env.BS58_PRIVATE_KEY;
    if (!secret || secret.trim() === "") {
      throw new WalletError("BS58_PRIVATE_KEY absent de l'environnement", {
        hint: "lancez `npm run solbot3 -- init` pour générer un wallet, ou Funding",
      });
    }
    return EnvSigner.fromSecretKeyBase58(secret);
  }

  get address(): string {
    return this.publicKey.toBase58();
  }

  async signVersionedTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction> {
    await transaction.sign([this.keypair]);
    return transaction;
  }
}
