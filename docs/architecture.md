# Architecture — solbot3

## Principe directeur

**Un seul moteur.** Backtest, paper, dry-run et live exécutent exactement le
même code de décision. Seules les couches d'accès aux données et d'exécution
changent. Ce qui est simulé en backtest est donc forcément simulé de la même
manière en live.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              solbot3                                    │
│                                                                          │
│  Scanner ──▶ Market ──▶ Régimes ──▶ Stratégies ──▶ Allocateur           │
│  (univers)   (prix,     (trend/    (plugins,      (hystérésis,           │
│              OHLCV)      range/     shadow)        edge net)             │
│                 │        idle)          │                │                │
│                 ▼                       ▼                ▼                │
│              SQLite  ◀─────────── RiskManager (dernier mot) ─────────┐   │
│           (vérité locale)                                           │   │
│                 │                                                    ▼   │
│                 │                            Executor (un seul, 3 modes) │
│                 │                            paper │ dry-run │ live      │
│                 │                                    │                    │
│                 ▼                                    ▼                    │
│         Dashboard   Telegram   /healthz   /metrics   Backups + logs      │
│         (lecture)   (contrôle)                                       │   │
└──────────────────────────────────────────────────────────────────────┼───┘
                                                                       │
```

## Pipeline d'un tick (30 s par défaut)

1. **Marché** — Price v3 (lots de 50 mints), écriture des ticks, mise à jour
   des bougies.
2. **Régimes** — classification par actif sur bougies clôturées.
3. **NAV et kill-switch** — valorisation, pic d'équité, drawdown, ancre de
   perte journalière (UTC), fichier `STOP`.
4. **Sorties** — stop-loss, take-profit, trailing, signal de sortie, sortie
   forcée en régime `idle` prolongé. **Toujours avant les entrées.**
5. **Shadows et allocation** — toutes les stratégies actives tournent en
   parallèle, score glissant, choix de la stratégie pilote avec hystérésis.
6. **Entrées** — meilleur signal de la stratégie pilote, filtre d'edge net,
   RiskManager, Executor.
7. **Journal** — équité, décisions, rejets, événements.

Un seul ordre est en vol à la fois (verrou de trade). Au-delà d'un seuil
d'erreurs de tick consécutives, le moteur s'arrête proprement.

## Les seams (points d'injection)

Les quatre interfaces qui rendent le moteur testable et rejouable :

| Seam | Interface | Backtest | Paper | Live |
|---|---|---|---|---|
| Données | `MarketSource` | bougies importées | Price v3 | Price v3 |
| Horloge | `Clock` | timestamps des bougies | temps réel | temps réel |
| Coûts | `CostModel` | `paper.*` (identique) | `paper.*` | barème Jupiter réel |
| Exécution | `Executor` | fills simulés | fills simulés | `/order` → sign → `/execute` |

## Arborescence des modules

```
src/
├── engine/        tick, boucle, verrou, arrêt propre
├── market/        poller Price v3, agrégation OHLCV, régimes, sources de prix
├── strategies/    interface Strategy, registre, implémentations
├── allocator/     portefeuilles fantômes, score, hystérésis
├── risk/          RiskManager et règles unitaires
├── portfolio/     positions, lots FIFO, PnL, NAV
├── execution/     executor, broker paper, coûts, chemins Jupiter
├── jupiter/       client HTTP (token bucket, zod), Price, Tokens, Swap, Trigger
├── solana/        RPC lecture, réconciliation, signer
├── backtest/      rejeu, walk-forward, métriques, sensibilité aux coûts
├── lab/           expériences, comparaisons, journal de runs
├── state/         SQLite, migrations versionnées, backups
├── dashboard/     serveur HTTP, API REST, flux SSE
├── notify/        Telegram (sortant + commandes), alertes
├── monitoring/    /healthz, /metrics
├── cli/           commander
└── utils/         config (zod), logger (pino + redaction), horloge
```

## Règles non négociables

- Le **RiskManager a toujours le dernier mot** : un signal, même excellent,
  peut être rejeté, et chaque rejet est journalisé avec sa règle et ses chiffres.
- Une **sortie n'est jamais bloquée** par le RiskManager, sauf par une garde de
  données (prix périmé ou sans source fiable).
- Le **mode live** exige `confirm_live: true`, un backtest conforme à
  l'empreinte exacte de la configuration, une confirmation interactive et un
  wallet au-dessus de la réserve de gaz.
- **Aucun secret dans les logs** : redaction pino, la clé privée ne traverse
  jamais le logger.
- **La chaîne fait foi** : au démarrage en live, les soldes RPC sont adoptés,
  ajustés ou clôturés, et chaque divergence est journalisée.

## État et migrations

SQLite via `node:sqlite` (intégré à Node 22, aucune dépendance native).
Les migrations sont **append-only** : une migration écrite n'est jamais
modifiée. Chaque migration s'applique dans une transaction.

| v | Nom | Contenu |
|---|---|---|
| 1 | `core-market-data` | `bot_state`, `tokens`, `price_ticks` (avec `src`), `candles`, `watchlist` |

Les tables du journal de trading (`trades`, `positions`, `position_lots`,
`signals`, `decisions`, `equity`) arriveront avec le moteur (phase 3), les runs
de backtest avec la phase 2.
