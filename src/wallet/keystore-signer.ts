import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import type { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { WalletError } from "../utils/errors.js";
import { decryptSecret, encryptSecret, type EncryptedKeystore } from "./keystore.js";
import { encodeSecretKey } from "./signer.js";

/**
 * Signer adossé à un **keystore chiffré**.
 *
 * La clé n'est jamais en clair sur le disque : elle est chiffrée avec une
 * clé dérivée du mot de passe. Le keystore ne contient que du sel, des
 * paramètres de dérivation et du chiffre.
 *
 * ⚠ Le chiffrement protège le secret **au repos**. Il ne protège pas contre
 * un attaquant qui accède au processus en cours d'exécution.
 */

export interface KeystoreSignerOptions {
  /** Chemin du fichier keystore. */
  path: string;
  /** Mot de passe de déverrouillage. */
  password: string;
}

export class KeystoreSigner {
  private keypair: Keypair | undefined;

  constructor(private readonly options: KeystoreSignerOptions) {}

  /** Le keystore existe-t-il ? */
  static exists(file: string): boolean {
    return fs.existsSync(file);
  }

  /** Crée (ou réécrit) un keystore à partir d'une clé en clair. */
  static async create(file: string, secretKeyBase58: string, password: string): Promise<void> {
    const keystore = await encryptSecret(secretKeyBase58, password);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keystore, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  /** Charge et déchiffre le keystore. */
  async load(): Promise<Keypair> {
    if (this.keypair) return this.keypair;

    if (!fs.existsSync(this.options.path)) {
      throw new WalletError(`keystore introuvable : ${this.options.path}`, {
        hint: "générez-le avec `solbot3 init --keystore`",
      });
    }

    let keystore: EncryptedKeystore;
    try {
      keystore = JSON.parse(fs.readFileSync(this.options.path, "utf8")) as EncryptedKeystore;
    } catch (error) {
      throw new WalletError(
        `keystore illisible : ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const secret = await decryptSecret(keystore, this.options.password);
    const bytes = bs58.decode(secret);
    if (bytes.length !== 64) {
      throw new WalletError("le keystore contient une clé de longueur invalide");
    }

    this.keypair = await Keypair.fromSecretKey(bytes);
    return this.keypair;
  }

  get address(): string {
    if (!this.keypair) {
      throw new WalletError("keystore non chargé : appelez load() d'abord");
    }
    return this.keypair.publicKey.toBase58();
  }

  get publicKey(): PublicKey {
    if (!this.keypair) {
      throw new WalletError("keystore non chargé : appelez load() d'abord");
    }
    return this.keypair.publicKey;
  }

  async signVersionedTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction> {
    const keypair = await this.load();
    await transaction.sign([keypair]);
    return transaction;
  }

  /** La clé en clair, pour l'export. À utiliser avec précaution. */
  async exportSecret(): Promise<string> {
    const keypair = await this.load();
    return encodeSecretKey(keypair.secretKey);
  }
}
