# Stratégies — solbot3

## Contrat

Une stratégie est **pure** : elle observe un instantané de marché et un
portefeuille, et rend des signaux. Elle ne touche jamais au risque ni à
l'exécution.

```ts
interface Strategy {
  readonly name: string;
  readonly requires: DataRequirement[]; // bougies, prix, liquidité, régime
  evaluate(snapshot: MarketSnapshot, portfolio: PortfolioView): Signal[];
}

interface Signal {
  assetMint: string;
  side: "buy" | "sell";
  confidence: number;        // 0..1
  expectedMoveBps: number;   // mouvement attendu, avant coûts
  ttlMs: number;             // durée de validité
  reason: string;            // journalisé tel quel
  stopLossPct?: number;
  sellPortion?: number;      // 0..1, défaut 1
  allowAdd?: boolean;
  suggestedSizeUsd?: number; // plafond indicatif ; le RiskManager tranche
  tags?: string[];           // ex. ['regime:trending']
}
```

Chaque stratégie est évaluée **seule**, puis confrontée aux autres via
l'allocateur. Une stratégie ne peut jamais placer un ordre directement.

## Catalogue

| Stratégie | Hypothèse de marché | Signaux | Régime cible | Statut |
|---|---|---|---|---|
| **trend_breakout** | Les cassures de plus hauts sur volume confirmé continuent | Achat sur cassure + EMA haussière + RSI sous seuil ; sortie sur EMA inverse | trending | ⬜ phase 3 |
| **mean_reversion** (z-score) | Un écart important à la moyenne revient | Achat si z ≤ −z_entry ; sortie si z ≥ −z_exit | ranging | ⬜ phase 3 |
| **grid** | Un actif oscille dans une fourchette | Achats par paliers sous l'ancre ; sortie à l'ancre | ranging | ⬜ phase 3 |
| **dca_rotation** | Un portefeuille cible se rééquilibre mieux qu'il ne se laisse dériver | Achat de la cible sous-allouée, allègement de la sur-allouée | tous | ⬜ phase 3 |
| **relative_strength** | Les actifs les plus forts sur 24 h restent forts quelques heures | Classement cross-sectionnel, achat du top N, rééquilibrage périodique | trending | ⬜ phase 4 |
| **regime_switch** | Chaque régime demande une stratégie différente | Route vers trend_breakout en trending, mean_reversion/grid en ranging, rien en idle | tous | ⬜ phase 4 |
| **memecoin_scalp** | Quelques listings récents font des mouvements très rapides | Entrée sur liquidité neuve, sorties par paliers | — | 🧪 laboratoire, paper, désactivé |

## Méthode de développement d'une stratégie

1. **Hypothèse écrite** : quel mécanisme de marché est exploité, et pourquoi il
   devrait persister.
2. **Implémentation** avec tests unitaires sur des séries synthétiques connues.
3. **Backtest** sur au moins 3 fenêtres de 30 jours minimum, dont au moins une
   en régime défavorable.
4. **Validation out-of-sample** : paramètres choisis sur une fenêtre, évalués
   sur une autre non vue.
5. **Sensibilité aux coûts** : rejeu avec des coûts × 1,5 et × 2.
6. **Shadow** en paper pendant au moins 2 semaines, en parallèle des autres
   stratégies.
7. **Décision** : abandon, amélioration ou promotion vers le live. Chaque
   décision est consignée dans [`../results/experiments.md`](../results/experiments.md).

> Un résultat positif sur une seule fenêtre est considéré comme **non
> concluant**. Une stratégie qui gagne sur un mois peut perdre sur le suivant.

## Fiches strategies

Une fiche par stratégie, à remplir au fil de l'eau. Le format reprend la
méthode ci-dessus.

### trend_breakout

- **Hypothèse** : *à compléter*
- **Paramètres par défaut** : `ema_fast 12`, `ema_slow 26`, `breakout_lookback 20`,
  `rsi_period 14`, `rsi_max 68`, `volume_mult 1.5`, `atr_stop_mult 2.0`
- **Régime cible** : `trending`
- **Statut** : ⬜ à développer
- **Résultat du backtest** : *à compléter*
- **Conclusion** : *à compléter*

### mean_reversion

- **Hypothèse** : *à compléter*
- **Paramètres par défaut** : `window 96`, `z_entry 2.0`, `z_exit 0.5`
- **Régime cible** : `ranging`
- **Statut** : ⬜ à développer
- **Résultat du backtest** : *à compléter*
- **Conclusion** : *à compléter*

### grid

- **Hypothèse** : *à compléter*
- **Paramètres par défaut** : `step_pct 1.0`, `levels 5`
- **Régime cible** : `ranging`
- **Statut** : ⬜ à développer
- **Résultat du backtest** : *à compléter*
- **Conclusion** : *à compléter*

### dca_rotation

- **Hypothèse** : *à compléter*
- **Paramètres par défaut** : `target_alloc { SOL: 0.4, USDC: 0.6 }`,
  `drift_trigger_pct 5`, `topup_usdc 25`
- **Régime cible** : tous
- **Statut** : ⬜ à développer
- **Résultat du backtest** : *à compléter*
- **Conclusion** : *à compléter*

### relative_strength

- **Hypothèse** : *à compléter*
- **Paramètres par défaut** : `lookback_h 24`, `top_n 3`, `rebalance_h 6`
- **Régime cible** : `trending`
- **Statut** : ⬜ à développer
- **Résultat du backtest** : *à compléter*
- **Conclusion** : *à compléter*

### regime_switch

- **Hypothèse** : *à compléter*
- **Paramètres par défaut** : aucun
- **Régime cible** : tous
- **Statut** : ⬜ à développer
- **Résultat du backtest** : *à compléter*
- **Conclusion** : *à compléter*

## Le laboratoire (`lab/`)

Les stratégies à fort risque (scalping de mèmes, loterie sans stop) ne sont
**jamais** dans le moteur principal. Elles vivent dans `lab/`, avec :

- une base SQLite séparée, un dashboard séparé et un mode **paper uniquement**
  codé en dur ;
- une limite de mise par lot (1 $ par défaut) et un capital initial séparé ;
- un **stop-loss obligatoire** dans la configuration par défaut. Une variante
  sans stop ne peut être activée qu'avec un drapeau explicite
  `lab.allow_no_stop: true`, qui écrit un avertissement dans chaque rapport ;
- un contrôle anti-manipulation : aucun prix issu d'une seule bougie ou d'une
  seule source n'est accepté pour valoriser une position ;
- un journal d'expériences versionné dans
  [`../results/experiments.md`](../results/experiments.md).

### Garde-fous anti-fiction hérités de solbot2

Ces règles ont été apprises sur des runs réels de scalping de mèmes. Elles
seront généralisées au moteur principal :

- un prix de vente n'est accepté que s'il est **frais** (< 5 min) ;
- un prix de vente ne peut jamais dépasser **20 × le prix d'entrée** ;
- un prix OHLCV supérieur à **4 × le dernier prix liquide connu** est traité
  comme une citation de pool « mule » : la vente est clampée au dernier prix
  fiable ;
- un actif sans aucun prix connu est déprécié à 50 % du coût ;
- un ticker déjà ruiné est **blacklisté** par nom, pas seulement par mint ;
- après une série de pertes, les entrées sont suspendues (les sorties
  continuent).
