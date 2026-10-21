import { parseCommand, type TelegramController } from "./controller.js";

/**
 * Polling des commandes Telegram.
 *
 * Long polling : on lit `getUpdates` en boucle, avec un offset qui avance.
 * Un message d'un **chat non autorisé** est ignoré — mais l'offset avance
 * quand même, sinon on relirait le même message indéfiniment.
 */

export interface TelegramPollerOptions {
  token: string;
  chatId: string;
  controller: TelegramController;
  /** Intervalle entre deux polls, en ms. */
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onCommand?: (command: string, response: string) => void;
  /** Envoie la réponse à l'utilisateur. */
  reply?: (text: string) => Promise<void>;
}

export class TelegramPoller {
  private offset = 0;
  private stopped = false;

  constructor(private readonly options: TelegramPollerOptions) {}

  /** Boucle de polling. Résout quand `stop()` est appelé. */
  async run(): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const interval = this.options.pollIntervalMs ?? 2_000;

    while (!this.stopped) {
      try {
        await this.pollOnce(fetchImpl);
      } catch {
        // Une erreur réseau ne doit pas arrêter le bot : on réessaiera.
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** Réponse à une commande — envoyée par le notifier injecté. */
  private async sendReply(text: string): Promise<void> {
    if (!this.options.reply) return;
    try {
      await this.options.reply(text);
    } catch {
      // une réponse perdue n'est pas bloquante
    }
  }

  private async pollOnce(fetchImpl: typeof fetch): Promise<void> {
    const url = new URL(`https://api.telegram.org/bot${this.options.token}/getUpdates`);
    url.searchParams.set("timeout", "0");
    if (this.offset > 0) url.searchParams.set("offset", String(this.offset));

    const response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    if (!response.ok) return;

    const body = (await response.json()) as {
      ok?: boolean;
      result?: { update_id: number; message?: { text?: string; chat?: { id: number } } }[];
    };
    if (!body.ok || !Array.isArray(body.result)) return;

    for (const update of body.result) {
      this.offset = Math.max(this.offset, update.update_id + 1);

      const message = update.message;
      if (!message?.text) continue;
      // **Un seul chat est autorisé.**
      if (String(message.chat?.id) !== this.options.chatId) continue;

      const command = parseCommand(message.text);
      if (!command) continue;

      const responseText = this.options.controller.handle(command);
      await this.sendReply(responseText);
      this.options.onCommand?.(command.name, responseText);
    }
  }
}
