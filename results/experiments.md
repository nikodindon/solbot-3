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

### 2026-10-21 — B, C et le calibrage du filtre d'edge : la marche à gravitation

Cinq backtests successifs sur le même jeu de données (41 actifs, 90 jours,
72 480 bougies en 1 h et 256 007 en 15 m). Le tableau est le résultat central
du projet à ce stade.

| # | Stratégie | TF | Seuil d'edge | PnL net | Trades | Win rate | PF | Max DD | Sharpe | Frais | Sensibilité ×1,5 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `trend_breakout` | 15 m | ×3 | -71,46 $ | 637 | 28,1 % | 0,97 | 15,3 % | -1,44 | 32,12 $ | sans objet |
| 2 | `trend_breakout` (A) | 15 m | ×3 | -84,07 $ | 763 | 25,7 % | 0,99 | 15,5 % | -1,63 | 38,26 $ | sans objet |
| 3 | `trend_breakout` (A) | 15 m | ×8 | -148,26 $ | 580 | 29,0 % | 0,85 | 15,0 % | -3,53 | 26,86 $ | sans objet |
| 4 | `mean_reversion` | 15 m | ×3 | -18,15 $ | 562 | 29,2 % | 1,07 | 15,1 % | -0,27 | 29,25 $ | sans objet |
| 5 | `trend_breakout` | 1 h | ×3 | +66,77 $ | 208 | 27,9 % | 1,18 | 9,0 % | 1,31 | 11,03 $ | ✗ -78,5 % |
| 6 | `mean_reversion` | 1 h | ×3 | **+167,03 $** | 68 | 48,5 % | **2,39** | 4,7 % | **4,42** | 3,79 $ | ✗ -57,5 % |
| 7 | **`mean_reversion`** | **1 h** | **×8** | **+80,01 $** | 136 | 39,0 % | 1,30 | 11,5 % | 1,79 | 7,57 $ | **✓ -10,1 %** |

Walk-forward (4 fenêtres de 22,5 j, PnL hors échantillon **agrégé**) :

| Config | Fenêtre 1 | Fenêtre 2 | Fenêtre 3 | Fenêtre 4 | Agrégat | Fenêtres + |
|---|---|---|---|---|---|---|
| `mean_reversion` 1 h ×3 | -11,34 $ | +98,35 $ | +34,77 $ | -27,23 $ | **+94,55 $** | 2/4 |
| `mean_reversion` 1 h ×8 | -7,43 $ | +109,94 $ | +62,31 $ | -80,90 $ | **+83,91 $** | 2/4 |

