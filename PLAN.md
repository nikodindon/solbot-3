# PLAN — solbot3

Suivi de l'avancement, phase par phase. La spécification complète est dans
[`README.md`](README.md) ; ce fichier ne fait que cocher les cases.

> Une phase ne commence que lorsque la précédente est verte sur sa
> **Definition of Done** (DoD).

## Vue d'ensemble

| Phase | Version | Objectif | Risque sur les fonds | État |
|---|---|---|---|---|
| 0 | v0.1 | Fondations : config, logs, wallet, CLI, doctor | Nul | ✅ **terminée** |
| 1 | v0.2 | Données : Price v3, Tokens v2, SQLite, scan, watch | Nul | ✅ **terminée** |
| 2 | v0.3 | Backtest multi-fenêtres et import historique | Nul | ⬜ à faire |
| 3 | v0.4 | Moteur paper, régimes, stratégies, RiskManager | Nul | ⬜ à faire |
| 4 | v0.5 | Allocateur shadow, lab, rapports, Telegram, supervision | Nul | ⬜ à faire |
| 5 | v0.6 | Exécution Jupiter : dry-run puis micro-live | Faible, encadré | ⬜ à faire |
| 6 | v0.7 | Dashboard complet et observabilité avancée | Faible | ⬜ à faire |
| 7 | v1.0 | Ordres on-chain, keystore, chemins avancés, walk-forward | Encadré, mature | ⬜ à faire |

---

## Phase 0 — Fondations (v0.1)

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

**DoD :** `init` puis `doctor` fonctionnent contre le RPC et l'API réels ; aucun
secret dans les logs ; toutes les configurations invalides sont couvertes par un
test.

> ✅ **Vérifié le 2026-10-21** — `init` génère un keypair et écrit `.env` en
> `600` ; `doctor` interroge le RPC public (slot lu), Price v3 (prix SOL réel)
> et Tokens v2 (2 tokens résolus), lit les soldes du wallet et signale
> l'absence de base. 36 tests verts, `tsc --noEmit` et `eslint` propres,
> Prettier appliqué.

### Notes de conception (Phase 0)

- **zod 4** : `.default()` attend la valeur de *sortie*, `.prefault()` la valeur
  d'*entrée*. Les sections du YAML sont donc `.prefault({})` (l'utilisateur peut
  omettre la section) et chaque stratégie est un objet `.prefault({})` (l'allure
  `strategies: {}` reste valide).
- **SDK Solana** : `@solana/web3.js` v3 (le `Keypair` y est asynchrone et la
  clé privée est exportable — nécessaire pour écrire `.env`). `@solana/kit` v8
  est embarqué dans web3.js v3 pour les transactions v1 de la phase 7.
- **`SOLBOT3_HOME`** : permet de faire tourner plusieurs instances à partir
  d'une seule installation (données, base, fichier `STOP` séparés).
- **Empreinte de configuration** : le garde-fou live de la phase 4 exigera le
  hash exact des stratégies ; le schéma zod strict est déjà en place pour que
  ce hash soit stable.

---

## Phase 1 — Données de marché (v0.2)

- [x] Client Jupiter : fetch typé zod, `x-api-key`, timeouts, retry 429 et 5xx avec backoff, token bucket par plan
- [x] Price v3 par lots de 50 mints, cache court
- [x] Tokens v2 : recherche, tags, catégories, récents
- [x] Univers : filtres, tri déterministe, watchlist persistée
- [x] SQLite via `node:sqlite`, migrations versionnées
- [x] `watch` : ticks persistés, agrégation OHLCV 5m, 15m, 1h, upsert idempotent
- [x] Origine des prix tracée (`discovery` / `candle`)
- [x] CLI : `scan`, `price`, `watch`

**DoD :** `scan` produit une watchlist stable d'un run à l'autre ; `watch`
alimente des bougies cohérentes vérifiées en base ; le client ne dépasse jamais
le débit de son plan, y compris sous erreurs 429.

> ✅ **Vérifié le 2026-10-21** — `scan` contre l'API réelle produit 42
> actifs (SOL + USDC + 40) et une watchlist **identique** entre deux scans
> consécutifs ; `watch` a tenu 5 ticks à 15 s d'intervalle sans aucune
> violation de cohérence de bougie (0 sur 42 × 3 bougies) ; le token bucket
> est vérifié par un test qui mesure le temps d'attente effectif.

### Notes de conception (Phase 1)

- **Volume par bougie** : Jupiter ne donne pas d'historique de volume. On
  déduit le volume *écoulé* de la variation du volume 24 h entre deux polls
  (migration v2 : `tokens.volume_24h_usd`). C'est une **approximation**, et
  elle est documentée comme telle (README §9.5). Le premier tick d'un actif
  n'a pas de référence : son volume vaut `null`, pas `0`.
