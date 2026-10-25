# solbot3 — Guide d'utilisation rapide

> Guide pratique : installer, lancer, comprendre, dépanner. La spécification
> complète est dans le [README](../README.md), la vue non technique dans la
> [présentation](presentation.md).

**Durée de lecture : 5 minutes. Première session : ~15 minutes.**

---

## 1. Ce qu'il faut

| | |
|---|---|
| **Node.js** | ≥ 22.5 (le `node:sqlite` intégré est utilisé) |
| **npm** | ≥ 10 |
| **Clé API Jupiter** | gratuite sur <https://developers.jup.ag/portal> — sans elle, le débit est limité à 0,5 req/s |
| **URL RPC Solana** | `https://api.mainnet-beta.solana.com` suffit pour le paper |
| **Clé GeckoTerminal** | uniquement pour l'import d'historique (backtest) |
| **Argent** | **rien du tout** pour le paper |

---

## 2. Installation

```bash
git clone https://github.com/nikodindon/solbot-3.git
cd solbot-3
npm ci

cp .env.example .env
cp config/config.example.yaml config/config.yaml
```

Puis renseignez `.env` :

```dotenv
JUPITER_API_KEY=votre_clé_jupiter
GECKO_API_KEY=CG-...          # seulement si vous voulez/backtester
```

> `.env` est **ignoré par Git** et contient votre clé Jupiter. Ne le committez
> jamais. Le hook de pré-commit bloque de toute façon les clés privées.

---

## 3. Premier lancement

```bash
npm run solbot3 -- init      # génère le wallet, écrit .env en chmod 600
npm run solbot3 -- doctor    # vérifie tout l'environnement
npm run solbot3 -- scan      # construit la liste de suivi (les tokens à trader)
```

`init` affiche l'adresse du wallet. **Notez-la** : c'est elle que vous
financerez plus tard. La clé privée n'apparaît jamais dans les logs.

`doctor` doit afficher une ligne verte partout. En cas de problème, il dit
lequel.

`scan` interroge Jupiter pour construire la liste de tokens à suivre. Sans
lui, le bot ne suit que SOL et USDC — ce qui est un comportement
volontairement prudent, mais pas très intéressant. La liste est **stable**
d'un scan à l'autre : le même univers à chaque fois, c'est ce qui rend les
backtests comparables.

> **Vous n'avez pas besoin de financer le wallet pour le paper.** Le mode paper
> utilise un portefeuille **virtuel**. Ne financez que le jour où vous
> passerez en dry-run ou en live.

---

## 4. Lancer le bot (mode paper)

```bash
npm run solbot3 -- start --paper
```

C'est le mode normal. Le bot :

- interroge Jupiter toutes les 30 s ;
- construit ses bougies et sa liste de suivi ;
- **ne place aucun ordre réel** ;
- écrit chaque décision dans la base.

Dans un autre terminal :

```bash
npm run solbot3 -- dashboard     # http://127.0.0.1:4200
```

Pour l'arrêter : `Ctrl+C` (l'arrêt est propre, le tick en cours se termine).

### Options utiles

| Option | Effet |
|---|---|
| `--interval 15` | un tick toutes les 15 s au lieu de 30 |
| `--duration 3600` | s'arrête au bout d'une heure |
| `--once` | un seul tick puis sortie (utile pour un diagnostic) |

---

## 5. Le tableau de bord

`http://127.0.0.1:4200` — six onglets :

| Onglet | Ce que vous y regardez |
|---|---|
| **Vue d'ensemble** | NAV, PnL, drawdown, frais, courbe d'équité, référence buy & hold |
| **Stratégies** | la performance de chaque stratégie en shadow, et laquelle pilote |
| **Positions** | ce que vous détenez, valorisé, avec les stops |
| **Trades** | chaque exécution, avec ses frais et son PnL |
| **Décisions** | **le journal** : pourquoi le bot a fait ou n'a pas fait quelque chose |
| **Données** | fraîcheur des prix, couverture des bougies |

Le dashboard est **en lecture seule** : aucune route n'accepte d'écriture
(vérifié par un test). Le jeton `DASHBOARD_TOKEN` dans `.env` le protège si
vous l'exposez au réseau.

> L'onglet **Décisions** est le plus utile. Quand une position s'ouvre, vous
> y lisez la raison exacte, et le motif exact d'un refus.

**Ce que mesurent les chiffres.** Le **PnL** et la **référence buy & hold SOL**
partent tous les deux du **premier point de la courbe d'équité**, c'est-à-dire
du début du run : même origine, même période, les deux sont donc comparables.
Le graphique, lui, n'affiche que les **2 000 derniers points** (≈ 42 h) pour
rester lisible — c'est une limite d'affichage, pas une limite de mesure. Si
les deux courbes ne démarrent pas au même endroit, c'est que le NAV a été
tranché en cours de route et que vous regardez une fenêtre plus courte que
celle de la référence.

