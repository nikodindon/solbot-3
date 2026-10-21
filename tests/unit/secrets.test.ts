import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempRoot, removeTempRoot } from "../helpers.js";

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/check-secrets.mjs");

function runCheck(file: string): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [SCRIPT, file], { stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stderr?: Buffer };
    return { status: err.status ?? 1, stderr: String(err.stderr ?? "") };
  }
}

describe("garde-fou de pré-commit", () => {
  it("refuse une clé privée Solana", () => {
    const root = makeTempRoot();
    try {
      const file = path.join(root, "leak.txt");
      const key = "5" + "1".repeat(86);
      fs.writeFileSync(file, `BS58_PRIVATE_KEY=${key}\n`, "utf8");

      const result = runCheck(file);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("clé privée");
    } finally {
      removeTempRoot(root);
    }
  });

  it("refuse une clé Jupiter", () => {
    const root = makeTempRoot();
    try {
      const file = path.join(root, "leak.txt");
      fs.writeFileSync(file, `JUPITER_API_KEY=${"a".repeat(40)}\n`, "utf8");
      expect(runCheck(file).status).toBe(1);
    } finally {
      removeTempRoot(root);
    }
  });

  it("laisse passer un fichier propre", () => {
    const root = makeTempRoot();
    try {
      const file = path.join(root, "clean.txt");
      fs.writeFileSync(file, "BS58_PRIVATE_KEY=\nJUPITER_API_KEY=\n", "utf8");
      expect(runCheck(file).status).toBe(0);
    } finally {
      removeTempRoot(root);
    }
  });

  it("n'affiche jamais le secret en clair", () => {
    const root = makeTempRoot();
    try {
      const file = path.join(root, "leak.txt");
      const key = "5" + "1".repeat(86);
      fs.writeFileSync(file, `BS58_PRIVATE_KEY=${key}\n`, "utf8");

      const { stderr } = runCheck(file);
      expect(stderr).not.toContain(key);
    } finally {
      removeTempRoot(root);
    }
  });
});
