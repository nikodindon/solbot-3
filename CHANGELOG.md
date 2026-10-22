# Changelog — solbot3

Toutes les versions sont datées. Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).

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

[0.7.0]: https://github.com/nikodindon/solbot-3/releases/tag/v0.7.0
