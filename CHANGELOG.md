# Changelog — solbot3

Toutes les versions sont datées. Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).

## [0.7.1] — 2026-10-25

Correctifs et réglages tirés de l'observation du run paper (démarré le
21/10/2026) et des quatre recommandations du bilan du 25/10. Le moteur ne
change pas de nature : affichage, calibrage, hygiène du journal.

### Corrigé

**1. Le tableau de bord comparait deux périodes différentes** *(recommandation 1)*

- La variation « buy & hold SOL » était calculée depuis la **première bougie
  importée** (23/07) alors que le NAV partait du 21/10 : le dashboard
  affichait `+32,9 %` pendant que SOL perdait `7,3 %` sur la durée du run, et
  la courbe de référence démarrait ~33 % au-dessus de la courbe d'équité.
- Le PnL, lui, était mesuré depuis le **début de la fenêtre affichée**
  (2 000 derniers points, ≈ 42 h) : `−0,8 %` au lieu de `−4,2 %`.
- Les deux s'ancrent désormais au **premier point de la courbe d'équité**
  (`firstEquityPoint`), et la référence prend le dernier cours SOL connu à
  cette date (`closeAtOrBefore`). Même origine, même période, deux courbes
  enfin comparables.
- Le graphique reste limité à 2 000 points : c'est une limite d'affichage,
  pas une limite de mesure — c'est écrit dans le guide.

**2. Le journal de décisions doublait à chaque tick** *(recommandation 4)*

- Le portefeuille fantôme et le livre réel produisent la phrase exacte :
  chaque note était écrite **deux fois**. ~296 000 lignes par jour, dont
  123 299 groupes de doublons (45 335 le 24/10 seul).
- Le moteur ignore désormais une ligne déjà enregistrée dans le même tick
  (même type, stratégie, actif et texte) : la moitié des écritures disparaît
  sans rien perdre.
- Nouvelle commande `maintenance` : elle compte les doublons, les supprime
  (copies exactes, perte nulle), puis compacte la base (`VACUUM`).
  `--plan` ne fait que compter, `--no-vacuum` saute la compaction. Si le bot
  ou le dashboard tient la base ouverte, le `VACUUM` échoue **à visage
  découvert** et le message dit d'arrêter les deux — on ne tue pas un bot
  pour compacter.

### Changé

**3. Le capital restait à 71 % inactif** *(recommandation 3)*

- `risk.max_positions: 6 → 12`. Six lignes à 5 % du NAV plafonnaient
  l'exposition à **30 %** du capital : le bot refusait 936 signaux par jour
  pour `max_positions` pendant que 71 % du cash dormait.
- 12 × 5 % = 60 % mobilisables. La taille de ligne reste à 5 % : une
  position qui dérape coûte toujours 5 %, pas davantage, et 40 % de
  liquidité reste disponible.

**4. Filtre des signaux extrêmes** *(recommandation 2 — vérifié : déjà en place)*

- Le garde-fou demandé existe depuis le `27271c7` (22/10) :
  `dropScaleBreaks` retire l'historique d'avant un changement d'échelle de
  pool (la cause exacte du faux signal ZCAT), et le RiskManager refuse tout
  edge annoncé supérieur à `risk.max_expected_move_bps` (règle
  `implausible_edge`, « donnée probablement corrompue »).
- **Rendu explicite** dans `config/config.yaml` (5 000 bps, soit un écart
  supérieur à ~33 % à la moyenne) et **couvert par deux tests** qui
  n'existaient pas : le cas ZCAT (−99,99 % → 999 900 bps) est rejeté, les
  entrées réelles du run (−6,8 % à −9,6 % → 727 à 1 056 bps) passent.
- Seuil volontairement **non resserré** : OPENAI (−26,85 % → 3 670 bps)
  reste sous le seuil et la position est à −1,25 %. On ne calibre pas un
  garde-fou sur une seule observation. Pour bloquer cette classe d'écart,
  passer `risk.max_expected_move_bps` à `2000`.

