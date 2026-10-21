# Journal des expériences — solbot3

Chaque expérience (backtest, run paper, comparaison de stratégies) est consignée
ici, **y compris les échecs**. Un échec documenté vaut mieux qu'un résultat
oublié : c'est ce qui distingue une recherche d'une chasse au gain.

> Le format suit la méthode de développement d'une stratégie (README §8.4) :
> hypothèse → backtest multi-fenêtres → out-of-sample → sensibilité aux coûts
> → shadow → décision.

---

## Modèle d'entrée

```markdown
## <date> — <titre court> (label : <label>)

- **Hypothèse** : <mécanisme de marché exploité>
- **Configuration** : <empreinte / fichier de config / paramètres clés>
- **Données** : <fenêtre, mints, nombre de bougies>

| Fenêtre | PnL net | Win rate | Profit factor | Max DD | Trades |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |

- **Hors échantillon** : <PnL OOS, nombre de fenêtres>
- **Sensibilité aux coûts** : <PnL à ×1,5 / ×2, variation en %>
- **Conclusion** : <abandon | à améliorer | promu>
- **Ce qu'on a appris** : <une phrase>
```

---

## Expériences

### 2026-10-21 — `trend_breakout` par défaut, 90 jours, univers top-41 (label : `trend-default-90j`)

- **Hypothèse** : les cassures de plus hauts sur volume confirmé continuent de
  jouer, sur des tokens liquides de Solana, une fois les frais et le slippage
  déduits.
- **Configuration** : `trend_breakout` seule, paramètres par défaut
  (`ema_fast 12`, `ema_slow 26`, `breakout_lookback 20`, `rsi_max 68`,
  `volume_mult 1.5`, `atr_stop_mult 2`), `min_edge_over_costs: 3`,
  `max_position_pct: 5`, `stop_loss_pct: 8`, `take_profit_pct: 15`.
  Empreinte : `21d17382d94f4369`.
- **Données** : 90 jours, 15 m, **41 actifs** importés depuis GeckoTerminal
  (pool de plus grande réserve USD), 256 007 bougies du 2026-07-23 au
  2026-10-21. Rejeu : 8 640 ticks en **1 min 20 s**.

| Fenêtre | PnL net | Win rate | Profit factor | Max DD | Trades | Frais |
|---|---|---|---|---|---|---|
| 90 j (fenêtre unique) | **-71,46 $ (-7,15 %)** | 28,10 % | 0,97 | 15,28 % | 637 | 32,12 $ |

- **Sensibilité aux coûts** : ×1 → -71,46 $ · ×1,5 → -90,90 $ · ×2 → -153,03 $.
  La dégradation relative n'a pas de sens ici : le PnL de référence est déjà
  négatif. Le verdict de sensibilité est donc **sans objet** — ce n'est pas la
  sensibilité qui tue la stratégie, c'est le Lack of Edge lui-même.
- **Rejets par règle** : `max_positions` 4 747 · `edge_net` 292.
  Le filtre d'edge ne rejette que 6 % des signaux : le problème n'est **pas**
  le coût, c'est la qualité des signaux (profit factor 0,97 : la stratégie
  perd avant même les frais).
- **Walk-forward** (30 j, 4 fenêtres) : -13,52 $ · -18,48 $ · -65,69 $ ·
  **+20,65 $** → **1/4 fenêtres profitables**, agrégat -77,04 $.
- **Conclusion** : **abandon en l'état**. La stratégie n'est pas profitable
  hors échantillon, et une seule fenêtre sur quatre est positive — c'est le
  signe d'un bruit, pas d'un edge.

- **Ce qu'on a appris** :
  1. Un profit factor de **0,97** avec 28 % de gagnants et 637 trades sur 90
     jours, c'est **une absence d'edge**, pas une absence de profit. Le
     turnover (31,79) et les frais (32,12 $) ne font qu'aggraver la perte :
     même sans frais, la stratégie serait à peu près à l'équilibre, jamais
     positive.
  2. Le filtre d'edge net ne bite presque pas (283 rejets sur ~800 signaux) :
     avec `expectedMoveBps` calculé comme la distance à l'EMA lente, l'edge
     annoncé est presque toujours au-dessus du seuil. **Le seuil lui-même est
     mal calibré**, pas les signaux.
  3. Le stop à 8 % / take-profit à 15 % donne un ratio 1:1,87, très proche
     du seuil de rentabilité du win rate (34,9 %). Le système est donc à la
     merci de quelques points de win rate — et il n'a que 28 %.
  4. Le drawdown max (15,28 %) a touché le kill-switch (15 %) : le moteur
     s'est arrêté seul, et c'est visible dans le journal. **Le kill-switch
     fonctionne** — c'est le premier résultat positif de ce projet.
  5. L'univers complet (41 actifs) est **moins** bon que le sous-ensemble
     de 28 : -7,15 % contre -5,96 %. Les actifs les plus liquides (ceux de
     tête) ne sont pas ceux qui portent l'edge ; le bruit des small caps
     domine.

