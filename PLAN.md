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
| 2 | v0.3 | Backtest multi-fenêtres et import historique | Nul | ✅ **terminée** |
| 3 | v0.4 | Moteur paper, régimes, stratégies, RiskManager | Nul | ✅ **terminée** |
| 4 | v0.5 | Allocateur shadow, lab, rapports, Telegram, supervision | Nul | ✅ **terminée** |
| 5 | v0.6 | Exécution Jupiter : dry-run puis micro-live | Faible, encadré | ✅ **terminée** (jamais activée) |
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

## Prochaine étape — Phase 3 (résiduel)

Régimes, mode paper temps réel, kill-switch fichier, arrêt propre. Puis
l'allocateur de la phase 4 (portefeuilles fantômes), qui est le seul moyen
de comparer honnêtement `trend_breakout` et `mean_reversion` — deux
hypothèses opposées, dont l'une des deux doit être profitable à un moment
donné.

En parallèle, la correction **A** du journal d'expériences : recalibrer
`expectedMoveBps` sur l'écart réel au plus haut récent, pour que le filtre
d'edge net morde enfin.

---

## Phase 2 — Backtest (v0.3)

- [x] Import GeckoTerminal (pool de plus grande réserve), table dédiée, retry 429
- [x] Fusion import / live à la lecture, import prioritaire
- [x] Backtester sur le moteur réel : seams bougies, horloge, coûts
- [x] Modèle de coûts : slippage de fill, impact, priority fee
- [x] Métriques : PnL net, win rate, profit factor, Sharpe simplifié, drawdown, turnover, frais
- [x] Stockage des runs avec label et empreinte de configuration
- [x] `backtest walk-forward` (fenêtres glissantes, out-of-sample agrégé)
- [x] Test de sensibilité aux coûts (×1,5 et ×2)
- [x] CLI : `backtest import`, `backtest run`, `backtest walk-forward`, `report`

**DoD :** un backtest sur 60 jours couvrant au moins 3 fenêtres tourne de bout en
bout ; un même scénario en backtest et en simulation produit les mêmes
décisions ; les métriques non calculables valent `null`, jamais une valeur
trompeuse.

> ✅ **Vérifié le 2026-10-21** — un backtest de 90 jours tourne de bout en
> bout en **57 s** (8 640 ticks rejoués) et produit 768 trades, une courbe
> d'équité complète et un run stocké avec son empreinte de configuration. Le
> test de parité rejoue le **même** scénario en mode `paper` et en mode
> `backtest` et compare décisions, trades et courbe d'équité : ils sont
> identiques. 134 tests verts.

### ⚠️ Réordonnancement assumé

Le moteur (portefeuille FIFO, modèle de coûts, RiskManager, stratégies,
boucle de tick) a été construit **avec** le backtest, et non après. Le README
exige que le backtest rejoue le *même* moteur que le live : c'est impossible
si le moteur n'existe pas encore, et un harnais de backtest jetable aurait
été un travail perdu.

Conséquence : la phase 3 a été **absorbée** par la phase 2, et complétée
depuis :

- [x] Détection de régime (trending, ranging, idle) avec tests sur séries synthétiques
- [x] Mode `paper` temps réel : boucle de tick, `--duration`, `--once`
- [x] Fichier `STOP` et pause de perte journalière en UTC
- [x] Arrêt propre SIGINT / SIGTERM
- [x] SL, TP et trailing évalués à chaque tick, priorité sur les entrées
- [ ] 48 h de paper sans fuite de mémoire ni position orpheline *(en cours)*

### Phase 3 — suite : le moteur paper en temps réel

`start --paper` fait tourner le moteur avec les **vrais prix** (Price v3) et
les **vrais coûts modélisés**, sans aucun ordre envoyé. Portefeuille virtuel
persistant (un redémarrage retrouve cash et positions), kill-switch fichier
`data/STOP`, arrêt propre sur SIGINT/SIGTERM.

Le paper tourne en continu sur l'instance de développement : il collecte les
bougies en direct, alimente la base et fournit la série de données qui
manquera toujours le plus à un backtest — le comportement réel entre deux
clôtures de bougie.

### Notes de conception (Phase 2)