### Ajouté

**Les six correctifs du run (24 octobre)** — `3aa587b` et `34d652a`

- Pic d'équité **attesté par la courbe** (`attestNavPeak`) : un pic que la
  courbe ne justifie pas est réancré au lieu d'être cru les yeux fermés.
- Kill-switch **relu à la source** à chaque tick : créer ou retirer
  `data/STOP` prend effet au tick suivant, sans redémarrage.
- Cooldown posé à la **vente**, pic de prix réinitialisé à la réouverture.
- Fenêtre de régime chargée sur son propre timeframe : fini les « 0
  bougies ».
- `runShadows()` sorti du `else` : les portefeuilles fantômes tournent en
  toutes circonstances.
- `FileStopSwitch` partagé entre le moteur et le superviseur : les deux
  voient le même `data/STOP`.

- **10 tests ajoutés** : 258 → 268, toutes suites vertes. Typecheck, lint et
  formatage propres.

## [0.7.0] — 2026-10-22

Première version complète du moteur : de la configuration au dashboard.
Le bot est **complet dans ses fonctions**, mais **aucune configuration n'est
validée pour le live** — voir « Résultats » plus bas.

### Ajouté

**Phase 0 — Fondations**
- Configuration `zod` **stricte** couvrant tout le `config.yaml` du README : une
  clé inconnue est une erreur, jamais un silence.
