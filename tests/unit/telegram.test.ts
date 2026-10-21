import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema } from "../../src/config/schema.js";
import { TelegramController, parseCommand } from "../../src/notify/controller.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { addLot } from "../../src/state/portfolio-repo.js";
import { kvGetNumber, STATE_KEYS } from "../../src/state/kv.js";

const CONFIG = appConfigSchema.parse({});

describe("contrôleur Telegram", () => {
  let root: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "solbot3-tg-"));
    db = openDb({ path: ":memory:" });
    migrate(db);
  });

  afterEach(() => {
    closeDb(db);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function controller(): TelegramController {
    return new TelegramController({ db, cfg: CONFIG, root });
  }

  it("répond à /status", () => {
    const response = controller().handle(parseCommand("/status")!);
    expect(response).toContain("solbot3");
    expect(response).toContain("NAV");
  });

  it("liste les positions", () => {
    addLot(db, "Aa", "AAA", 100, 2, 1000);
    const response = controller().handle(parseCommand("/positions")!);
    expect(response).toContain("AAA");
  });

  it("calcule le PnL sur une période", () => {
    const response = controller().handle(parseCommand("/pnl 7")!);
    expect(response).toContain("PnL sur 7 j");
  });

  it("met en pause et reprend les entrées", () => {
    const pause = controller().handle(parseCommand("/pause")!);
    expect(pause).toContain("pause");
    expect(kvGetNumber(db, STATE_KEYS.manualPaused)).not.toBeNull();

    const resume = controller().handle(parseCommand("/resume")!);
    expect(resume).toContain("Reprise");
    expect(kvGetNumber(db, STATE_KEYS.manualPaused)).toBeNull();
  });

  it("déclenche le kill-switch par fichier", () => {
    const response = controller().handle(parseCommand("/kill")!);
    const stopFile = path.join(root, "data", "STOP");
    expect(response).toContain("Kill-switch");
    expect(fs.existsSync(stopFile)).toBe(true);

    // Le fichier existe déjà : la commande ne doit pas échouer.
    const again = controller().handle(parseCommand("/kill")!);
    expect(again).toContain("Kill-switch");
  });

  it("répond à /help et aux commandes inconnues", () => {
    expect(controller().handle(parseCommand("/help")!)).toContain("/status");
    expect(controller().handle(parseCommand("/inconnu")!)).toContain("inconnue");
  });
});