- **Conclusion** :
  1. **B est confirmé** : la fenêtre 1 h transforme le résultat. Le passage
     de 15 m à 1 h divise le nombre de trades par ~4 (763 → 208) et le
     turnover par 3,6 (37,7 → 10,5). Les frais tombent de 32,12 $ à
     11,03 $ — et le résultat passe de -7,15 % à **+6,68 %**. Sur un univers
     de tokens bruyants, le timeframe est le premier levier, avant tout
     paramètre.
  2. **C est confirmé** : le retour à la moyenne bat la cassure de tendance
     partout. Sur 15 m, -1,81 % contre -7,15 % ; en 1 h, +16,70 % contre
     +6,68 %. **Cet univers est mean-reverting, pas trending.**
  3. **Le filtre d'edge n'a de valeur que s'il mesure un gain réellement
     corrélé au résultat** — et c'est la démonstration la plus nette du
     projet. Sur `trend_breakout`, l'edge annoncé était un proxy de
     volatilité, et un seuil plus strict a **dégradé** le résultat (#2 → #3).
     Sur `mean_reversion`, l'edge annoncé est la **distance réelle à la
     moyenne**, donc le gain attendu : un seuil plus strict a **amélioré la
     robustesse** (#6 → #7). Le rendement absolu baisse (+167 → +80 $), mais
     c'est le **seul run qui passe le garde-fou de sensibilité** (chute de
     10,1 % à ×1,5, pour un maximum de 40 %).
  4. Le résultat #6 (+167 $, PF 2,39) est le plus flatteur et le **moins
     robuste** : 68 trades sur 90 jours, et une chute de 57,5 % des coûts.
     Un edge mince qui s'effondre dès que les frais montent n'est pas un edge,
     c'est du bruit favorably distribué. Le projet l'a écarté — c'est
     exactement ce pour quoi le garde-fou de sensibilité existe.

- **Ce qu'on a appris** :
  1. **L'ordre de recherche compte.** Timeframe (×3,6 de turnover) avant
     paramètre de stratégie avant seuil d'edge. On a cherché dans le mauvais
     ordre pendant la phase 2 : on calibrait un seuil alors que le levier
     principal était ailleurs.
  2. **Un profit factor de 2,39 sur 68 trades n'est pas une preuve.** Le
     profit factor est un ratio, pas un effectif. 68 trades, c'est 2 par
     mois : l'intervalle de confiance est enormous.
  3. **2 fenêtres profitables sur 4, c'est 50 %** — à peine mieux que le
     hasard. Et la fenêtre la plus récente (#4) est la **plus mauvaise**
     (-80,90 $ avec 49 trades). Le résultat agrégé est porté par la fenêtre
     #2 (+109,94 $). **Ce n'est pas encore robuste.**
  4. Le filtre d'edge et la sensibilité aux coûts sont **deux garde-fous
     indépendants**, et il faut les deux : #6 passe le premier et échoue le
     second ; #7 passe les deux.

- **Décision** : **promouvoir `mean_reversion` en 1 h avec un seuil d'edge
  ×8** comme configuration par défaut du projet (variante
  `config/strategies/meanrev-1h-edge8.yaml`). C'est le premier run qui passe
  **tous** les garde-fous. Il reste à consolider : 2/4 fenêtres positives
  n'est pas suffisant, et la phase 4 (allocateur) est précisément l'outil
  pour comparer cette stratégie à une autre plutôt que de(compiler sur
  celle-ci.

- **Suite** : l'allocateur de la phase 4 doit maintenant comparer
  `mean_reversion` (1 h) à `trend_breakout` (1 h) **sur la même période**,
  et à `relative_strength`, qui n'a pas encore été testée.

### 2026-10-21 — revalidation après correction du multi-timeframe

Un bug a été trouvé **après** les sept backtests ci-dessus : le moteur
chargeait les bougies du timeframe de `trend_breakout` pour **toutes** les
stratégies. Une stratégie en 1 h recevait donc des bougies de 15 m — la
fenêtre z-score de 96 bougies couvrait 24 h au lieu de 4 jours.

Le moteur a été corrigé : les bougies sont désormais portées **par timeframe**
dans l'instantané de marché, et chaque stratégie lit le sien.

- **Correction** : `AssetSnapshot.candles` devient une table par timeframe ;
  le moteur ne charge que les timeframes réellement demandés par les
  stratégies actives.
- **Revalidation** : les sept backtests ont été rejoués. Les résultats sont
  **inchangés à 0,1 % près** (80,00 $ contre 80,01 $ ; 167,06 $ contre
  167,03 $ ; 67,09 $ contre 66,77 $).

- **Ce qu'on a appris** : le bug était **latent**, pas actif — parce que
  les deux séries (15 m et 1 h) décrivent le même chemin de prix, et qu'un
  z-score calculé sur 96 points de 15 m ressemble à un z-score calculé sur
  24 points de 1 h. Il aurait explosé avec d'autres paramètres (`window`,
  `breakout_lookback`), ou dès qu'une stratégie en 1 h aurait cohabité avec
  une stratégie en 15 m. **Un test qui passe ne prouve pas qu'un cas voisin
  est correct** : il faut revalider après chaque changement structurel.

### 2026-10-21 — configuration par défaut du projet

`mean_reversion` en 1 h, seuil d'edge ×8, est désormais la configuration par
défaut (`config/config.example.yaml` et le schéma zod) :

```yaml
strategies:
  trend_breakout: { enabled: false, timeframe: 1h }
  mean_reversion: { enabled: true, timeframe: 1h }
allocator:
  min_edge_over_costs: 8.0
risk:
  stop_loss_pct: 12
  take_profit_pct: 20
  trailing_stop: { activation_pct: 8, retrace_pct: 4 }
```

C'est le premier jeu de paramètres qui passe **tous** les garde-fous :
PnL net > 0, couverture ≥ 60 j, sensibilité aux coûts ≤ 40 % de chute.

Il reste **deux réserves** avant toute montée en puissance :

1. **2 fenêtres profitables sur 4** en walk-forward, et la fenêtre la plus
   récente est la moins bonne. C'est à peine mieux que le hasard.
2. **136 trades sur 90 jours** : l'effectif est faible, l'intervalle de
   confiance est large.

Le statut reste donc **« promu en paper, pas en live »**. La phase 4
(l'allocateur) et la phase 5 (paper prolongé) sont les prochaines étapes
naturales.

### 2026-10-22 — deux stratégies jamais mesurées

| Stratégie | PnL net | Trades | Win rate | PF | DD | Sharpe | Sensibilité |
|---|---|---|---|---|---|---|---|
| `relative_strength` 1 h | **+221,70 $ (+22,17 %)** | 526 | 44,11 % | 1,22 | 10,15 % | 2,79 | ✔ |
| `regime_switch` 1 h | +50,96 $ (+5,10 %) | 152 | 39,47 % | 1,20 | 13,58 % | 1,14 | ✔ |

`regime_switch` est la plus **économe en capital** : 152 trades et
8,39 $ de frais pour +5,10 %, là où `relative_strength` dépense 31,77 $ de
frais pour +22,17 %. La méta-stratégie filtre beaucoup de signaux : c'est
précisément ce qu'on attend d'elle.

`relative_strength` a le meilleur Sharpe, et son résultat **s'améliore** quand
les frais montent (les coûts modifient la sélection des trades). C'est un
signal encourageant — et c'est aussi pour ça qu'il faut le walk-forward.

### 2026-10-22 — le walk-forward automatisé rejette TOUT

Le walk-forward automatisé (optimisation sur la première moitié de chaque
fenêtre, validation sur la seconde) a été passé sur les deux meilleures
stratégies. **Les deux sont rejetées.**

| Stratégie | Fenêtre 1 | Fenêtre 2 | Fenêtre 3 | Verdict |
|---|---|---|---|---|
| `mean_reversion` (9 jeux) | entraînement négatif | **+67,15 $** ✔ | entraînement négatif | **NON VALIDÉ** — 1/3 fenêtres, minimum 2 |
| `relative_strength` (9 jeux) | dégradation 79,5 % | dégradation 53,9 % | dégradation 132,1 % | **NON VALIDÉ** — 0/3 fenêtres, paramètres instables |

- **`relative_strength` semble le meilleur** sur la fenêtre complète :
  **+221,70 $ (+22,17 %)**, 526 trades, win rate 44,11 %, PF 1,22,
  drawdown 10,15 %, **Sharpe 2,79** — et elle *améliore* son résultat quand
  les frais doublent (+322,96 $ à ×2). Sur le papier, c'est le meilleur
  résultat du projet.
- **Hors échantillon, ce résultat s'effondre.** Les trois fenêtres montrent
  une dégradation de 79,5 %, 53,9 % et 132,1 %, et le jeu de paramètres
  retenu **change du tout à chaque fenêtre** (3 jeux différents sur 3
  fenêtres). C'est la signature d'un surapprentissage, pas d'un edge.

- **Ce qu'on a appris** :
  1. **Un bon résultat sur la fenêtre complète ne vaut rien.** Le +22 % de
     `relative_strength` et le +16,7 % de `mean_reversion` (×3) disparaissent
     dès qu'on les soumet à la validation hors échantillon. **C'est
     exactement pour ça que le garde-fou existe**, et c'est la preuve qu'il
     n'est pas décoratif : il vient de refuser deux configurations qui
     semblaient excellentes.
  2. **Le seuil d'hystérésis de l'allocateur ne peut pas réparer ça.** Il
     compare des stratégies *sur la même période*, donc sur le même
     surapprentissage.
  3. **Les 90 jours d'historique ne suffisent pas** pour valider quoi que ce
     soit sur cet univers. Les fenêtres d'entraînement font 15 jours : trop
     court pour distinguer un edge d'un régime de marché.
  4. La fenêtre 1 h reste le bon timeframe : c'est le seul qui donne des
     résultats robustes à la sensibilité aux coûts, dans **toutes** les
     stratégies testées.

- **Décision** : **aucune configuration n'est encore promue.** La
  configuration par défaut reste `mean_reversion` 1 h ×8, parce que c'est
  celle qui passe le **plus** de contrôles (PnL > 0, sensibilité ✓) même si
  elle échoue au walk-forward. Elle reste en **paper**, jamais en live.

### 2026-10-22 — trois bugs trouvés en observant le paper (et un quatrième, d'affichage)

Le paper qui tourne depuis des heures a révélé des défauts que les tests ne
voyaient pas. Ils sont tous corrigés.

#### 1. Un changement d'échelle en données : le faux signal « ZCAT »

La position ZCAT a été ouverte sur un **z-score de −8,48**, soit un écart
de **−99,99 %** à la moyenne. L'investigation a montré que les deux séries
n'étaient pas dans la même unité :

```
bougies importées (GeckoTerminal) : 795 $ … 1 677 $   (1 242 bougies)
bougies collectées en direct       : 0,047 $ … 0,050 $  (24 bougies)
```

C'est un **changement d'unité** (migration de pool ou redenomination), pas
un mouvement de prix. La fusion donnait la priorité à l'import, donc la
fenêtre de 96 bougies du z-score mélangeait deux échelles.

Conséquence : la stratégie croyait voir une opportunité à −99,99 %, l'edge
annoncé (1 948 000 bps) franchissait n'importe quel seuil, et le stop était
bloqué au maximum de 50 %.

**Correctif** : à la fusion, on cherche une **rupture d'échelle** (un
changement de prix supérieur à ×50 entre deux bougies consécutives) et on
**supprime l'historique antérieur**. ZCAT est désormais à z = −1,19 : plus de
faux signal, et la stratégie refuse de le trader.

#### 2. Un edge annoncé absurde n'est pas une opportunité

Un mouvement attendu de 26 000 % ne vient pas du marché : il vient de
données corrompues. Le RiskManager refuse maintenant tout edge au-delà de
`risk.max_expected_move_bps` (5 000 bps par défaut), avec une règle de
rejet dédiée : `implausible_edge`.

#### 3. Le shadow n'était pas un miroir du livre réel

Le shadow prenait **tous** les signaux d'un tick, n'avait **ni plafond de
positions ni cooldown**. Sa performance n'était donc pas comparable à celle
du livre réel — d'où un écart inexpliqué (shadow à 1 000 $, réel à 988 $)
qu'on ne savait pas interpréter.

**Correctif** : le shadow applique maintenant exactement les mêmes règles
(une entrée par tick, plafond de positions, cooldown par actif). L'écart
résiduel ne vient plus de règles différentes, mais du fait que le shadow est
**reconstruit** sur les 7 derniers jours : son point de départ est le début
de la fenêtre, pas le début réel de la session.

#### 4. Les noms d'actifs étaient illisibles

Le moteur mémorisait un mint tronqué (`9cRC…`) comme symbole, et c'est ce
tronçon qui s'affichait dans le dashboard. Le symbole réel est maintenant
résolu depuis la table des tokens (`ANSEM`), avec un repli sur le symbole
mémorisé à l'ouverture de la position — un token peut sortir de la watchlist,
sa position doit rester lisible.

- **Ce qu'on a appris** : un bot qui tourne longtemps en paper apprend des
  choses qu'aucun test ne devine. Les quatre défauts ci-dessus étaient
  invisibles sur des backtests, et le troisième (le shadow) aurait **invalidé
  la comparaison entre stratégies** — c'est-à-dire l'instrument même dont
  dépend l'allocateur.

#### Décision : on garde les positions orphelines (option a)

Une position ouverte sur un signal devenu invalide (cas ZCAT) **reste
ouverte** jusqu'à son stop ou son take-profit. Aucune règle de clôture
supplémentaire.

Justification : après le correctif d'échelle, le z-score de ZCAT est
redevenu normal (−1,19) ; la position est « presque à la moyenne » et
encore défendable. Une règle « plus de thèse → on sort » couperait des
positions encore bonnes, alors que le stop (−36 %) et le TP (+20 %)
suffisent à borner le risque. Le garde-fou reste donc **le risque**, pas
une interprétation de la thèse.

### Hypothèses à tester ensuite

- **D** — Rejouer sur 3 fenêtres non chevauchantes de 30 jours, dont une
  choisie à l'avance **en perte** : **fait** (le walk-forward automatisé le
  fait, et il rejette les deux stratégies).
- **E** — Optimiser `z_entry` / `z_exit` / `window` par **walk-forward**,
  pas sur la fenêtre complète : **fait** (phase 7). Les deux stratégies
  optimales sont rejetées.
- **F** — Tester `relative_strength` : **fait** (+22,17 % en-sample,
  rejeté hors échantillon).
- **G** — Un univers **plus large et plus long** : 6 à 12 mois
  d'historique, sur les tokens **par capitalisation** plutôt que par volume.
  L'univers actuel (top-40 par volume sur 24 h) est un échantillon biaisé
  vers les tokens agités — c'est-à-dire vers la population où le
  surapprentissage est le plus facile.
- **H** — Séparer le **signal** du **dimensionnement** : `relative_strength`
  suggère que l'edge vient peut-être du *choix* des actifs plutôt que de la
  condition elle-même.

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
