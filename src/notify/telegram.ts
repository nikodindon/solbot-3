import type { Notifier } from "../monitoring/supervisor.js";

/**
 * Telegram — envoi de messages.
 *
 * L'envoi ne lève **jamais** : une notification qui échoue ne doit jamais
 * faire tomber le bot. Le résultat est renvoyé pour les métriques.
 */

export interface TelegramConfig {
  token: string;
  chatId: string;
  /** Timeout de l'appel HTTP, en ms. */
  timeoutMs?: number;
}

export interface SendResult {
  ok: boolean;
  description: string;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class TelegramNotifier implements Notifier {
  readonly configured: boolean;

  constructor(
    private readonly config: TelegramConfig | null,
    private readonly fetchImpl: FetchLike = (globalThis as unknown as { fetch: FetchLike }).fetch,
  ) {
    this.configured = config !== null;
  }

  async send(kind: string, text: string): Promise<boolean> {
    if (!this.config) return false;
    const result = await this.sendMessage(text);
    if (!result.ok) {
      // Échec silencieux côté métier : le message est perdu, le bot continue.
      return false;
    }
    void kind;
    return true;
  }

  async sendMessage(text: string): Promise<SendResult> {
    if (!this.config) return { ok: false, description: "Telegram non configuré" };

    try {
      const response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.config.token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: this.config.chatId,
            text,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
        },
      );

      const body = await response.text();
      if (!response.ok) {
        return { ok: false, description: `HTTP ${response.status} — ${body.slice(0, 200)}` };
      }
      return { ok: true, description: "envoyé" };
    } catch (error) {
      return {
        ok: false,
        description: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Notifier sans effet (tests, paper sans Telegram). */
export function noopNotifier(): Notifier {
  return {
    configured: false,
    send: () => Promise.resolve(false),
  };
}