### 2026-10-21 — correction A : edge = mouvement mesuré de la cassure (label : `trend-edgeA-90j`)

- **Hypothèse** (A) : `expectedMoveBps` doit être **ce que la cassure peut
  réellement rapporter**, c'est-à-dire la hauteur de la zone de consolidation
  projetée depuis la cassure (le « mouvement mesuré »), et non la distance à
  l'EMA lente. Repli sur l'ATR si la zone est dégénérée.
- **Modification** : `src/strategies/trend-breakout.ts` — `expectedMoveBps`
  passe de `(prix − EMA lente) / EMA lente` à `(plus haut − plus bas) / plus
  bas` de la zone de consolidation.
- **Données** : identiques (41 actifs, 90 j, 15 m).

| Variante | Seuil d'edge | PnL net | Win rate | PF | DD | Trades | Rejets `edge_net` |
|---|---|---|---|---|---|---|---|
| référence | ×3 | -71,46 $ | 28,10 % | 0,97 | 15,28 % | 637 | 292 |
| **correction A** | ×3 | **-84,07 $** | 25,69 % | 0,99 | 15,51 % | 763 | 195 |
| correction A + seuil ×8 | ×8 | **-148,26 $** | 28,97 % | 0,85 | 15,02 % | 580 | **2 378** |

- **Conclusion** : **A est un échec**, et elle est instructive.
  1. La correction A **dégrade** légèrement le résultat (-8,41 % contre
     -7,15 %). Le mouvement mesuré n'est pas un meilleur prédicteur.
  2. Le filtre d'edge à ×3 **ne mord toujours pas** (195 rejets sur ~950
     signaux, soit 20 %). La hauteur d'une zone de consolidation 15 m sur ces
     actifs dépasse presque toujours le seuil de 186 bps. **Le seuil ×3 est
     structurellement inopérant à ce timeframe** : c'est une question de
     calibrage, pas de qualité de signal.
  3. Le passage à ×8 fait enfin **mordre** le filtre (2 378 rejets, et les
     rejets `max_positions` chutent de 4 905 à 61 : le portefeuille n'est plus
     saturé) — et le résultat **se dégrade encore** (-14,83 %, PF 0,85,
     Sharpe -3,53).

- **Ce qu'on a appris** :
  1. **Sur cet univers, la volatilité est inversement corrélée au résultat.**
     Le mouvement mesuré est un proxy de volatilité ; filtrer sur lui revient
     à sélectionner les actifs les plus agités — qui sont ceux qui s'effondrent
     le plus. C'est une **anti-edge mesurée**, pas une absence d'edge : c'est
     un résultat fort, et il invalide l'hypothèse A.
  2. Un filtre qui **rejette plus** ne garantit pas un meilleur résultat :
     ici il a rejeté 4 fois plus de signaux et le résultat est dégradé. Un
     filtre d'edge n'a de valeur que s'il est **corrélé** au résultat, pas
     s'il est strict.
  3. Le seuil `min_edge_over_costs` n'est pas un paramètre « à régler » :
     il faut d'abord savoir **ce qu'il doit mesurer**. Ici il mesure un
     aller-retour (frais + slippage + impact), et l'edge annoncé devrait être
     un gain *net de ce même aller-retour*. Tant que les deux ne sont pas
     exprimés dans la même unité, le filtre ne peut pas être calibré.

