import { Keypair } from "@solana/web3.js";
import { WalletError } from "../utils/errors.js";
import { encodeSecretKey } from "./signer.js";

export interface CreatedWallet {
  /** Adresse publique du wallet (base58). */
  address: string;
  /** Clé privée 64 octets en base58 — format compatible Phantom. */
  secretKeyBase58: string;
}

/**
 * Génère un keypair ed25519.
 *
 * La clé privée n'est jamais journalisée : elle est retournée à l'appelant
 * qui l'écrit directement dans `.env` (chmod 600).
 */
export async function generateWallet(): Promise<CreatedWallet> {
  const keypair = await Keypair.generate();
  const secretKey = keypair.secretKey;
  if (!secretKey || secretKey.length !== 64) {
    throw new WalletError("génération du keypair invalide (secretKey de longueur inattendue)");
  }
  return {
    address: keypair.publicKey.toBase58(),
    secretKeyBase58: encodeSecretKey(secretKey),
  };
}
