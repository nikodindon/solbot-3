import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Crée un répertoire de travail temporaire (hors dépôt) et le supprime à la fin. */
export function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "solbot3-test-"));
}

export function removeTempRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Écrit un `config/config.yaml` minimal dans une racine temporaire. */
export function writeConfig(root: string, yaml: string): void {
  const dir = path.join(root, "config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml, "utf8");
}
