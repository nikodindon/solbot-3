import { describe, expect, it } from "vitest";
import { WalletError } from "../../src/utils/errors.js";
import { generateWallet } from "../../src/wallet/create.js";
import { decodeSecretKey, encodeSecretKey, EnvSigner } from "../../src/wallet/signer.js";

describe("wallet", () => {
  it("génère un keypair ed25519 de 64 octets", async () => {
    const wallet = await generateWallet();
    expect(wallet.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const decoded = decodeSecretKey(wallet.secretKeyBase58);
    expect(decoded).toHaveLength(64);
  });

  it("round-trip base58 sur la clé privée", async () => {
    const wallet = await generateWallet();
    const bytes = decodeSecretKey(wallet.secretKeyBase58);
    expect(encodeSecretKey(bytes)).toBe(wallet.secretKeyBase58);
  });

  it("refuse une clé vide", () => {
    expect(() => decodeSecretKey("   ")).toThrow(WalletError);
  });

  it("refuse une clé de mauvaise longueur", () => {
    expect(() => decodeSecretKey(encodeSecretKey(new Uint8Array(32)))).toThrow(/64 octets/);
  });

  it("refuse une clé qui n'est pas du base58", () => {
    expect(() => decodeSecretKey("0OIl")).toThrow(WalletError);
  });

  it("reconstruit la même adresse depuis la clé privée", async () => {
    const wallet = await generateWallet();
    const signer = await EnvSigner.fromSecretKeyBase58(wallet.secretKeyBase58);
    expect(signer.address).toBe(wallet.address);
  });

  it("échoue explicitement quand BS58_PRIVATE_KEY est absent", async () => {
    await expect(EnvSigner.fromEnv({})).rejects.toThrow(WalletError);
  });
});