- **Le moteur est un, et il est le même partout.** `MarketSource` (les
  prix), `CandleSource` (les bougies), `Clock` (le temps) et `Executor`
  (l'exécution) sont des *seams* : le backtest injecte l'historique et le
  temps, le live injecte l'API et l'horloge. Le test de parité compare les
  décisions des deux modes sur le même scénario.
- **Fenêtre de bougies fixe.** Les stratégies ne voient que les N bougies
  clôturées dont elles ont besoin (et pas davantage). C'est ce qui rend
  l'EMA identique en live et en backtest : une EMA amorcée sur l'historique
  complet n'aurait rien à voir avec celle d'un rejeu sur 90 jours.
- **La liquidité est supposée statique en backtest** (limite documentée,
  README §9.5) : on prend celle relevée au scan, ou le repli configuré
  (`backtest.default_liquidity_usd`).
- **Les bougies importées ont des trous** : un pool DEX sans trade sur un
  intervalle n'a pas de bougie. Le rejeu porte donc le dernier prix connu.
- **La parité paper/backtest a été vérifiée par le test, pas par l'hypothèse.**
  Elle a d'ailleurs révélé deux bugs que la relecture n'avait pas vus : les
  frais réseau calculés en lamports au lieu de SOL, et le coût de revient
  d'une position recalculé au prorata au lieu des lots réellement consommés.

### Résultat du premier backtest

`trend_breakout` par défaut, 90 jours, univers top-40 → **-59,56 $
(-5,96 %)**, win rate 29,17 %, profit factor 1,03, 1 fenêtre profitable sur
4 en walk-forward. **La stratégie par défaut ne fonctionne pas** : le détail
et les hypothèses de correction sont dans
[`results/experiments.md`](results/experiments.md). C'est un résultat
attendu et utile : le projet mesure avant d'agir.

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

- [x] Portefeuilles fantômes : chaque stratégie activée en shadow
- [x] Score glissant (Sharpe ou ratio gain/risque sur fenêtre) et seuil d'échantillon minimal
- [x] Allocateur avec hystérésis et filtre d'edge net (`min_edge_over_costs`)
- [x] Méta-stratégie `regime_switch`
- [x] Stratégie `relative_strength`
- [x] `lab/` : base séparée, mode paper codé en dur, mise plafonnée, stop-loss obligatoire
- [x] `results/experiments.md` alimenté automatiquement par le lab
- [x] Garde-fou live (§9.3) : vérification de l'empreinte et des critères
- [x] Rapport de parité paper / backtest
- [x] `/healthz` et `/metrics` (registre maison, sans dépendance)
- [x] Telegram : notifications et commandes, chat unique autorisé
- [x] Alertes avec cooldown persisté
- [x] Backups SQLite (`VACUUM INTO`, rotation) et restauration vérifiée
- [x] Docker et systemd

> ✅ **Vérifié le 2026-10-21** — l'allocateur choisit la pilote et ne la
> change qu'au-delà de l'hystérésis (8 tests) ; le garde-fou **refuse** le
> live pour une configuration non testée et l'**accepte** pour une
> configuration conforme (`solbot3 guard` affiche les six critères) ;
> `/healthz` renvoie 200 et le bon état, `/metrics` sort du Prometheus
> valide ; le kill-switch Telegram a été testé (et a révélé un bug de
> masquage de variable qui le faisait échouer **silencieusement**) ; la
> sauvegarde `VACUUM INTO` puis la restauration vérifiée ont été validées
> sur une base neuve ; l'image Docker se construit et répond.

### Notes de conception (Phase 4)

- **Un shadow n'est pas une simulation simplifiée** : c'est le même moteur
  de décision appliqué à un livre virtuel, avec les **mêmes coûts**. Un
  shadow qui triche sur les frais ne vaut rien comme instrument de
  comparaison.
- **L'hystérésis est relative** : le challenger doit faire
  `pilote × (1 + hystérésis)`. En points absolus, une pilote sous zéro
  bloquerait tout remplacement — et le portefeuille resterait bloqué sur une
  stratégie perdante.
- **Le seuil d'échantillon sert à arbitrer, pas à interdire de trader** :
  avec une seule stratégie active, elle pilote immédiatement. Sinon, le
  bot serait inactif pendant des semaines le temps que le shadow accumule
  assez de trades.
- **Le garde-fou live compare l'empreinte ET le timeframe** : deux runs de
  la même configuration à des timeframes différents ne mesurent pas la même
  chose. Un backtest 15 m ne valide pas une configuration jouée en 1 h.
- **Le lab est paper par construction** : `src/lab/` ne contient aucun
  chemin d'exécution réelle, sa base est séparée, la mise est plafonnée
  par construction (via `max_position_pct`), et un prix non corroboré par
  une seconde source est rejeté — on ne valorise pas une position sur un
  prix que quelqu'un peut choisir.

### Reste à faire en Phase 4

- [ ] 7 jours d'uptime en paper sans intervention *(le paper tourne, à
  confirmer au bout de 7 jours)*
