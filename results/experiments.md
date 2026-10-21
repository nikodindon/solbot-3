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

_Aucune expérience pour l'instant. La première entrée sera le backtest de
`trend_breakout` sur 90 jours, en phase 2._

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