---

## 6. Tester une stratégie (c'est le cœur du projet)

### 6.1 Importer l'historique

```bash
npm run solbot3 -- backtest import --days 90
```

Récupère 90 jours de bougies 15 min depuis GeckoTerminal (pool de plus grande
réserve USD de chaque token). C'est long (~10 min pour 41 actifs) et
**idempotent** : relancer ne refait pas le travail déjà fait.

### 6.2 Rejouer

```bash
npm run solbot3 -- backtest run --days 90 --label ma-strategie
```

Affiche le PnL, le win rate, le profit factor, le Sharpe, le drawdown, les
frais, **et la sensibilité aux coûts** (le résultat survit-il à des frais
50 % plus élevés ?).

### 6.3 Le test qui compte

```bash
npm run solbot3 -- backtest optimize --days 90 --windows 3 --timeframe 1h
```

Optimise les paramètres sur la première moitié de chaque fenêtre, **valide
sur la seconde**, et rejette ce qui ne survit pas. C'est le seul chiffre
qui compte.

### 6.4 Comparer à la window glissante

```bash
npm run solbot3 -- backtest walk-forward --days 90 --windows 4
```

### 6.5 Changer de configuration

Les variantes serangent dans `config/strategies/`. Pour en tester une :

```bash
npm run solbot3 -- backtest run --days 90 --label rs \
  --config config/strategies/relative-strength.yaml
```

### 6.6 Lire les résultats

| Colonne | Comment la lire |
|---|---|
| **PnL net** | après tous les frais. C'est le seul chiffre qui compte. |
| **Profit factor** | gains ÷ pertes. > 1,2 = prometteur ; < 1 = à jeter. |
| **Win rate** | seul, il ne dit rien. C'est le *rapport* gains/pertes qui compte. |
| **Max drawdown** | la perte maximale depuis le sommet. C'est ce que vous devez pouvoir encaisser. |
| **Sensibilité aux coûts** | si le résultat s'effondre quand les frais montent, il n'existe pas. |
| **Trades** | peu de trades = échantillon mince. 13 trades ne concluent rien. |

> **Règle d'or** : un résultat flatteur sur la fenêtre complète ne vaut
> rien tant qu'il n'a pas survécu au walk-forward. Voir
> [`results/experiments.md`](../results/experiments.md) — les deux meilleures
> stratégies du projet ont été rejetées par ce test.

---

## 7. Piloter le bot à distance (Telegram)

Renseignez dans `.env` :

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

et activez :

```yaml
notifications:
  telegram:
    enabled: true
```

Commandes (un seul chat est autorisé) :

| Commande | Effet |
|---|---|
| `/status` | état du bot, NAV, positions, kill-switch |
| `/positions` | positions ouvertes |
| `/pnl 7` | PnL des 7 derniers jours |
| `/pause` | suspend les **entrées** (les sorties continuent) |
| `/resume` | reprend les entrées |
| `/kill` | **kill-switch** : plus aucune entrée |
| `/help` | la liste |

> `/kill` écrit un **fichier** (`data/STOP`) : il survit au redémarrage. C'est
> la commande à connaître le jour où le bot fait n'importe quoi.

---

## 8. Journal et rapports

```bash
npm run solbot3 -- report --days 30              # métriques en console
npm run solbot3 -- report --days 30 --html       # + un rapport HTML autonome
npm run solbot3 -- parity --days 30             # paper vs backtest
```

`parity` compare le paper et le backtest sur la même période et décompose
l'écart (coûts, timing, décisions). **Un écart inexpliqué est un signal
d'alerte** : soit le backtest est trop optimiste, soit le paper est mal
branché.

Le rapport HTML est un **fichier unique** dans `data/reports/`, ouvrable dans
un navigateur, sans dépendance — pratique le matin.

### Entretien du journal

Le journal de décisions grossit vite : c'est la table la plus écrite du
projet (une à deux lignes par actif et par tick).

```bash
npm run solbot3 -- maintenance --plan   # combien de doublons ? (rien n'est touché)
npm run solbot3 -- maintenance          # supprime les doublons puis compacte
npm run solbot3 -- maintenance --no-vacuum  # sans la compaction
```

Les doublons sont des **copies exactes** (la même phrase écrite par le
portefeuille fantôme et par le livre réel) : la suppression ne perd rien.
Le `VACUUM` réécrit la base sans ses pages libérées et demande un accès
exclusif — **arrêtez le bot et le dashboard avant** : sinon la commande
échoue et le message vous le dit, au lieu de forcer. Une fois par semaine
suffit.

---

## 9. Sauvegardes

```bash
npm run solbot3 -- backup            # crée une sauvegarde
npm run solbot3 -- backup --list     # liste
```

Copies `VACUUM INTO` (cohérentes même pendant que le bot écrit), rotation
automatique, restauration vérifiée par `PRAGMA integrity_check`. Une
sauvegarde quotidienne est automatique.