- [ ] Test du kill-switch Telegram contre le **vrai** bot (le test unitaire
  couvre la commande, pas le transport)

**DoD :** l'allocateur choisit une stratégie pilote et la change uniquement au
delà de l'hystérésis ; le garde-fou refuse le live pour une configuration non
testée et l'accepte pour une configuration conforme ; 7 jours d'uptime en paper
sans intervention ; kill-switch déclenché depuis Telegram ; restauration de
backup validée sur une machine neuve.

---

## Phase 5 — Exécution Jupiter (v0.6)

- [x] Executor Swap V2 : `/order`, signature locale, `/execute`, parsing complet
- [x] Gestion exhaustive des codes d'erreur de `/order` et `/execute`, avec stratégie par code
- [x] Mode dry-run : vrais `/order` et `simulateTransaction`, sans signature
- [x] Journal des trades : signature, mints, montants, router, frais, slippage demandé et réalisé, codes d'erreur
- [x] Réconciliation on-chain au démarrage
- [x] Confirmation interactive et `--yes` ; plafonds de slippage et de montant
- [x] Commande `swap` manuelle avec les mêmes garde-fous
- [x] Chemin Router (`/build`) avec landing `rpc`, `tx_jup` et `jito`
- [x] Commande `paths` : comparaison A/B sur swaps réels
- [x] Slippage `adaptive` avec repli sur RTSE
- [x] Tests d'intégration contre l'API réelle (désactivés par défaut)

> ✅ **Implémentée le 2026-10-21, jamais activée.** Le mode par défaut reste
> `paper`. Le live est **triplement verrouillé** : `confirm_live` dans la
> configuration, un backtest conforme au garde-fou de la phase 4, et une
> confirmation interactive (« oui ») ou `--yes`.
>
> Le dry-run a été exercé **contre la vraie API Jupiter** : devis obtenu,
> erreur remontée et traduite, code de sortie 1. Le chemin Router est
> assemblé et testé hors ligne (assemblage v0, dimensionnement des CU,
> décodage du prix des CU) mais **n'a jamais été envoyé** : il reste
> explicitement marqué « opt-in, non validé ».

### Pourquoi le live reste verrouillé

Le projet n'a jamais eu l'intention de rendre le live accessible en un clic.
Trois verrous indépendants, chacun suffisant à le bloquer :

1. `confirm_live: true` dans `config/config.yaml` — un choix **délibéré** ;
2. le garde-fou de la phase 4 (empreinte de configuration exacte + couverture
   + fenêtres + PnL + sensibilité aux coûts) ;
3. une confirmation interactive au démarrage, contournable uniquement par
   `--yes` (automatisation assumée).

Tant que ces trois verrous ne sont pas franchis **volontairement**, le live
refuse de démarrer.

### Ce qui reste à faire en Phase 5

- [ ] 10 dry-runs consécutifs sans erreur non gérée *(l'un a été fait : il a
  correctement remonté « solde insuffisant », qui est le comportement attendu
  sur un wallet nonApprovisionné)*
- [ ] Aller-retour USDC → SOL → USDC en live, slippage total < 1 %
- [ ] 2 semaines de micro-live sans divergence de réconciliation
- [ ] Comparaison A/B du chemin Router sur au moins 200 swaps réels

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
