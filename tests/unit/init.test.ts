import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { WalletError } from "../../src/utils/errors.js";
import { decodeSecretKey, EnvSigner } from "../../src/wallet/signer.js";
import { makeTempRoot, removeTempRoot } from "../helpers.js";

describe("init", () => {
  it("crée un .env en chmod 600 contenant la clé en base58", async () => {
    const root = makeTempRoot();
    try {
      const result = await runInit({ root, quiet: true });
      const envPath = path.join(root, ".env");

      expect(result.created).toBe(true);
      expect(fs.existsSync(envPath)).toBe(true);
      expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);

      const content = fs.readFileSync(envPath, "utf8");
      const match = /^BS58_PRIVATE_KEY=(.+)$/m.exec(content);
      expect(match).not.toBeNull();
      expect(decodeSecretKey(match?.[1] ?? "")).toHaveLength(64);
    } finally {
      removeTempRoot(root);
    }
  });

  it("n'écrase jamais une clé existante sans --force", async () => {
    const root = makeTempRoot();
    try {
      const first = await runInit({ root, quiet: true });
      await expect(runInit({ root, quiet: true })).rejects.toThrow(WalletError);

      const content = fs.readFileSync(path.join(root, ".env"), "utf8");
      const match = /^BS58_PRIVATE_KEY=(.+)$/m.exec(content);
      expect(match?.[1]).toBeDefined();

      // La clé d'origine est intacte : on la reconstruit et on vérifie l'adresse.
      const signer = await EnvSigner.fromSecretKeyBase58(match?.[1] ?? "");
      expect(signer.address).toBe(first.address);
    } finally {
      removeTempRoot(root);
    }
  });

  it("--force remplace la clé", async () => {
    const root = makeTempRoot();
    try {
      const first = await runInit({ root, quiet: true });
      const second = await runInit({ root, force: true, quiet: true });

      expect(second.patched).toBe(true);
      expect(second.address).not.toBe(first.address);

      // Le .env contient la clé (jamais l'adresse) : on la relit pour vérifier.
      const content = fs.readFileSync(path.join(root, ".env"), "utf8");
      const match = /^BS58_PRIVATE_KEY=(.+)$/m.exec(content);
      const signer = await EnvSigner.fromSecretKeyBase58(match?.[1] ?? "");
      expect(signer.address).toBe(second.address);
    } finally {
      removeTempRoot(root);
    }
  });

  it("n'écrit jamais la clé ailleurs que dans .env", async () => {
    const root = makeTempRoot();
    try {
      await runInit({ root, quiet: true });
      const files = fs.readdirSync(root);
      expect(files).toEqual([".env"]);
    } finally {
      removeTempRoot(root);
    }
  });
});
