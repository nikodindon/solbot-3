import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

/**
 * Keystore chiffré (argon2id si disponible, scrypt en repli).
 *
 * La clé privée n'est **jamais** en clair sur le disque : elle est chiffrée
 * avec une clé dérivée du mot de passe, et le keystore ne contient que du
 * sel, des paramètres de dérivation et le chiffre.
 *
 * ⚠ Le chiffrement protège le secret **au repos**. Il ne protège pas contre
 * un attaquant qui a accès au processus en cours d'exécution : pour cela, il
 * faudrait un service de signature distant (phase 7, hors périmètre ici).
 */

/** Paramètres de dérivation de clé. */
export interface KdfParams {
  /** Algorithme : `scrypt` est le seul disponible nativement dans Node. */
  algorithm: "scrypt";
  /** Coût mémoire (N). */
  N: number;
  /** Facteur de coût CPU (r). */
  r: number;
  /** Facteur de parallélisme (p). */
  p: number;
  /** Longueur de la clé dérivée, en octets. */
  keyLength: number;
  /** Longueur du sel, en octets. */
  saltLength: number;
}

export const DEFAULT_KDF: KdfParams = {
  algorithm: "scrypt",
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 32,
};

/** Un keystore chiffré, prêt à être écrit sur le disque. */
export interface EncryptedKeystore {
  version: 1;
  kdf: KdfParams;
  /** Sel, en base64. */
  salt: string;
  /** Nonce/chiffrement, en base64. */
  nonce: string;
  /** Texte chiffré, en base64. */
  ciphertext: string;
  /**empreinte du secret clair, pour vérifier le déchiffrement. */
  checksum: string;
}

/** Dérive la clé de chiffrement à partir du mot de passe. */
export function deriveKey(
  password: string,
  salt: Buffer,
  params: KdfParams = DEFAULT_KDF,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      params.keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

/** Chiffre un secret (la clé privée en base58). */
export async function encryptSecret(
  secret: string,
  password: string,
  params: KdfParams = DEFAULT_KDF,
): Promise<EncryptedKeystore> {
  const salt = randomBytes(params.saltLength);
  const key = await deriveKey(password, salt, params);
  const nonce = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    kdf: params,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([encrypted, authTag]).toString("base64"),
    checksum: checksumOf(secret),
  };
}

/** Déchiffre un secret. Lève si le mot de passe est faux. */
export async function decryptSecret(
  keystore: EncryptedKeystore,
  password: string,
): Promise<string> {
  const salt = Buffer.from(keystore.salt, "base64");
  const nonce = Buffer.from(keystore.nonce, "base64");
  const key = await deriveKey(password, salt, keystore.kdf);
  const payload = Buffer.from(keystore.ciphertext, "base64");
  // Les 16 derniers octets sont le tag d'authentification GCM.
  const authTag = payload.subarray(payload.length - 16);
  const encrypted = payload.subarray(0, payload.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);

  let secret: string;
  try {
    secret = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("mot de passe incorrect (le déchiffrement a échoué)");
  }

  if (checksumOf(secret) !== keystore.checksum) {
    throw new Error("empreinte du secret incohérente : le keystore est corrompu");
  }
  return secret;
}

/** Empreinte du secret : permet de vérifier sans déchiffrer. */
function checksumOf(secret: string): string {
  const digest = createHash("sha256").update(secret).digest("base64");
  return digest.slice(0, 16);
}

/** Comparaison à temps constant (pour les jetons). */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
