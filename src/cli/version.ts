import fs from "node:fs";
import { getInstallationRoot, getPackageJsonPath } from "../utils/paths.js";

export interface VersionInfo {
  version: string;
  node: string;
  platform: string;
}

/** Version du projet (lue dans le `package.json` de l'installation). */
export function getVersionInfo(): VersionInfo {
  let version = "0.0.0";
  try {
    const raw = fs.readFileSync(getPackageJsonPath(getInstallationRoot()), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string") version = parsed.version;
  } catch {
    // package.json illisible : on reste sur une version neutre
  }
  return {
    version,
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
  };
}
