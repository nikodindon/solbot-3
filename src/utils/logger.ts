import { pino, type Level, type Logger as PinoLogger } from "pino";

/**
 * Chemins systématiquement masqués dans les logs (défense en profondeur :
 * même en cas d'erreur de développement, aucun secret ne doit fuir).
 */
const REDACT_PATHS = [
  "BS58_PRIVATE_KEY",
  "JUPITER_API_KEY",
  "GECKO_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DASHBOARD_TOKEN",
  "privateKey",
  "secretKey",
  "secretKeyBase58",
  "signedTransaction",
  "*.BS58_PRIVATE_KEY",
  "*.JUPITER_API_KEY",
  "*.GECKO_API_KEY",
  "*.TELEGRAM_BOT_TOKEN",
  "*.DASHBOARD_TOKEN",
  "*.privateKey",
  "*.secretKey",
  "*.secretKeyBase58",
  "*.signedTransaction",
];

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Logger applicatif — interface minimale pour permettre l'injection d'un stub
 * dans les tests sans dépendre de pino.
 */
export interface Logger {
  trace(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
}

export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): PinoLogger {
  return pino({
    level: level as Level,
    base: undefined,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  });
}

let instance: Logger | undefined;

export function initLogger(level?: string): Logger {
  instance = createLogger(level);
  return instance;
}

export function getLogger(): Logger {
  if (!instance) instance = createLogger();
  return instance;
}

/** Logger muet — utilisé par les tests et les commandes sans sortie structurée. */
export function noopLogger(): Logger {
  const noop = (): void => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
}
