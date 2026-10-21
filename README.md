# solbot3

> Bot de trading **spot** sur Solana, propulsé par **Jupiter**, conçu pour tester des stratégies de façon rigoureuse (backtest → paper → dry-run → live encadré), avec gestion du risque stricte, journal complet et dashboard en lecture seule.

**Statut du projet : 🚧 en conception.** Ce README décrit la cible de la v1.0 et sert de feuille de route. Les commandes et options indiquées sont la spécification à implémenter ; l'avancement est suivi dans la section [Roadmap](#18-roadmap-détaillée).

---

> ⚠️ **AVERTISSEMENT — À LIRE EN PREMIER**
>
> Le mode **live** manipule des **fonds réels** sur **mainnet-beta**. Le trading de crypto-actifs, en particulier de tokens à faible liquidité, peut entraîner la **perte totale** du capital.
> solbot3 ne promet aucun rendement. Un backtest positif ne garantit rien pour le futur. Ce logiciel n'est **pas un conseil financier**.
> Commencez toujours par le **paper trading**, utilisez un **wallet dédié** avec un capital que vous pouvez perdre entièrement, et ne passez en live qu'après validation complète du parcours décrit dans ce document.

---

## Sommaire

1. [Présentation](#1-présentation)
2. [Fonctionnalités](#2-fonctionnalités)
3. [Architecture](#3-architecture)
4. [Stack technique](#4-stack-technique)
5. [Installation](#5-installation)
6. [Configuration](#6-configuration)
7. [Utilisation](#7-utilisation)
8. [Stratégies](#8-stratégies)
9. [Backtesting et validation](#9-backtesting-et-validation)
10. [Paper trading](#10-paper-trading)
11. [Mode live Jupiter](#11-mode-live-jupiter)
12. [Gestion du risque](#12-gestion-du-risque)
13. [Dashboard](#13-dashboard)
14. [Observabilité et alertes](#14-observabilité-et-alertes)
15. [Sécurité](#15-sécurité)
16. [Tests et qualité](#16-tests-et-qualité)
17. [Structure du dépôt](#17-structure-du-dépôt)
18. [Roadmap détaillée](#18-roadmap-détaillée)
19. [Idées écartées et hors périmètre](#19-idées-écartées-et-hors-périmètre)
20. [FAQ](#20-faq)
21. [Ressources](#21-ressources)
22. [Licence](#22-licence)

---

## 1. Présentation

### 1.1 Objectif

solbot3 est la troisième itération du projet. Il vise un seul objectif : **permettre de tester des idées de trading sur Solana de manière honnête**, puis de les exécuter sur Jupiter si et seulement si elles passent des garde-fous mesurables.

Le projet part de deux expérimentations antérieures :

- **solbot** : une architecture propre (moteur de stratégies pluggable, RiskManager qui a le dernier mot, backtest qui rejoue le moteur réel, garde-fou live conditionné à un backtest, réconciliation on-chain au démarrage, Telegram, backups).
- **solbot2** : une approche orientée micro-capital, avec détection de régime, portefeuilles fantômes (« shadow ») pour comparer les stratégies, filtre d'edge net par rapport aux coûts, dashboard SSE, et des garde-fous nés de runs réels (détection des pools « mules », kill-switch, sweep des gains).

### 1.2 Ce qui est repris, ce qui est nouveau

| Idée | Origine | Dans solbot3 |
|---|---|---|
| Moteur de stratégies pluggable (interface `Strategy`) | solbot | Conservé, avec signaux typés et métadonnées d'audit |
| RiskManager comme autorité finale | solbot | Conservé et étendu (voir §12) |
| Backtest qui rejoue le **même moteur** que le live | solbot | Conservé, + multi-fenêtres et walk-forward |
| Garde-fou : pas de live sans backtest concluant | solbot | Conservé, lié à l'empreinte exacte de la configuration |
| Réconciliation on-chain au démarrage | solbot | Conservé (la chaîne fait foi) |
| Modes paper / dry-run / live | solbot | Conservé |
| Kill-switch fichier `STOP` + commandes Telegram | solbot | Conservé |
| `/healthz` + `/metrics` Prometheus, backups SQLite | solbot | Conservé |
| Chemins d'exécution Meta-Aggregator et Router, Jito, tx.jup.ag | solbot | Conservé comme options de la phase live |
| Détection de régime (trending / ranging / idle) | solbot2 | Nouveau module, utilisé par l'allocateur |
| Portefeuilles fantômes + allocation avec hystérésis | solbot2 | Nouveau : chaque stratégie tourne en parallèle, l'allocateur choisit |
| Edge net ≥ k × coûts avant toute entrée | solbot2 | Généralisé (k configurable) |
| Traçabilité de l'origine des prix (`discovery` / `candle`) | solbot2 | Généralisé : aucun prix n'entre dans une décision sans son origine |
| Dashboard lecture seule en SSE | solbot2 | Repensé, avec API REST et vues par stratégie |
| Scalpeurs mèmes en paper | solbot2 | Déplacés dans un **laboratoire** isolé et désactivé par défaut (voir §8.3) |

### 1.3 Principes directeurs

- **Sécurité d'abord.** Wallet dédié, mode paper par défaut, `confirm_live` obligatoire, plafonds d'exposition, kill-switch accessible en une commande.
- **Mesurer avant d'agir.** Aucune stratégie n'accède au live sans backtest multi-fenêtres, validation out-of-sample et analyse de sensibilité aux coûts.
- **Un seul moteur.** Backtest, paper, dry-run et live exécutent exactement le même code de décision. Seules les couches d'accès aux données et d'exécution changent.
- **Chaque décision est expliquable.** Signal → arbitrage → risque → ordre → exécution sont journalisés avec leur raison, dans SQLite.
- **Honnêteté documentée.** Les limites (liquidité supposée statique en backtest, profondeur d'historique, slippage modélisé) sont écrites, chiffrées et affichées dans les rapports.
- **Dépendances minimales.** SQLite intégré à Node, client Jupiter maison et typé, pas de framework lourd.

---

## 2. Fonctionnalités

| Domaine | Fonctionnalité | Phase |
|---|---|---|
| **Wallet** | Génération (`init`), stockage chiffré en phase 7, abstraction `Signer` dès le début | 0 / 7 |
| **Univers** | Découverte via Tokens API v2, filtres liquidité / âge / organic score / blacklist, watchlist déterministe | 1 |
| **Données** | Price API v3 en polling, bougies OHLCV internes (1m, 5m, 15m, 1h), import historique GeckoTerminal | 1 / 2 |
| **Régimes** | Classification trending / ranging / idle par actif, utilisée par l'allocateur | 3 |
| **Stratégies** | Moteur pluggable : tendance (breakout + EMA), mean-reversion, grille, rotation DCA, momentum relatif, méta-stratégie par régime | 3 / 4 |
| **Portefeuilles fantômes** | Chaque stratégie activée tourne en shadow ; l'allocateur choisit celle qui pilote le capital réel ou virtuel | 4 |
| **Backtest** | Rejeu du moteur réel, multi-fenêtres, walk-forward, sensibilité aux coûts | 2 / 4 |
| **Paper** | Temps réel, aucun ordre, fills simulés avec coûts modélisés, équité par tick | 3 |
| **Dry-run** | Vrais `/order` + simulation RPC (`simulateTransaction`), sans signature | 5 |
| **Live** | Swap V2 `/order` → signature locale → `/execute`, garde-fous, réconciliation au boot | 5 |
| **Risque** | Sizing, plafonds, stop-loss / take-profit / trailing, pertes journalières, drawdown, cooldowns, impact prix, réserve de gaz | 3 |
| **Protection on-chain** | Ordres limite et DCA Jupiter Trigger API comme filets qui survivent à un crash du bot | 7 |
| **Dashboard** | Vue lecture seule : NAV, positions, trades, décisions, allocation, santé des données | 6 |
| **Supervision** | `/healthz`, `/metrics` (Prometheus), journal structuré pino, rapport quotidien | 4 |
| **Pilotage à distance** | Telegram : statut, positions, PnL, pause, reprise, kill-switch | 4 |
| **Sauvegardes** | Backup SQLite quotidien (`VACUUM INTO`), rotation, restauration vérifiée | 4 |

---

## 3. Architecture

### 3.1 Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────────────────┐
│                               solbot3                                   │
│                                                                         │
│  ┌──────────┐   ┌────────────┐   ┌──────────────┐   ┌───────────────┐    │
│  │ Scanner  │──▶│ Market     │──▶│ Régimes      │──▶│ Stratégies    │    │
│  │ (univers)│   │ (prix,OHLCV)│  │ trend/range/ │   │ (plugins,     │    │
│  └────┬─────┘   └─────┬──────┘   │ idle         │   │  shadow)      │    │
│       │               │          └──────────────┘   └──────┬────────┘    │
│       │               ▼                                     ▼            │
│       │        ┌────────────┐                      ┌──────────────┐     │
│       │        │  SQLite    │◀─────────────────────│ Allocateur   │     │
│       │        │ (vérité    │                      │ (hystérésis, │     │
│       │        │  locale)   │                      │  edge net)   │     │
│       │        └─────┬──────┘                      └──────┬───────┘     │
│       │              │                                    ▼            │
│       │              │                            ┌──────────────┐     │
│       │              │                            │ RiskManager  │     │
│       │              │                            │ (dernier mot)│     │
│       │              │                            └──────┬───────┘     │
│       │              │                                   ▼            │
│       │              │         ┌───────────────────────────────────┐    │
│       │              │         │ Executor (un seul, selon le mode) │    │
│       │              │         │  paper │ dry-run │ live           │    │
│       │              │         └───────┬───────────────┬───────────┘    │
│       │              │                 ▼               ▼                │
│       │              │        Broker virtuel     Jupiter Swap V2        │
│       │              │                           /order → sign →        │
│       │              │                           /execute               │
│       ▼              ▼                                                  │
│  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌────────────────────┐    │
│  │ Dashboard│  │ Telegram  │  │ /healthz   │  │ Backups + logs pino│    │
│  │ (lecture)│  │ (contrôle)│  │ /metrics   │  │                    │    │
│  └──────────┘  └───────────┘  └────────────┘  └────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Principes d'architecture

- **Pipeline unique.** Un tick enchaîne : marché → régimes → NAV et kill-switch → sorties → shadows et allocation → entrées → journal. Les sorties passent toujours avant les entrées.
- **Seams injectables.** Les accès aux données (`MarketSource`), à l'horloge (`Clock`), aux coûts (`CostModel`) et à l'exécution (`Executor`) sont des interfaces. Le backtest injecte l'historique, le paper injecte le broker virtuel, le live injecte Jupiter.
- **Un verrou de trade.** Un seul ordre en vol à la fois. Les erreurs de tick sont comptées ; au-delà d'un seuil, le moteur s'arrête proprement.
- **Vérité on-chain en live.** Au démarrage, les soldes RPC font foi. Toute divergence avec SQLite est adoptée, ajustée ou clôturée, puis journalisée.
- **Origine des données tracée.** Chaque prix porte sa source (`discovery`, `candle`, `import`). Une décision de trade refuse les prix sans source fiable ou trop anciens.

### 3.3 Pipeline d'un tick (défaut : 30 s)

1. **Marché** — Price v3 (batch ≤ 50 mints), écriture des ticks et mise à jour des bougies.
2. **Régimes** — classification par actif sur bougies 15 m clôturées.
3. **NAV et kill-switch** — valorisation, peak et drawdown, ancre de perte journalière (UTC), fichier `STOP`.
4. **Sorties** — stop-loss, take-profit, trailing, signaux de sortie, sortie forcée en régime `idle` prolongé.
5. **Shadows et allocation** — évaluation de toutes les stratégies actives en parallèle, score glissant, choix de la stratégie pilote avec hystérésis.
6. **Entrées** — meilleur signal de la stratégie pilote, filtre d'edge net, RiskManager, Executor.
7. **Journal** — équité, décisions, rejets, événements.

### 3.4 Arborescence des modules

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

---

## 4. Stack technique

| Couche | Choix | Pourquoi |
|---|---|---|
| Runtime | **Node.js 22 LTS**, **TypeScript 5** (`strict`) | Écosystème Solana mature, typage fort |
| Solana | `@solana/web3.js` v1 ; `@solana/kit` pour les transactions v1 (optionnel) | Standard de fait, lecture et signature |
| Jupiter | Client maison typé (zod) sur Swap V2, Price V3, Tokens V2, Trigger V2 | `@jup-ag/api` cible l'ancienne API V1 |
| Persistance | `node:sqlite` (intégré à Node 22) + migrations versionnées | Zéro dépendance native, monoprocessus |
| Config | `.env` + `config/config.yaml`, validation **zod** au démarrage | Échec immédiat si la config est invalide |
| CLI | `commander` | Simple, stable |
| Logs | `pino` (JSON) avec redaction des secrets | Logs exploitables, jamais de clé |
| Dashboard | Serveur `node:http` + SSE + front **React / Vite** léger | Lecture seule, pas de chemin d'écriture |
| Graphiques | `uPlot` (séries temporelles) | Léger et rapide |
| Tests | `vitest` | Rapide, TypeScript natif |
| Notifications | Telegram Bot API via `fetch` | Alertes et contrôle à distance |
| Déploiement | Docker (`restart: unless-stopped`) ou systemd | Redémarrage automatique, volume `data/` |

---

## 5. Installation

### 5.1 Prérequis

- Node.js ≥ 22 et npm ≥ 10.
- Une **clé API Jupiter** (<https://developers.jup.ag/portal>). Le mode sans clé existe mais est limité à 0,5 requête/s. Une clé est requise dès qu'on veut suivre plus de quelques dizaines d'actifs.
- Une URL RPC Solana. Le RPC public suffit pour les tests ; un fournisseur dédié (Helius, QuickNode, Triton) est recommandé en live.
- Pour le live uniquement : un peu de SOL (frais) et un capital en USDC (commencez avec 20 à 50 USDC).

### 5.2 Cloner et installer

```bash
git clone <votre-depot> solbot3 && cd solbot3
npm ci
cp .env.example .env
cp config/config.example.yaml config/config.yaml
```

### 5.3 Créer le wallet

```bash
npm run solbot3 -- init
```

La commande génère un keypair ed25519, écrit la clé dans `.env` (base58, permissions `600`), refuse d'écraser un `.env` existant (sauf `--force`) et affiche l'adresse à financer. Aucune clé n'apparaît jamais dans les logs.

> 🔐 Sauvegardez la clé dans un gestionnaire de mots de passe **avant** de financer le wallet. Ne committez jamais `.env`.

### 5.4 Vérifier l'environnement

```bash
npm run solbot3 -- doctor
```

`doctor` contrôle : version de Node, configuration valide, connectivité RPC, clé Jupiter, accès à Price v3 et Tokens v2, présence de la base et des migrations, soldes (si wallet configuré), présence du fichier `STOP`.

### 5.5 Financer (uniquement pour dry-run et live)

Envoyez sur l'adresse affichée : au moins **0,05 SOL** pour les frais, puis le capital de trading en USDC. Les modes paper et backtest fonctionnent sans aucun fonds.

### 5.6 Variables d'environnement

```dotenv
# Wallet (généré par init — ne jamais partager)
BS58_PRIVATE_KEY=

# Jupiter
JUPITER_API_KEY=
JUPITER_RPS=                  # vide = selon le plan ; surcharge du débit

# Solana RPC
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_RPC_FALLBACK_URL=

# Données historiques
GECKO_API_KEY=                # requis pour l'OHLCV GeckoTerminal on-demand

# Telegram (optionnel)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Dashboard (optionnel mais recommandé si exposé)
DASHBOARD_TOKEN=

LOG_LEVEL=info
```

---

## 6. Configuration

Toute la logique métier se règle dans `config/config.yaml`. Une valeur invalide ou manquante fait échouer le démarrage avec un message explicite.

```yaml
# ── Mode et garde-fous ─────────────────────────────────────────
mode: paper                     # paper | dry_run | live
confirm_live: false             # doit être true pour autoriser live
base_currency: USDC
loop_interval_s: 30

# ── Univers ────────────────────────────────────────────────────
universe:
  source: toptraded             # toptraded | toporganicscore | toptrending | whitelist
  interval: 24h                 # 5m | 1h | 6h | 24h
  candidate_limit: 100
  verified_only: true
  min_liquidity_usd: 250000
  min_organic_score: 60
  min_age_hours: 24             # évite les tokens récents (frais Jupiter 50 bps, rug)
  blacklist_mints: []
  whitelist_mints: []
  max_watchlist: 40

# ── Données ────────────────────────────────────────────────────
data:
  timeframes: [5m, 15m, 1h]
  stale_price_max_s: 300        # au-delà : le prix n'est pas utilisable pour décider
  require_price_source: [discovery, candle]   # origines acceptées pour une décision
  regime:
    timeframe: 15m
    window: 48
    trend_threshold_pct: 4      # variation minimale pour « trending »
    range_max_pct: 2.5          # amplitude maximale pour « ranging »

# ── Stratégies (chacune peut tourner en shadow) ────────────────
strategies:
  trend_breakout:
    enabled: true
    timeframe: 15m
    params: { ema_fast: 12, ema_slow: 26, breakout_lookback: 20, rsi_period: 14, rsi_max: 68, volume_mult: 1.5, atr_stop_mult: 2.0 }
  mean_reversion:
    enabled: true
    timeframe: 15m
    params: { window: 96, z_entry: 2.0, z_exit: 0.5 }
  grid:
    enabled: false
    timeframe: 15m
    params: { step_pct: 1.0, levels: 5 }
  dca_rotation:
    enabled: false
    params: { target_alloc: { SOL: 0.4, USDC: 0.6 }, drift_trigger_pct: 5, topup_usdc: 25 }
  relative_strength:
    enabled: false
    timeframe: 1h
    params: { lookback_h: 24, top_n: 3, rebalance_h: 6 }

# ── Allocation (portefeuilles fantômes) ────────────────────────
allocator:
  score_window_days: 7
  min_trades_to_score: 10
  hysteresis_pct: 15            # une stratégie doit dépasser la pilote de 15 % pour la remplacer
  min_edge_over_costs: 3.0      # edge net estimé ≥ 3 × coûts totaux, sinon rejet
  pilot_allocation_pct: 100     # part du capital confiée à la stratégie pilote

# ── Risque (le RiskManager a toujours le dernier mot) ──────────
risk:
  max_position_pct: 5           # % du NAV par position
  max_positions: 6
  max_asset_exposure_pct: 15
  daily_loss_limit_pct: 3       # pause des entrées jusqu'à minuit UTC
  max_drawdown_pct: 15          # kill-switch automatique
  stop_loss_pct: 8
  take_profit_pct: 15
  trailing_stop: { activation_pct: 6, retrace_pct: 3 }
  max_price_impact_pct: 1.0
  max_slippage_bps: 100
  min_time_between_trades_s: 300
  sol_gas_reserve: 0.05

# ── Simulation (paper et dry-run) ──────────────────────────────
paper:
  initial_usdc: 1000
  fill_slippage_bps: 20
  impact_k: 0.5
  priority_fee_sol: 0.00005

# ── Exécution (live) ───────────────────────────────────────────
execution:
  path: meta_aggregator         # meta_aggregator | router
  slippage: rtse                # rtse | adaptive | <bps>
  retries: 3
  retry_backoff_ms: 750
  confirm_timeout_s: 60
  router:
    landing: rpc                # rpc | tx_jup | jito
    tip_lamports: 0
    cu_limit_buffer: 1.2
    cu_price_cap_microlamports: 0

# ── Protections on-chain (phase 7) ─────────────────────────────
trigger:
  enabled: false
  take_profit_orders: true      # ordre limite de vente déposé à chaque entrée
  stop_loss_orders: false       # à évaluer : un stop on-chain peut être déclenché sur un spike

# ── Garde-fou live ─────────────────────────────────────────────
guard:
  min_backtest_days: 60
  min_windows: 3                # au moins 3 fenêtres de marché distinctes
  require_positive_oos_pnl: true
  max_cost_sensitivity_drop_pct: 40   # le résultat ne doit pas s'effondrer si les coûts +50 %

# ── Supervision ────────────────────────────────────────────────
notifications:
  telegram:
    enabled: false
    notify_on: [trade, error, daily_report, alert]
    commands_enabled: true
    daily_report_utc_hour: 8
monitoring:
  enabled: true
  host: 127.0.0.1
  port: 9464
dashboard:
  enabled: true
  host: 127.0.0.1
  port: 4200
backups:
  enabled: true
  dir: ./data/backups
  keep: 14
  daily_utc_hour: 3

database:
  path: ./data/solbot3.sqlite
```

---

## 7. Utilisation

### 7.1 Commandes

| Commande | Rôle |
|---|---|
| `init` | Crée le wallet et le `.env` (chmod 600) |
| `doctor` | Diagnostic complet de l'environnement |
| `scan [--top N]` | Construit la watchlist et l'enregistre |
| `price <entrée> <sortie>` | Prix en direct (Price v3) |
| `watch` | Collecte continue des prix et bougies, sans trader |
| `backtest import --days N` | Importe l'historique OHLCV (GeckoTerminal) |
| `backtest run --days N --label X [--config f.yaml]` | Rejoue le moteur réel |
| `backtest walk-forward --windows N` | Validation par fenêtres glissantes |
| `lab compare <label1> <label2> …` | Compare des runs et leurs métriques |
| `report [--days N] [--mode …]` | Métriques : PnL net, win rate, profit factor, Sharpe, drawdown, frais |
| `start --paper [--duration S] [--once]` | Moteur en paper |
| `start --dry-run` | Vrais `/order` et simulation on-chain, sans signature |
| `start --live` | Moteur réel (exige `confirm_live: true`, un backtest conforme et une confirmation) |
| `swap <entrée> <sortie> <montant\|max> [--dry-run\|--live] [--yes]` | Swap manuel, mêmes garde-fous |
| `status` | État : NAV, positions, pauses, STOP, dernier tick |
| `kill` / `resume` | Active ou retire le fichier `STOP` |
| `backup [--list\|--restore <f>]` | Sauvegarde et restauration vérifiée |
| `dashboard` | Démarre seulement le dashboard (lecture de la base) |

### 7.2 Exemples

```bash
# Découverte et prix
npm run solbot3 -- scan --top 40
npm run solbot3 -- price SOL USDC

# Historique puis backtest
npm run solbot3 -- backtest import --days 90
npm run solbot3 -- backtest run --days 90 --label trend-base
npm run solbot3 -- backtest walk-forward --windows 4
npm run solbot3 -- lab compare trend-base meanrev-z2

# Paper de 48 h, en tâche de fond
nohup npm run solbot3 -- start --paper --duration 172800 > logs/paper.log 2>&1 &

# Swap simulé
npm run solbot3 -- swap SOL USDC 0.05 --dry-run
```

### 7.3 Parcours recommandé

Ne sautez pas d'étape. Chaque étape a un critère de passage.

1. **Backtest multi-fenêtres** sur au moins 60 jours couvrant des régimes différents. Critère : les garde-fous du §9 sont verts.
2. **Paper** en continu pendant au moins 2 semaines. Critère : l'écart entre PnL paper et PnL backtest est expliqué et reste dans la tolérance.
3. **Dry-run** pendant au moins 1 semaine. Critère : taux d'échec de simulation < 5 %, aucun ordre refusé pour une cause inconnue.
4. **Micro-live** : 10 à 20 USDC, pendant au moins 2 semaines, avec kill-switch testé. Critère : aucune divergence de réconciliation non expliquée.
5. **Montée progressive** du capital, par paliers de ×2 maximum, en respectant les mêmes critères à chaque palier.

---

## 8. Stratégies

### 8.1 Interface

```ts
interface Strategy {
  readonly name: string;
  readonly requires: DataRequirement[];            // bougies, prix, liquidité, régime
  evaluate(snapshot: MarketSnapshot, portfolio: PortfolioView): Signal[];
}

interface Signal {
  assetMint: string;
  side: 'buy' | 'sell';
  confidence: number;               // 0..1
  expectedMoveBps: number;          // mouvement attendu, avant coûts
  ttlMs: number;                    // durée de validité
  reason: string;                   // journalisé tel quel
  stopLossPct?: number;
  sellPortion?: number;             // 0..1, défaut 1
  allowAdd?: boolean;
  suggestedSizeUsd?: number;        // plafond indicatif ; le RiskManager tranche
  tags?: string[];                  // ex. ['regime:trending']
}
```

Chaque stratégie est **évaluée seule**, puis confrontée aux autres via l'allocateur. Une stratégie ne peut jamais placer un ordre directement.

### 8.2 Catalogue

| Stratégie | Hypothèse de marché | Signaux | Régime cible | Statut |
|---|---|---|---|---|
| **trend_breakout** | Les cassures de plus hauts sur volume confirmé continuent | Achat sur cassure + EMA haussière + RSI sous seuil ; sortie sur EMA inverse | trending | ✅ portée depuis solbot |
| **mean_reversion** (z-score) | Un écart important à la moyenne revient | Achat si z ≤ −z_entry ; sortie si z ≥ −z_exit | ranging | ✅ portée depuis solbot |
| **grid** | Un actif oscille dans une fourchette | Achats par paliers sous l'ancre ; sortie à l'ancre | ranging | ✅ portée depuis solbot |
| **dca_rotation** | Un portefeuille cible se rééquilibre mieux qu'il ne se laisse dériver | Achat de la cible sous-allouée, allègement de la sur-allouée | tous | ✅ portée depuis solbot |
| **relative_strength** | Les actifs les plus forts sur 24 h restent forts quelques heures | Classement cross-sectionnel, achat du top N, rééquilibrage périodique | trending | 🆕 à développer |
| **regime_switch** | Chaque régime demande une stratégie différente | Route vers trend_breakout en trending, mean_reversion/grid en ranging, rien en idle | tous | 🆕 méta-stratégie |
| **memecoin_scalp** | Quelques listings récents font des mouvements très rapides | Entrée sur liquidité neuve, sorties par paliers | — | 🧪 laboratoire, paper, désactivé |

### 8.3 Le laboratoire (`lab/`)

Les stratégies à fort risque (scalping de mèmes, loterie sans stop) ne sont **jamais** dans le moteur principal. Elles vivent dans `lab/`, avec :

- une base SQLite séparée, un dashboard séparé et un mode **paper uniquement** codé en dur ;
- une limite de mise par lot (1 $ par défaut) et un capital initial séparé ;
- un **stop-loss obligatoire** dans la configuration par défaut. Une variante sans stop ne peut être activée qu'avec un drapeau explicite `lab.allow_no_stop: true`, qui écrit un avertissement dans chaque rapport ;
- un contrôle anti-manipulation : aucun prix issu d'une seule bougie ou d'une seule source n'est accepté pour valoriser une position (voir §12.3) ;
- un journal d'expériences versionné dans `results/experiments.md`, avec le résultat et la conclusion de chaque run, y compris les échecs.

### 8.4 Méthode de développement d'une stratégie

1. **Hypothèse écrite** : quel mécanisme de marché est exploité, et pourquoi il devrait persister.
2. **Implémentation** avec tests unitaires sur des séries synthétiques connues.
3. **Backtest** sur au moins 3 fenêtres de 30 jours minimum, dont au moins une en régime défavorable.
4. **Validation out-of-sample** : paramètres choisis sur une fenêtre, évalués sur une autre non vue.
5. **Sensibilité aux coûts** : rejeu avec des coûts × 1,5 et × 2.
6. **Shadow** en paper pendant au moins 2 semaines, en parallèle des autres stratégies.
7. **Décision** : abandon, amélioration ou promotion vers le live. Chaque décision est consignée.

Un résultat positif sur une seule fenêtre est considéré comme **non concluant**. Le projet a commencé avec ce constat : une stratégie qui gagne sur un mois peut perdre sur le suivant.

---

## 9. Backtesting et validation

### 9.1 Ce que fait le backtest

Le backtest rejoue le **moteur réel** (stratégies, allocateur, RiskManager, portefeuille FIFO) sur des bougies historiques, avec un tick par clôture de bougie. Les coûts sont appliqués selon `paper.*` (slippage de fill, impact `k × notionnel / liquidité`, priority fee convertie en USD).

### 9.2 Sources de données

- **Accumulation interne** : `solbot3 watch` et le moteur remplissent les bougies 5m, 15m, 1h dans SQLite.
- **Import externe** : `backtest import` interroge GeckoTerminal pour les pools de plus forte réserve. Les bougies importées sont stockées dans une table distincte et fusionnées à la lecture, l'import étant prioritaire.

### 9.3 Garde-fous de validation (`guard`)

Le live n'est accessible que si **tous** les critères suivants sont remplis pour l'empreinte exacte de la configuration (hash de la configuration des stratégies, poids et paramètres inclus) :

| Critère | Seuil par défaut |
|---|---|
| Couverture historique | ≥ 60 jours |
| Fenêtres de marché distinctes | ≥ 3 |
| PnL net hors échantillon | > 0 |
| Sensibilité aux coûts (×1,5) | baisse du PnL ≤ 40 % |
| Parité paper / backtest | écart expliqué dans le rapport |
| Résultat concluant | `conclusive = true` |

Modifier un seul paramètre change l'empreinte et impose de rejouer le backtest. Un backtest sur trop peu de données est marqué `conclusive = false` et ne déverrouille rien.

### 9.4 Walk-forward

`backtest walk-forward --windows N` découpe la période en N segments. Pour chaque segment, les paramètres sont optimisés sur le segment d'entraînement puis évalués sur le segment suivant. Le rapport présente le PnL out-of-sample agrégé, pas le meilleur PnL in-sample.

### 9.5 Limites connues (à afficher dans chaque rapport)

- La **liquidité** est supposée statique en backtest. Elle varie en réalité, surtout sur les petites capitalisations.
- La **profondeur d'historique** dépend de l'âge des pools : un actif récent a moins de données que les autres.
- Le **volume par bougie** est estimé à partir des statistiques 24 h, ce qui reste une approximation.
- Les **fills** sont modélisés, pas observés. L'écart réel est mesuré en paper puis en dry-run.

---

## 10. Paper trading

Le paper trading fait tourner le moteur en temps réel, avec les vrais prix, sans aucun ordre.

| Aspect | Comportement |
|---|---|
| Prix | Price v3 en temps réel, avec contrôle de fraîcheur |
| Fills | Au prix courant, plus `fill_slippage_bps`, plus impact, plus priority fee |
| Portefeuille | Virtuel, initialisé à `paper.initial_usdc` |
| Stratégies | Toutes les stratégies activées tournent en shadow ; une seule est pilote |
| Journal | Mêmes tables que le live, avec `mode = paper` |
| Équité | Un point par tick dans `equity_curve` |

Un **rapport de parité** compare chaque semaine le PnL paper et le PnL du backtest sur la même période. Les écarts sont décomposés : coûts, timing des fills, liquidité, décisions divergentes.

---

## 11. Mode live Jupiter

### 11.1 Chemin d'exécution par défaut : Meta-Aggregator

```
1. GET  /swap/v2/order?inputMint=…&outputMint=…&amount=…&taker=<pubkey>
        → transaction (base64), requestId, outAmount, router, feeBps

2. Signature locale (VersionedTransaction)
        → si le routeur est JupiterZ, signature partielle ; Jupiter ajoute la sienne au /execute

3. POST /swap/v2/execute   { signedTransaction, requestId }
        → status, signature, totalInputAmount, totalOutputAmount, code
```

Avantages : protection MEV et landing gérés par Jupiter, slippage RTSE automatique, aucun RPC requis pour l'exécution. C'est le chemin par défaut, et il le reste sauf preuve du contraire.

### 11.2 Chemin avancé : Router (`/build`)

Pour contrôler la transaction (instructions personnalisées, landing alternatif), `execution.path: router` assemble la transaction v0 localement, simule pour dimensionner les unités de calcul, puis l'envoie par l'un des trois chemins :

- `rpc` : envoi via votre RPC, confirmation par blockhash ;
- `tx_jup` : envoi via l'infrastructure tx.jup.ag (tip ≥ 0,001 SOL) ;
- `jito` : envoi en bundle Jito, comptes de tip récupérés dynamiquement.

Le chemin ne devient le défaut qu'après une comparaison A/B sur au moins 200 swaps réels (`solbot3 paths`).

### 11.3 Garde-fous live

- `mode: live` **et** `confirm_live: true` **et** confirmation interactive (« oui », délai de 60 s) ou drapeau `--yes` pour l'automatisation.
- Backtest conforme au §9.3 pour l'empreinte courante.
- Solde SOL au-dessus de `sol_gas_reserve` ; sinon refus.
- Réconciliation au démarrage : soldes on-chain adoptés, ajustés (FIFO) ou clôturés, avec évènement journalisé.
- Plafond de slippage `risk.max_slippage_bps` appliqué même si la stratégie demande plus.
- Un échec de type « confirmation incertaine » n'est **jamais** réessayé en aveugle : la signature est vérifiée d'abord.

### 11.4 Slippage

- `rtse` (recommandé) : slippage automatique par Jupiter.
- `adaptive` : borne calculée à partir de l'ATR récent de l'actif, bornée par `min_bps` et `max_bps`. Après un échec de slippage, la borne est élargie d'un facteur 2 au maximum, sans jamais dépasser `max_slippage_bps`.
- Borne fixe en bps : à réserver aux cas documentés.

### 11.5 Ordres de protection on-chain (phase 7)

La Trigger API permet de déposer des ordres limite de vente sur Jupiter. Un take-profit déposé on-chain **survit à un crash du bot**, ce qui en fait un filet de sécurité. Les stop-loss on-chain sont plus délicats : ils peuvent se déclencher sur une mèche de prix. Leur usage est donc désactivé par défaut et doit faire l'objet d'un backtest dédié.

---

## 12. Gestion du risque

### 12.1 Règles appliquées, dans l'ordre

1. **Kill-switch global** : fichier `STOP` présent, drawdown maximal atteint, ou commande d'arrêt reçue. Aucune entrée. Les sorties restent actives.
2. **Perte journalière** : au-delà de `daily_loss_limit_pct`, pause des entrées jusqu'à minuit UTC.
3. **Plafonds** : nombre de positions, exposition par actif, exposition totale.
4. **Edge net** : `expectedMoveBps − coûts estimés ≥ min_edge_over_costs × coûts`. Sinon rejet.
5. **Sizing** : `min(max_position_pct × NAV, exposition restante, contrainte de liquidité)`.
6. **Impact prix** : rejet si l'impact estimé dépasse `max_price_impact_pct`.
7. **Cooldown** : délai minimum entre deux trades sur le même actif.
8. **Réserve de gaz** : le SOL sous `sol_gas_reserve` n'est jamais vendu, et le trade est refusé si les frais le consomment.
9. **Garde de données** : prix périmé ou sans source acceptée → rejet.

### 12.2 Sorties

Stop-loss, take-profit, trailing stop et signal de sortie sont évalués à chaque tick, avec priorité absolue sur toute entrée. Une sortie n'est jamais bloquée par le RiskManager, sauf par une garde de données.

### 12.3 Anti-manipulation des prix

Un prix n'est utilisé pour valoriser une position que s'il respecte :

- une **source** connue (`discovery` : liquidité récente de Price v3 ; `candle` : bougie OHLCV) ;
- une **fraîcheur** inférieure à `stale_price_max_s` ;
- une **cohérence** : un saut de prix supérieur à 4 × le dernier prix de liquidité connu est traité comme suspect, et le prix retenu reste le dernier prix fiable ;
- pour une **sortie**, une profondeur de pool connue, jamais déduite du prix lui-même.

Chaque clamp est journalisé avec sa raison.

### 12.4 Drawdown et kill-switch

Le drawdown est mesuré depuis le pic d'équité. Au-delà de `max_drawdown_pct`, le fichier `STOP` est créé automatiquement, les entrées sont coupées et une alerte est envoyée. La reprise nécessite une action manuelle (`solbot3 resume`), jamais automatique.

---

## 13. Dashboard

Le dashboard est **strictement lecture seule**. Il n'expose aucune route d'écriture.

### 13.1 Vues

- **Vue d'ensemble** : NAV, cash, buy & hold de référence, drawdown, PnL du jour, statut des garde-fous.
- **Stratégies** : pour chaque stratégie, équité en shadow, score glissant, nombre de signaux, rejets par motif, allocation courante.
- **Positions** : quantité, prix d'entrée, prix de marque et son origine, PnL latent, stop et take-profit, âge.
- **Trades** : chaque exécution, avec mode, chemin, slippage demandé et réalisé, frais, signature.
- **Décisions** : signaux, arbitrages, rejets du risque, avec la règle concernée.
- **Données** : fraîcheur des prix par actif, couverture des bougies, régimes courants.

### 13.2 API

| Endpoint | Contenu |
|---|---|
| `GET /api/state` | Instantané de l'état courant |
| `GET /api/positions` | Positions ouvertes |
| `GET /api/trades?limit=…` | Historique des trades |
| `GET /api/strategies` | Shadows, scores, allocation |
| `GET /api/decisions?since=…` | Signaux, arbitrages, rejets |
| `GET /api/stream` | Flux SSE : ticks, trades, alertes |
| `GET /healthz` | État du moteur (voir §14) |
| `GET /metrics` | Métriques Prometheus |

### 13.3 Sécurité du dashboard

- Écoute sur `127.0.0.1` par défaut.
- Si `DASHBOARD_TOKEN` est défini, toutes les routes exigent ce jeton (en-tête ou cookie de session).
- Un avertissement est affiché au démarrage si le dashboard écoute sur une interface publique sans jeton.
- Les clés API et la clé privée ne sont jamais renvoyées par l'API.

---

## 14. Observabilité et alertes

### 14.1 Santé

`GET /healthz` renvoie `ok`, `stale` ou `degraded`, avec mode, version, uptime, nombre de ticks, âge du dernier tick, NAV, état des pauses et du kill-switch, et date du dernier backup. Il répond **503** si le dernier tick dépasse trois fois l'intervalle, ou si la base est inaccessible. Le healthcheck Docker s'appuie sur cette route.

### 14.2 Métriques

Format Prometheus : ticks, erreurs de tick, NAV, positions, drawdown, PnL du jour, prix obtenus par origine, rejets par règle, exécutions par statut, latence d'exécution, alertes, backups, uptime.

### 14.3 Journal

Logs JSON pino, un flux par type de décision : `signal`, `arbitrage`, `risk`, `order`, `execute`, `alloc`, `data`, `error`. Les champs sensibles sont redactés.

### 14.4 Alertes

| Alerte | Déclencheur |
|---|---|
| Réserve de gaz | Solde SOL sous la réserve (live) |
| RPC ou marché en échec | N erreurs de tick consécutives |
| Échecs d'exécution | Taux d'échec anormal sur une fenêtre glissante |
| Divergence de réconciliation | Positions adoptées, ajustées ou clôturées au démarrage |
| Kill-switch | Déclenché automatiquement ou manuellement |
| Données périmées | Prix d'un actif tenu non rafraîchi depuis N minutes |
| Parité | Écart paper / backtest hors tolérance dans le rapport hebdomadaire |

Chaque règle a un délai de répétition (`cooldown_min`), persisté en base pour survivre aux redémarrages.

### 14.5 Telegram

Notifications : trade, erreur, rapport quotidien, alerte, backup.

Commandes (acceptées uniquement depuis le chat configuré) : `/status`, `/positions`, `/pnl [jours]`, `/pause`, `/resume`, `/kill`, `/help`.

---

## 15. Sécurité

### 15.1 Modèle de menace

| Risque | Mitigation |
|---|---|
| Clé privée commitée | `.env` dans `.gitignore`, hook de pré-commit qui refuse les motifs de clé |
| Lecture par un autre utilisateur | `chmod 600`, utilisateur système dédié |
| Fuite via logs ou crash dump | Redaction pino, la clé ne traverse jamais le logger |
| Compromission de la machine | Wallet dédié, capital limité, pas de navigateur sur la machine |
| Ordre accidentel en live | `confirm_live`, confirmation interactive, plafonds par position et par jour |
| Stratégie qui perd en silence | Kill-switch drawdown, pause journalière, alertes de parité |
| Prix manipulé | Garde de données (§12.3) |
| Dashboard exposé | Écoute locale, jeton, lecture seule |
| Crash en pleine position | Réconciliation on-chain, ordres de protection (phase 7) |
| Fuite de clé avérée | Procédure : transfert des fonds, nouveau wallet, rotation de la clé API, audit |

### 15.2 Stockage de la clé

Phases 0 à 5 : clé dans `.env` (chmod 600), acceptable seulement pour un wallet dédié à faible capital.
Phase 7 : keystore chiffré (argon2id + AES-GCM), déverrouillé au démarrage. L'interface `Signer` est prévue dès le départ pour permettre le passage à un service de signature distant ou à un KMS.

### 15.3 Checklist avant tout passage en live

- [ ] Wallet dédié, capital ≤ montant acceptable de perte
- [ ] `.env` en chmod 600, absent de Git, sauvegarde de la clé hors machine
- [ ] Clé Jupiter dédiée à cet environnement, permissions minimales
- [ ] Machine dédiée ou VPS durci, utilisateur non root
- [ ] `confirm_live: true` défini volontairement, backtest conforme pour l'empreinte courante
- [ ] Kill-switch testé (fichier `STOP` et `/kill` Telegram)
- [ ] Procédure de fuite de clé écrite et testée
- [ ] Sauvegardes SQLite vérifiées par une restauration de test
- [ ] `npm audit` propre

---

## 16. Tests et qualité

```bash
npm test              # vitest : unitaires + intégration moteur
npm run test:int      # tests contre l'API Jupiter réelle (SOLBOT3_INTEGRATION=1)
npm run lint
npm run typecheck
npm run backtest:smoke   # rejeu rapide sur 3 jours, vérifie que le moteur tourne de bout en bout
```

Priorités de test :

- **Risque** : chaque règle testée seule et dans son ordre d'application.
- **Moteur** : séquence d'un tick, priorité des sorties, verrou de trade, arrêt propre.
- **Données** : agrégation OHLCV, fusion import / live, garde anti-manipulation, fraîcheur.
- **Portefeuille** : FIFO, lots partiels, PnL réalisé et latent.
- **Exécution** : chaque code d'erreur Jupiter (`/order` et `/execute`) a un test de récupération.
- **Parité** : un même scénario rejoué en backtest et en paper doit produire les mêmes décisions.

---

## 17. Structure du dépôt

```
solbot3/
├── config/
│   ├── config.example.yaml
│   └── strategies/              # variantes de paramètres pour le lab
├── deploy/
│   ├── solbot3.service          # unité systemd
│   └── logrotate.solbot3
├── docs/
│   ├── architecture.md
│   ├── strategies.md            # hypothèse et résultats de chaque stratégie
│   └── runbook.md               # procédures d'incident
├── results/
│   ├── experiments.md           # journal versionné des expériences
│   └── archive/                 # bases de runs (non versionnées)
├── scripts/
├── src/                         # voir §3.4
├── tests/
├── web/                         # front du dashboard (React / Vite)
├── Dockerfile
├── docker-compose.yml
├── PLAN.md
├── README.md
└── package.json
```

---

## 18. Roadmap détaillée

Une phase ne commence que lorsque la précédente est verte sur sa **Definition of Done** (DoD). Les cases sont à cocher au fil de l'avancement.

### Vue d'ensemble

| Phase | Version | Objectif | Risque sur les fonds |
|---|---|---|---|
| 0 | v0.1 | Fondations : config, logs, wallet, CLI, doctor | Nul |
| 1 | v0.2 | Données : Price v3, Tokens v2, SQLite, scan, watch | Nul |
| 2 | v0.3 | Backtest multi-fenêtres et import historique | Nul |
| 3 | v0.4 | Moteur paper, régimes, stratégies, RiskManager | Nul |
| 4 | v0.5 | Allocateur shadow, lab, rapports, Telegram, supervision | Nul |
| 5 | v0.6 | Exécution Jupiter : dry-run puis micro-live | Faible, encadré |
| 6 | v0.7 | Dashboard complet et observabilité avancée | Faible |
| 7 | v1.0 | Ordres on-chain, keystore, chemins avancés, walk-forward automatisé | Encadré, mature |

---

### Phase 0 — Fondations (v0.1)

- [x] Projet TypeScript strict, ESLint, Prettier, vitest, tsx
- [x] `config` : chargement `.env` et `config.yaml`, validation zod, échec explicite
- [x] `logger` : pino JSON, redaction des secrets, niveaux configurables
- [x] `connection` : RPC avec retry, timeout et fournisseur de secours
- [x] CLI commander : `init`, `doctor`, `version`
- [x] `init` : keypair ed25519, `.env` chmod 600, refus d'écrasement, adresse et guide de financement
- [x] Interface `Signer` avec implémentation `EnvSigner`
- [x] `doctor` : RPC, clé Jupiter, soldes, version Node, base, STOP
- [x] `.gitignore` et hook de pré-commit qui bloque les clés privées
- [x] Tests : configuration invalide, parseur `.env`, signer, `init`

**DoD :** `init` puis `doctor` fonctionnent contre le RPC et l'API réels ; aucun secret dans les logs ; toutes les configurations invalides sont couvertes par un test.

### Phase 1 — Données de marché (v0.2)

- [x] Client Jupiter : fetch typé zod, `x-api-key`, timeouts, retry 429 et 5xx avec backoff, token bucket par plan
- [x] Price v3 par lots de 50 mints, cache court
- [x] Tokens v2 : recherche, tags, catégories, récents
- [x] Univers : filtres, tri déterministe, watchlist persistée
- [x] SQLite via `node:sqlite`, migrations versionnées
- [x] `watch` : ticks persistés, agrégation OHLCV 5m, 15m, 1h, upsert idempotent
- [x] Origine des prix tracée (`discovery` / `candle`)
- [x] CLI : `scan`, `price`, `watch`

**DoD :** `scan` produit une watchlist stable d'un run à l'autre ; `watch` alimente des bougies cohérentes vérifiées en base ; le client ne dépasse jamais le débit de son plan, y compris sous erreurs 429.

### Phase 2 — Backtest (v0.3)

- [ ] Import GeckoTerminal (pool de plus forte réserve), table dédiée, retry 429
- [ ] Fusion import / live à la lecture, import prioritaire
- [ ] Backtester sur le moteur réel : seams bougies, horloge, coûts
- [ ] Modèle de coûts : slippage de fill, impact, priority fee
- [ ] Métriques : PnL net, win rate, profit factor, Sharpe simplifié, drawdown, turnover, frais
- [ ] Stockage des runs avec label et empreinte de configuration
- [ ] `backtest walk-forward` (fenêtres glissantes, out-of-sample agrégé)
- [ ] Test de sensibilité aux coûts (×1,5 et ×2)
- [ ] CLI : `backtest import`, `backtest run`, `backtest walk-forward`, `report`

**DoD :** un backtest sur 60 jours couvrant au moins 3 fenêtres tourne de bout en bout ; un même scénario en backtest et en simulation produit les mêmes décisions ; les métriques non calculables valent `null`, jamais une valeur trompeuse.

### Phase 3 — Moteur paper et stratégies (v0.4)

- [ ] Interface `Strategy` et registre piloté par la configuration
- [ ] Stratégie `trend_breakout`
- [ ] Stratégie `mean_reversion` (z-score)
- [ ] Stratégie `grid`
- [ ] Stratégie `dca_rotation`
- [ ] Détection de régime (trending, ranging, idle) avec tests sur séries synthétiques
- [ ] Portefeuille : positions, lots FIFO, mark-to-market, PnL réalisé et latent, NAV
- [ ] RiskManager complet (§12.1) et table des rejets avec règle et métriques
- [ ] Boucle principale, verrou de trade, arrêt propre SIGINT et SIGTERM
- [ ] SL, TP et trailing évalués à chaque tick, priorité sur les entrées
- [ ] Fichier `STOP` et pause de perte journalière
- [ ] Broker paper avec coûts modélisés et équité par tick
- [ ] Mode `paper` avec `--duration` et `--once`

**DoD :** kill-switch testé (entrées coupées, sorties actives) ; chaque rejet est en base avec sa règle ; 48 h de paper sans fuite de mémoire, sans position orpheline et avec un journal cohérent ; arrêt propre vérifié.

### Phase 4 — Allocateur, lab, supervision (v0.5)

- [ ] Portefeuilles fantômes : chaque stratégie activée en shadow
- [ ] Score glissant (Sharpe ou ratio gain/risque sur fenêtre) et seuil d'échantillon minimal
- [ ] Allocateur avec hystérésis et filtre d'edge net (`min_edge_over_costs`)
- [ ] Méta-stratégie `regime_switch`
- [ ] Stratégie `relative_strength`
- [ ] `lab/` : base séparée, mode paper codé en dur, mise plafonnée, stop-loss obligatoire
- [ ] `results/experiments.md` alimenté automatiquement par le lab
- [ ] Garde-fou live (§9.3) : vérification de l'empreinte et des critères
- [ ] Rapport de parité paper / backtest
- [ ] `/healthz` et `/metrics` (registre maison, sans dépendance)
- [ ] Telegram : notifications et commandes, chat unique autorisé
- [ ] Alertes avec cooldown persisté
- [ ] Backups SQLite (`VACUUM INTO`, rotation) et restauration vérifiée
- [ ] Docker et systemd

**DoD :** l'allocateur choisit une stratégie pilote et la change uniquement au-delà de l'hystérésis ; le garde-fou refuse le live pour une configuration non testée et l'accepte pour une configuration conforme ; 7 jours d'uptime en paper sans intervention ; kill-switch déclenché depuis Telegram ; restauration de backup validée sur une machine neuve.

### Phase 5 — Exécution Jupiter (v0.6)

- [ ] Executor Swap V2 : `/order`, signature locale, `/execute`, parsing complet
- [ ] Gestion exhaustive des codes d'erreur de `/order` et `/execute`, avec stratégie par code
- [ ] Mode dry-run : vrais `/order` et `simulateTransaction`, sans signature
- [ ] Journal des trades : signature, mints, montants, router, frais, slippage demandé et réalisé, codes d'erreur
- [ ] Réconciliation on-chain au démarrage
- [ ] Confirmation interactive et `--yes` ; plafonds de slippage et de montant
- [ ] Commande `swap` manuelle avec les mêmes garde-fous
- [ ] Chemin Router (`/build`) avec landing `rpc`, `tx_jup` et `jito`
- [ ] Commande `paths` : comparaison A/B sur swaps réels
- [ ] Slippage `adaptive` avec repli sur RTSE
- [ ] Tests d'intégration contre l'API réelle (désactivés par défaut)

**DoD :**
- 10 dry-runs consécutifs sans erreur non gérée ;
- aller-retour USDC → SOL → USDC de 10 USDC en live, slippage total < 1 %, deux trades journalisés avec leur signature ;
- 2 semaines de micro-live sans divergence de réconciliation non expliquée ;
- comparaison A/B du chemin Router sur au moins 200 swaps réels avant tout changement de défaut.

### Phase 6 — Dashboard et observabilité (v0.7)

- [ ] Serveur HTTP et API REST lecture seule (§13.2)
- [ ] Flux SSE : ticks, trades, alertes
- [ ] Front React / Vite : vues Vue d'ensemble, Stratégies, Positions, Trades, Décisions, Données
- [ ] Graphiques d'équité par stratégie et buy & hold de référence (uPlot)
- [ ] Jeton d'accès et avertissement d'exposition
- [ ] Journal des décisions consultable par filtre (stratégie, motif, actif, date)
- [ ] Rapport quotidien en HTML généré par le moteur

**DoD :** le dashboard reflète l'état réel à ± 1 tick ; aucune route d'écriture (vérifié par test) ; chargement de la vue d'ensemble en moins de 2 s sur 30 jours d'historique.

### Phase 7 — Intelligence et extensions (v1.0)

- [ ] Ordres limite on-chain via Trigger API, déposés à chaque entrée (take-profit)
- [ ] Ordres DCA Trigger pour la rotation, si le backtest le justifie
- [ ] Walk-forward automatisé avec garde anti-surapprentissage (validation out-of-sample obligatoire)
- [ ] Keystore chiffré (argon2id + AES-GCM) et déverrouillage au démarrage
- [ ] Signer alternatif : service de signature distant
- [ ] Sous-comptes par stratégie (un wallet par stratégie, PnL et risque cloisonnés)
- [ ] Évaluation documentée de la copie de wallets (recherche seulement, pas d'implémentation avant validation)

**DoD :** les secrets sont chiffrés au repos ; au moins un filet on-chain est actif en permanence en live ; un wallet de stratégie peut être révoqué et remplacé sans arrêter le bot.

---

## 19. Idées écartées et hors périmètre

- **Scalping de mèmes sans stop-loss sur le moteur principal.** Écarté. Une variante reste possible dans `lab/` pour l'étude, avec les garde-fous du §8.3.
- **Perpétuels et effet de levier.** Hors périmètre : le risque de liquidation dépasse le cadre du projet.
- **Arbitrage circulaire.** Non supporté par les API publiques de Jupiter. Hors périmètre.
- **Rendement sur le cash inactif** (produits de type Jupiter Lend). Intéressant, à évaluer après la phase 7.
- **Marchés de prédiction.** Hors périmètre à ce stade.
- **Stratégies « boîte noire » non explicables.** Une stratégie doit pouvoir justifier chaque signal dans le journal ; sinon elle n'est pas acceptée.

---

## 20. FAQ

**Jupiter fonctionne-t-il sur devnet ?**
Non. La liquidité Jupiter est sur **mainnet-beta**. Le développement se fait donc en paper, puis en dry-run, puis en live avec de très petits montants.

**Puis-je trader les tokens récents ou les mèmes ?**
Techniquement oui. Le moteur principal les exclut par défaut (`min_age_hours: 24`) à cause des frais Jupiter de 50 bps sur les tokens de moins de 24 h, de la liquidité fragile et du risque de rug. Un abaissement de ce seuil est un choix explicite et engage votre seule responsabilité.

**Pourquoi le backtest ne suffit-il pas ?**
Il ne modélise ni le carnet réel, ni la latence, ni la concurrence avec les autres bots. C'est pourquoi le paper et le dry-run existent, et pourquoi le live a un garde-fou de montant.

**Que se passe-t-il si le bot crashe en pleine position ?**
La vérité est on-chain. Au redémarrage, les soldes RPC sont lus, comparés à SQLite, puis réconciliés. Les ordres de protection (phase 7) continuent de fonctionner pendant l'arrêt.

**Quels frais dois-je prendre en compte ?**
Jupiter facture des frais variables selon la paire (0 à 50 bps, plus élevés pour les tokens récents), inclus dans le devis. S'ajoutent les frais réseau et les priority fees. Le moteur les modélise dans le backtest et le paper, et le rapport de parité compare les deux.

**Pourquoi un backtest sur plusieurs fenêtres ?**
Une stratégie qui gagne sur un mois peut perdre sur le suivant, comme le montrent les premiers essais des projets précédents. Plusieurs fenêtres, dont une défavorable, réduisent ce risque sans le supprimer.

**Puis-je utiliser solbot3 sans clé Jupiter ?**
Oui pour un petit univers et des tests. Au-delà de quelques dizaines d'actifs, la limite de 0,5 requête/s devient bloquante ; une clé est alors nécessaire.

**Le dashboard peut-il passer des ordres ?**
Non. Il est lecture seule, et cette propriété est vérifiée par un test.

---

## 21. Ressources

**Jupiter**
- Documentation générale : <https://developers.jup.ag/docs>
- Swap API V2 (`/order` et `/execute`) : <https://developers.jup.ag/docs/swap/order-and-execute>
- Swap API V2 (`/build`) : <https://developers.jup.ag/docs/swap/build/index>
- Techniques avancées (RTSE, CU, latence) : <https://developers.jup.ag/docs/swap/advanced/index>
- Price API V3 : <https://developers.jup.ag/docs/price/index>
- Tokens API V2 : <https://developers.jup.ag/docs/tokens/index>
- Trigger (ordres limite et DCA) : <https://developers.jup.ag/docs/trigger/index>
- Soumission des transactions : <https://developers.jup.ag/docs/transaction/submit>
- Limites de débit et plans : <https://developers.jup.ag/docs/portal/rate-limits>
- Clés API : <https://developers.jup.ag/portal>

**Solana**
- `@solana/web3.js` : <https://github.com/solana-labs/solana-web3.js>
- `@solana/kit` : <https://github.com/anza-xyz/kit>
- Explorateur : <https://solscan.io>

**Données**
- GeckoTerminal API : <https://www.geckoterminal.com>

---

## 22. Licence

MIT, voir `LICENSE` (à créer).

> ⚖️ **Rappel** : ce projet est fourni à des fins éducatives et expérimentales, sans aucune garantie. Aucune performance n'est promise ou implicite. Vous êtes seul responsable de vos fonds et de la conformité de votre activité avec la réglementation applicable dans votre juridiction.