> **Arrêtez le bot avant de restaurer.** Le fichier est remplacé, et une
> connexion ouverte en WAL verrait une base incohérente.

---

## 10. Les modes qui engagement de l'argent

### Dry-run — vrais devis, aucune envoi

```bash
npm run solbot3 -- start --dry-run
```

Le bot obtient de **vrais** ordres Jupiter et les **simule** sur la
blockchain. Rien n'est signé, rien n'est envoyé, mais tout le chemin
d'exécution est testé (frais réels, slippage réel, erreurs réelles).

### Swap manuel — la commande de secours

```bash
npm run solbot3 -- swap SOL USDC 1 --dry-run
npm run solbot3 -- swap USDC SOL max --live
```

Mêmes garde-fous que le bot. `max` vend tout l'USDC (hors réserve de gaz).

### Live — trois verrous, à franchir volontairement

```bash
npm run solbot3 -- start --live
```

Refusé tant que les trois conditions ne sont pas réunies :

1. `confirm_live: true` dans `config/config.yaml` ;
2. `npm run solbot3 -- guard` affiche « LIVE AUTORISÉ » ;
3. une confirmation interactive (« oui ») au démarrage.

> **Aujourd'hui, aucune configuration n'est validée pour le live.** Le
> walk-forward a rejeté les deux meilleures stratégies. C'est un fait, pas un
>bug — et c'est exactement ce que le projet est là pour constater.

---

## 11. Quand ça coince

| Symptôme | Cause probable | Solution |
|---|---|---|
| `doctor` signale une config invalide | une clé mal orthographiée | le message donne le chemin exact |
| « aucun prix disponible » | clé Jupiter absente ou quota atteint | vérifiez `.env`, le débit passe de 0,5 à 1 req/s avec une clé |
| « insufficient_cash » | portefeuille virtuel épuisé | c'est le garde-fou qui fonctionne ; `report` montre où l'argent est parti |
| le bot ne trade plus | kill-switch ou pause journalière | `ls data/STOP` ; le dashboard affiche l'état des garde-fous |
| le backtest dit « aucune bougie » | historique non importé | `backtest import --days 90` d'abord |
| `EADDRINUSE` | un autre dashboard tourne | changez le port : `--port 4300` |
| le paper ne fait rien | historique de bougies insuffisant | les stratégies ont besoin de 27 bougies 15 m (≈ 7 h de collecte) |
| la base grossit de 60 à 80 Mo par jour | journal de décisions jamais dédoublonné | `maintenance` (voir §8), et un `backup --list` pour vérifier la rotation |

Le [runbook](runbook.md) détaille les procédures d'incident.

---

## 12. Reprendre le travail

En pratique :

```bash
# 1. l'état
npm run solbot3 -- report --days 7
npm run solbot3 -- parity --days 7
npm run solbot3 -- guard

# 2. une idée → un test
cp config/strategies/meanrev-1h-edge8.yaml config/strategies/mon-essai.yaml
# (éditez les paramètres)
npm run solbot3 -- backtest run --days 90 --label essai \
  --config config/strategies/mon-essai.yaml

# 3. la validation qui compte
npm run solbot3 -- backtest optimize --days 90 --windows 3 --timeframe 1h

# 4. consigner
#    → ajoutez une entrée dans results/experiments.md
```

---

## 13. Référence des commandes

| Commande | Rôle |
|---|---|
| `init` | crée le wallet et le `.env` (chmod 600) |
| `doctor` | diagnostic complet de l'environnement |
| `scan` | construit la watchlist et l'enregistre |
| `price SOL USDC` | prix en direct d'une paire |
| `watch` | collecte continue des prix et des bougies |
| `start --paper` | lance le moteur (paper par défaut) |
| `dashboard` | tableau de bord seul (lecture de la base) |
| `backtest import` | récupère l'historique OHLCV |
| `backtest run` | rejoue le moteur réel sur l'historique |
| `backtest optimize` | walk-forward automatisé (optimise puis valide) |
| `backtest walk-forward` | validation par fenêtres glissantes |
| `report` | métriques (+ `--html` pour un rapport autonome) |
| `parity` | compare le paper et le backtest |
| `guard` | le live est-il accessible ? |
| `lab` | laboratoire (paper uniquement, base séparée) |
| `swap` | swap manuel avec les mêmes garde-fous |
| `paths` | compare les chemins d'exécution (A/B sur swaps réels) |
| `backup` | sauvegarde, liste, restauration |
| `maintenance` | dédoublonne le journal, compacte la base |
| `version` | version, Node, plateforme |

---

## 14. En cas de doute

1. `npm run solbot3 -- doctor` — la plupart des problèmes s'y voient.
2. Le **journal de décisions** du dashboard — la trace est exhaustive.
3. [`results/experiments.md`](../results/experiments.md) — peut-être que votre
   idée a déjà été testée.
