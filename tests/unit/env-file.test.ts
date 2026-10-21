import { describe, expect, it } from "vitest";
import { maskSecret, mergeEnv, parseEnvContent, upsertEnvVar } from "../../src/utils/env-file.js";

describe("parseur .env", () => {
  it("lit les affectations, ignore commentaires et lignes vides", () => {
    const entries = parseEnvContent(
      ["# un commentaire", "", "A=1", "  B = deux  ", 'C="trois"', "export D=quatre"].join("\n"),
    );
    expect(entries.get("A")).toBe("1");
    expect(entries.get("B")).toBe("deux");
    expect(entries.get("C")).toBe("trois");
    expect(entries.get("D")).toBe("quatre");
    expect(entries.size).toBe(4);
  });

  it("la dernière occurrence gagne", () => {
    const entries = parseEnvContent("A=1\nA=2\n");
    expect(entries.get("A")).toBe("2");
  });

  it("insère une variable en préservant l'ordre et les commentaires", () => {
    const content = "# entête\nA=1\nB=2\n";
    const updated = upsertEnvVar(content, "C", "3");
    expect(updated).toBe("# entête\nA=1\nB=2\nC=3\n");
  });

  it("remplace une variable existante sans la dupliquer", () => {
    const content = "A=1\nB=2\n";
    const updated = upsertEnvVar(content, "A", "9");
    expect(updated).toBe("A=9\nB=2\n");
    expect(updated.match(/^A=/gm)).toHaveLength(1);
  });

  it("fusionne le fichier sans écraser l'environnement existant", () => {
    const file = new Map([
      ["A", "fichier"],
      ["B", "fichier"],
    ]);
    const merged = mergeEnv({ A: "shell" }, file);
    expect(merged.A).toBe("shell");
    expect(merged.B).toBe("fichier");
  });

  it("masque un secret", () => {
    expect(maskSecret("court")).toBe("********");
    expect(maskSecret("0123456789abcdef")).toBe("0123…cdef");
  });
});
