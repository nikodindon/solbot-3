import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { ConfigError } from "../utils/errors.js";
import { mergeEnv, readEnvFile } from "../utils/env-file.js";
import {
  getConfigExamplePath,
  getConfigPath,
  getEnvPath,
  getInstallationRoot,
  getProjectRoot,
} from "../utils/paths.js";
import type { AppConfig, AppEnv, Mode } from "./schema.js";
import { appConfigSchema, envSchema } from "./schema.js";

export interface LoadConfigOptions {
  /** Racine du projet (défaut : racine détectée). */
  root?: string;
  /** Environnement de référence (défaut : `process.env` fusionné avec `.env`). */
  env?: NodeJS.ProcessEnv;
  /** Chemin du YAML (défaut : `config/config.yaml`, sinon `config/config.example.yaml`). */
  yamlPath?: string;
  /** Forçage du mode (CLI) — priorité sur le YAML. */
  mode?: Mode;
}

export interface LoadedConfig {
  config: AppConfig;
  env: AppEnv;
  mode: Mode;
  sources: {
    yamlPath: string | null;
    usedExample: boolean;
    envPath: string | null;
  };
}

/** Formate les issues zod en une liste lisible `chemin: message`. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(racine)";
      return `${path}: ${issue.message}`;
    })
    .join(" ; ");
}

/**
 * Charge la configuration complète : `.env` + `config.yaml`, validée par zod.
 *
 * Toute anomalie lève une `ConfigError` explicite — le bot ne démarre jamais
 * avec une configuration à moitié comprise.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const root = options.root ?? getProjectRoot();

  // 1. Environnement : le shell prime toujours sur le fichier `.env`.
  const baseEnv = options.env ?? process.env;
  const envFile = readEnvFile(root);
  const mergedEnv = mergeEnv(baseEnv, envFile);

  const parsedEnv = envSchema.safeParse(mergedEnv);
  if (!parsedEnv.success) {
    throw new ConfigError(`environnement invalide — ${formatIssues(parsedEnv.error)}`, {
      hint: "corrigez le fichier .env (ou les variables exportées) puis relancez",
    });
  }

  // 2. YAML : `config/config.yaml`, à défaut `config/config.example.yaml`.
  const { yamlPath, usedExample, raw } = readYaml(root, options.yamlPath);

  const parsedConfig = appConfigSchema.safeParse(raw);
  if (!parsedConfig.success) {
    throw new ConfigError(`configuration invalide — ${formatIssues(parsedConfig.error)}`, {
      hint: `fichier fautif : ${yamlPath ?? "(aucun)"}`,
    });
  }

  const config = parsedConfig.data;
  const mode = options.mode ?? config.mode;

  // 3. Le forçage CLI du mode ne doit pas contourner le filet `confirm_live`.
  if (mode === "live" && !config.confirm_live) {
    throw new ConfigError("le mode `live` exige `confirm_live: true` dans la configuration", {
      hint: "posez confirm_live: true dans config/config.yaml (ou repassez en mode paper)",
    });
  }

  return {
    config: { ...config, mode },
    env: parsedEnv.data,
    mode,
    sources: {
      yamlPath,
      usedExample,
      envPath: fs.existsSync(getEnvPath(root)) ? getEnvPath(root) : null,
    },
  };
}

interface YamlRead {
  yamlPath: string | null;
  usedExample: boolean;
  raw: unknown;
}

function readYaml(root: string, explicitPath?: string): YamlRead {
  // Le fichier d'exemple appartient à l'installation : il sert de repli même
  // quand `root` pointe ailleurs (tests, instances multiples).
  const examplePath = getConfigExamplePath(getInstallationRoot());
  const candidates: string[] = explicitPath ? [explicitPath] : [getConfigPath(root), examplePath];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const content = fs.readFileSync(candidate, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch (error) {
      throw new ConfigError(
        `YAML illisible (${candidate}) — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed === null || parsed === undefined) parsed = {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(
        `le fichier de configuration doit contenir un objet YAML (${candidate})`,
      );
    }
    return {
      yamlPath: candidate,
      usedExample: candidate === examplePath,
      raw: parsed,
    };
  }

  throw new ConfigError("aucun fichier de configuration trouvé", {
    hint: `créez ${path.join(root, "config", "config.yaml")} à partir de config/config.example.yaml`,
  });
}

/**
 * Valide un objet de configuration déjà en mémoire (tests, variantes).
 * Même contrat que `loadConfig` : échec explicite.
 */
export function parseConfigRaw(raw: unknown): AppConfig {
  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`configuration invalide — ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}
