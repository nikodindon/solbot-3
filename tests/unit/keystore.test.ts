import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  DEFAULT_KDF,
  deriveKey,
  encryptSecret,
  safeEqual,
} from "../../src/wallet/keystore.js";

const SECRET = "5K1sG3jYq2x8vN7mK4pQ9rT6wZ1bC3dE5fG7hJ9kL2mN4pQ";

describe("keystore chiffré", () => {
  it("chiffre puis déchiffre le secret", async () => {
    const keystore = await encryptSecret(SECRET, "mot de passe solide");
    expect(keystore.ciphertext).not.toContain(SECRET);
    expect(keystore.salt).toBeTruthy();

    const decrypted = await decryptSecret(keystore, "mot de passe solide");
    expect(decrypted).toBe(SECRET);
  });

  it("refuse un mauvais mot de passe", async () => {
    const keystore = await encryptSecret(SECRET, "bon mot de passe");
    await expect(decryptSecret(keystore, "mauvais mot de passe")).rejects.toThrow(
      /mot de passe incorrect/,
    );
  });

  it("n'écrit jamais le secret en clair", async () => {
    const keystore = await encryptSecret(SECRET, "mot de passe");
    const serialised = JSON.stringify(keystore);
    expect(serialised).not.toContain(SECRET);
  });

  it("produit une clé dérivée déterministe pour un même sel", async () => {
    const salt = Buffer.alloc(32, 7);
    const a = await deriveKey("mot de passe", salt, DEFAULT_KDF);
    const b = await deriveKey("mot de passe", salt, DEFAULT_KDF);
    expect(a.toString("base64")).toBe(b.toString("base64"));

    const c = await deriveKey("autre", salt, DEFAULT_KDF);
    expect(c.toString("base64")).not.toBe(a.toString("base64"));
  });

  it("compare des jetons à temps constant", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
