import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Racine du projet.
 * - Détectée depuis l'emplacement du module : `src/utils` → racine, `dist/utils` → racine.
 * - Surchargeable via `SOLBOT3_HOME` (tests, instances multiples).
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const detectedRoot = path.resolve(moduleDir, "..", "..");

export function getProjectRoot(): string {
  const override = process.env.SOLBOT3_HOME?.trim();
  return override ? path.resolve(override) : detectedRoot;
}

export function getEnvPath(root: string = getProjectRoot()): string {
  return path.join(root, ".env");
}

export function getConfigPath(root: string = getProjectRoot()): string {
  return path.join(root, "config", "config.yaml");
}

export function getConfigExamplePath(root: string = getProjectRoot()): string {
  return path.join(root, "config", "config.example.yaml");
}

export function getDataDir(root: string = getProjectRoot()): string {
  return path.join(root, "data");
}

/** Fichier de kill-switch : sa présence coupe les entrées (les sorties restent actives). */
export function getStopFilePath(root: string = getProjectRoot()): string {
  return path.join(getDataDir(root), "STOP");
}

export function getPackageJsonPath(root: string = getProjectRoot()): string {
  return path.join(root, "package.json");
}

/**
 * Racine de l'**installation** (là où vit le code), insensible à
 * `SOLBOT3_HOME`. Utile pour le `package.json` et le fichier d'exemple de
 * configuration, qui appartiennent au programme et non à l'instance.
 */
export function getInstallationRoot(): string {
  return detectedRoot;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