- **Décision** : **abandonner A** et revenir au `expectedMoveBps` initial
  (distance à l'EMA lente), qui reste une approximation honnête de l'objectif
  de la stratégie. Retenir la leçon : le filtre d'edge doit être **validé par
  le walk-forward**, jamais réglé à l'intuition.

- **Suite** : tester B (fenêtre 1 h) et C (`mean_reversion` seul), puis
  l'allocateur — c'est lui qui permettra de comparer honnêtement deux
  hypothèses opposées, ce qu'un seuil ne peut pas faire.

### Hypothèses à tester ensuite

- **B** — Tester la fenêtre 1 h au lieu de 15 m : moins de trades, moins de
  bruit, mais des stops plus larges.
- **C** — Tester `mean_reversion` seul, puis la combinaison : les deux
  stratégies ont des hypothèses opposées (tendance vs range), l'allocateur
  de la phase 4 pourrait exploiter leur complémentarité.
- **D** — Rejouer sur 3 fenêtres non chevauchantes de 30 jours, dont une
  choisie à l'avance **en perte** (le README l'exige : « dont au moins une
  en régime défavorable »).

---

## Historique des projets précédents

Cette section conserve les enseignements des deux projets dont solbot3 est
issu. Elle est volontairement hors du journal d'expériences : ce sont des
**leçons de conception**, pas des résultats reproductibles ici.

### Ce que solbot (v1) a bien fait

- L'architecture : moteur pluggable, RiskManager qui a le dernier mot, backtest
  qui rejoue le **même** moteur que le live.
- Le garde-fou « pas de live sans backtest concluant », lié à l'empreinte
  exacte de la configuration.
- La réconciliation on-chain au démarrage (la chaîne fait foi).
- Le path Router (`/build`) complet, avec landing RPC / tx.jup / Jito, et la
  mesure A/B avant tout changement de défaut.

### Ce que solbot (v1) a mal fait

- `max_slippage_bps` et `confirm_timeout_s` étaient configurés mais **jamais
  appliqués** au code d'exécution.
- Le RiskManager et l'ingénieur ne partageaient pas la même définition du
  kill-switch (l'un depuis le pic d'équité, l'autre depuis le capital initial).
- Constantes dupliquées (frais de base SOL, fonction d'impact, médiane) et
  code mort (`ttlMs`, `allowAdd`, `trailing_stop_price`, table
  `reconciliation`).
- Le dashboard recalculait tout l'état à chaque broadcast SSE.

### Ce que solbot2 (v2) a bien fait

- La détection de régime par actif et les **portefeuilles fantômes** avec
  allocation par hystérésis.
- Le filtre d'edge net (`edge ≥ 3 × coûts aller-retour`) et le journal des
  rejets **chiffrés** (« edge 38 bps < seuil 3×coûts 45 bps »).
- La traçabilité de l'origine des prix (`price_ticks.src`) : un prix sans
  source fiable ou trop ancien ne peut pas décider.
- Le **catalogue de garde-fous anti-fiction** de `maxscalp` : prix de vente
  frais, clamp entrée×20, réconciliation discovery-vs-candle, anti-fausse-pompe,
  dépréciation sur prix inconnu, blacklist par ticker, verrou « mauvaise
  journée ». C'est la pièce la plus transférable de tout le dépôt.

### Ce que solbot2 (v2) a mal fait

- Le backtest était **optimiste par construction** : `fill_slippage_bps: 0`
  alors que le paper en modélisait 20. La parité backtest/paper était donc
  cassée à la source.
- Le pricing au moment de la clôture uniquement : les mèches (wicks) qui
  déclenchent stops et take-profits n'étaient pas modélisées.
- La liquidité supposée statique, sans aucune mention dans les rapports.
- La stratégie « seule stratégie allouée a le droit de trader » : simple, mais
  fragile — un changement d'allocation coupe instantanément l'accès au capital.

### Ce que solbot3 corrige

| Défaut v1/v2 | Correction v3 |
|---|---|
| Kill-switch défini deux fois | Une seule définition, partagée par l'engine et le RiskManager |
| Coûts de backtest ≠ coûts de paper | Le même `CostModel` dans les deux, avec sensibilité ×1,5 / ×2 |
| Prix sans origine | `require_price_source` : une décision refuse un prix sans source acceptée |
| Mèches ignorées | Modélisation intra-bougie (phase 2) |
| Liquidité supposée statique | Limites du backtest **écrites et chiffrées** dans chaque rapport (§9.5) |
| Constantes dupliquées | Un seul module `constants.ts`, une seule fonction d'impact |
| `noUncheckedIndexedAccess` partout | Désactivé : `strict` reste, le bruit disparaît |
| Code mort | Interdit par `noUnusedLocals` / `noUnusedParameters` + ESLint |