- Logger `pino` avec redaction des secrets.
- `init` (keypair ed25519, `.env` en `600`, refus d'écrasement) et `doctor`
  (Node, config, RPC, Jupiter, soldes, base, kill-switch).
- Interface `Signer` (`EnvSigner`) prête pour un keystore ou un service distant.
- Hook de pré-commit qui refuse qu'une clé privée soit committée.

**Phase 1 — Données de marché**
- Client Jupiter typé (token bucket, backoff 429 piloté par `x-ratelimit-reset`,
  retries 5xx, parsing `zod`).
- Price v3 par lots de 50, Tokens v2 (recherche, tags, catégories, récents).
- Univers filtré (liquidité, âge, score organique, vérifié) et tri **total** :
  la watchlist est identique d'un scan à l'autre.
- `node:sqlite` avec migrations versionnées ; `watch` agrège les bougies 5m,
  15m, 1h ; l'origine des prix est tracée (`discovery` / `candle` / `import`).

**Phase 2 — Backtest**
- Import GeckoTerminal (pool de plus grande réserve USD), **idempotent**.
- Fusion à la lecture : l'import est prioritaire, le volume live conservé.
- Le backtest **rejoue le moteur réel** (mêmes stratégies, même RiskManager,
  même portefeuille FIFO, mêmes coûts).
- Un **seul** modèle de coûts pour le paper et le backtest — la parité est
  structurelle, pas une coïncidence.
- Métriques : PnL net, win rate, profit factor, Sharpe, drawdown, turnover,
  frais. Une métrique non calculable vaut `null`, jamais `0`.
- Empreinte de configuration (sha256), walk-forward, sensibilité aux coûts.

**Phase 3 — Moteur paper**
- Stratégies `trend_breakout`, `mean_reversion`, `grid`, `dca_rotation`.
- Détection de régime (trending / ranging / idle) : « ne rien faire » est une
  décision.
- RiskManager complet, dans l'ordre du README §12.1, avec rejets **chiffrés**.
- Lots FIFO, PnL réalisé et latent, NAV.
- `start --paper` : boucle de tick, arrêt propre, kill-switch fichier.

**Phase 4 — Allocateur et supervision**
- Portefeuilles fantômes : chaque stratégie joue son propre livre, avec les
  **mêmes coûts** que le capital réel.
- Score glissant, seuil d'échantillon, hystérésis **relative**.
- Garde-fou live : empreinte exacte de la configuration, couverture, fenêtres,
  PnL net, sensibilité aux coûts.
- `/healthz` et `/metrics` (registre Prometheus maison, sans dépendance).
- Telegram : notifications et commandes, un seul chat autorisé.
- Alertes à cooldown **persisté** ; backups `VACUUM INTO` + rotation +
  restauration vérifiée ; Docker et systemd.
- Laboratoire `lab/` : paper uniquement, base séparée, mise plafonnée,
  stop-loss obligatoire, prix non corroborés rejetés.

**Phase 5 — Exécution Jupiter**
- Meta-Aggregator (`/order` → signature → `/execute`) et dry-run (vrais
  devis, vraie transaction, **simulation**).
- Taxonomie d'erreurs : chaque code est classé `requote` ou `abort`.
- Réconciliation on-chain : la chaîne fait foi.
- Chemin Router (`/build`), cibles d'atterrissage `rpc` / `tx_jup` / `jito`,
  commande `paths` (A/B sur swaps réels).
- Slippage `rtse` / `adaptive` / fixe.

**Phase 6 — Dashboard**
- API REST en lecture seule + flux SSE.
- Front React / Vite / uPlot, six vues, graphiques d'équité par stratégie et
  buy & hold de référence.
- **Lecture seule vérifiée par un test** : POST, PUT, PATCH et DELETE sur
  chaque route renvoient 405.
- Rapport quotidien HTML autonome.

**Phase 7 — Intelligence**
- Walk-forward **automatisé** avec garde anti-surapprentissage (échantillon
  minimal, validation hors échantillon, plafond de dégradation, stabilité des
  paramètres, quorum de fenêtres).
- Trigger API : take-profit on-chain, déposé après l'achat.
- Keystore chiffré (AES-256-GCM + scrypt).

### Résultats — et ce qu'ils disent

Sept backtests sur 90 jours, 41 actifs, deux timeframes.

| Stratégie | PnL net | PF | Sharpe | Sensibilité aux coûts |
|---|---|---|---|---|
| `relative_strength` 1 h | +221,70 $ (+22,17 %) | 1,22 | 2,79 | ✔ |
| `mean_reversion` 1 h ×3 | +167,03 $ (+16,71 %) | 2,39 | 4,42 | ✗ |
| `mean_reversion` 1 h ×8 | +80,01 $ (+8,00 %) | 1,30 | 1,79 | ✔ |
| `trend_breakout` 1 h | +66,77 $ (+6,71 %) | 1,18 | 1,31 | ✗ |
| `regime_switch` 1 h | +50,96 $ (+5,10 %) | 1,20 | 1,14 | ✔ |
| `mean_reversion` 15 m | -18,15 $ (-1,81 %) | 1,07 | -0,27 | sans objet |
| `trend_breakout` 15 m | -71,46 $ (-7,15 %) | 0,97 | -1,44 | sans objet |

Puis le walk-forward automatisé a été passé sur les deux meilleures :

- `relative_strength` : dégradation de 79,5 %, 53,9 % et 132,1 % selon la
  fenêtre, et les paramètres retenus **changent à chaque fenêtre**.
- `mean_reversion` : 1 fenêtre validée sur 3.

**Les deux sont rejetées.** Un bon résultat sur la fenêtre complète ne vaut
rien, et le garde-fou vient de le prouver en refusant deux configurations
qui semblaient excellentes.

> **Aucune configuration n'est validée pour le live.** Le mode par défaut
> reste `paper`, et le live exige trois verrous : `confirm_live`, un backtest
> conforme au garde-fou, et une confirmation interactive.

### Ce qui reste ouvert

- Plus d'historique (6 à 12 mois) et un univers plus large : 90 jours ne
  suffisent pas à distinguer un edge d'un régime de marché.
- Service de signature distant, sous-comptes par stratégie, ordres DCA Trigger.
- Évaluation documentée de la copie de wallets (recherche seulement).

[0.7.1]: https://github.com/nikodindon/solbot-3/releases/tag/v0.7.1
[0.7.0]: https://github.com/nikodindon/solbot-3/releases/tag/v0.7.0