- **Origine des prix** : `price_ticks.src` vaut `discovery` pour tout ce qui
  vient de Price v3 (donc adossé à une liquidité réelle). La valeur `candle`
  est réservée aux prix issus d'une bougie OHLCV, et `import` à l'historique
  GeckoTerminal (phase 2). La garde de données de la phase 3 s'appuiera dessus.
- **Stabilité de la watchlist** : le tri est total — score organique, puis
  liquidité, puis symbole, puis mint. Sans le tie-break final sur le mint,
  deux scans sur le même univers pourraient différer sur un symbole ex æquo.
- **La liquidité est supposée statique** : la valeur de `liquidity` vient du
  dernier passage, elle n'est pas réévaluée à chaque tick.

---

## Prochaine étape — Phase 2

Import GeckoTerminal, backtest rejouant le moteur réel, métriques,
walk-forward, sensibilité aux coûts. Le point de vigilance : le backtest doit
utiliser **exactement** le même modèle de coûts que le paper, sinon la parité
backtest/paper sera cassée à la source (le défaut de solbot2).

---

## Phase 2 — Backtest (v0.3)

- [ ] Import GeckoTerminal (pool de plus forte réserve), table dédiée, retry 429
- [ ] Fusion import / live à la lecture, import prioritaire
- [ ] Backtester sur le moteur réel : seams bougies, horloge, coûts
- [ ] Modèle de coûts : slippage de fill, impact, priority fee
- [ ] Métriques : PnL net, win rate, profit factor, Sharpe simplifié, drawdown, turnover, frais
- [ ] Stockage des runs avec label et empreinte de configuration
- [ ] `backtest walk-forward` (fenêtres glissantes, out-of-sample agrégé)
- [ ] Test de sensibilité aux coûts (×1,5 et ×2)
- [ ] CLI : `backtest import`, `backtest run`, `backtest walk-forward`, `report`

**DoD :** un backtest sur 60 jours couvrant au moins 3 fenêtres tourne de bout en
bout ; un même scénario en backtest et en simulation produit les mêmes
décisions ; les métriques non calculables valent `null`, jamais une valeur
trompeuse.

---

## Phase 3 — Moteur paper et stratégies (v0.4)

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

**DoD :** kill-switch testé (entrées coupées, sorties actives) ; chaque rejet
est en base avec sa règle ; 48 h de paper sans fuite de mémoire, sans position
orpheline et avec un journal cohérent ; arrêt propre vérifié.

---

## Phase 4 — Allocateur, lab, supervision (v0.5)

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

**DoD :** l'allocateur choisit une stratégie pilote et la change uniquement au
delà de l'hystérésis ; le garde-fou refuse le live pour une configuration non
testée et l'accepte pour une configuration conforme ; 7 jours d'uptime en paper
sans intervention ; kill-switch déclenché depuis Telegram ; restauration de
backup validée sur une machine neuve.

---

## Phase 5 — Exécution Jupiter (v0.6)

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
- aller-retour USDC → SOL → USDC de 10 USDC en live, slippage total < 1 %, deux
  trades journalisés avec leur signature ;
- 2 semaines de micro-live sans divergence de réconciliation non expliquée ;
- comparaison A/B du chemin Router sur au moins 200 swaps réels avant tout
  changement de défaut.

---

## Phase 6 — Dashboard et observabilité (v0.7)

- [ ] Serveur HTTP et API REST lecture seule (§13.2)
- [ ] Flux SSE : ticks, trades, alertes
- [ ] Front React / Vite : vues Vue d'ensemble, Stratégies, Positions, Trades, Décisions, Données
- [ ] Graphiques d'équité par stratégie et buy & hold de référence (uPlot)
- [ ] Jeton d'accès et avertissement d'exposition
- [ ] Journal des décisions consultable par filtre (stratégie, motif, actif, date)
- [ ] Rapport quotidien en HTML généré par le moteur

**DoD :** le dashboard reflète l'état réel à ± 1 tick ; aucune route d'écriture
(vérifié par test) ; chargement de la vue d'ensemble en moins de 2 s sur 30 jours
d'historique.

---

## Phase 7 — Intelligence et extensions (v1.0)

- [ ] Ordres limite on-chain via Trigger API, déposés à chaque entrée (take-profit)
- [ ] Ordres DCA Trigger pour la rotation, si le backtest le justifie
- [ ] Walk-forward automatisé avec garde anti-surapprentissage (validation out-of-sample obligatoire)
- [ ] Keystore chiffré (argon2id + AES-GCM) et déverrouillage au démarrage
- [ ] Signer alternatif : service de signature distant
- [ ] Sous-comptes par stratégie (un wallet par stratégie, PnL et risque cloisonnés)
- [ ] Évaluation documentée de la copie de wallets (recherche seulement, pas d'implémentation avant validation)

**DoD :** les secrets sont chiffrés au repos ; au moins un filet on-chain est
actif en permanence en live ; un wallet de stratégie peut être révoqué et
remplacé sans arrêter le bot.
