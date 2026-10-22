# solbot3 — Présentation

> **À qui s'adresse ce document ?** À toute personne qui veut comprendre ce que
> fait solbot3 **sans lire une ligne de code**. Le jargon est expliqué dans
> l'annexe. Le détail technique est dans le [README principal](../README.md),
> la marche à suivre dans le [guide d'utilisation](guide.md).

---

## Le pitch — 30 secondes

**solbot3** est un robot de trading sur le marché _spot_ de Solana, propulsé par
**Jupiter** (l'agrégateur d'échange le plus utilisé de l'écosystème). Vous le
lancez sur une machine : il surveille le marché, applique des règles précises
d'achat et de vente, et respecte des limites de risque que **vous** fixez.

Mais — et c'est le cœur du projet — **solbot3 ne vous vend pas un rendement**.
Il ne vous vend pas un « bot qui gagne ». Il vous vend un **outil de mesure** :
un banc d'essai rigoureuse où l'on teste des idées de trading sur de vraies
données, avec de vrais frais, et où **le projet refuse de valider une
stratégie qui ne le mérite pas**.

C'est la différence avec les bots clé-en-main : ici, vous pouvez auditer
chaque décision, et vous pouvez constater vous-même qu'un résultat flatteur
s'effondre hors échantillon.

Par défaut, tout est en mode **paper** : le bot trade pour de faux, avec les
vrais prix. Aucun centime ne bouge.

---

## Slide 1 — Le problème

Évaluer une stratégie de trading, c'est aujourd'hui un travail **artisanal et
fragile** :

- **trader soi-même est un travail de 24 h/7** — les opportunités ne
  tombent pas pendant vos heures de bureau ;
- **les émotions coûtent cher** — vendre trop tôt, garder trop longtemps,
  paniquer dans la baisse ;
- **et surtout : on ne sait pas vraiment mesurer.** On peut faire un
  backtest qui dit « +180 % ». On peut ensuite passer en paper et voir «
  -12 % ». Entre les deux, il y a les frais, le slippage, le temps de
  latence, et — le plus vicieux — **le fait qu'on a choisi les paramètres
  en regardant le résultat**.

Ce dernier point est le piège. Un backtest réalisé sur une période et
choisi pour sa beauté est **du surapprentissage** : il a appris le bruit.

Les bots du marché ne règlent rien : ce sont des boîtes noires sur des
stratégies qu'on ne peut pas discuter.

---

## Slide 2 — La solution : solbot3

Un bot **open source**, **auditable** et **honnête** :

- **il teste, il ne prétend pas** — le backtest rejoue le _même_ moteur que
  le live, avec les _mêmes_ coûts. Un écart entre les deux est un bug, pas
  une approximation ;
- **tout est journalisé** — chaque signal, chaque refus du gestionnaire de
  risque, chaque trade, avec ses frais, dans une base locale ;
- **le risque est sous contrôle** — plafonds, stops, perte journalière
  maximale, kill-switch, et une réconciliation avec la blockchain au démarrage ;
- **et il se débrouille tout seul pour le reste** — sauvegarde quotidienne,
  alertes Telegram, redémarrage automatique, tableau de bord.

Point clé : **le projet refuse de valider une stratégie qui ne survit pas à la
validation hors échantillon**. Sur les sept backtests menés jusqu'ici, il a
**rejeté les deux meilleurs résultats**. C'est le cœur de la démarche, et c'est
documenté dans [`results/experiments.md`](../results/experiments.md).

---

## Slide 3 — Comment ça marche (vue simple)

À chaque **cycle** (toutes les 30 secondes par défaut), le bot :

1. **Regarde le marché** — prix et volumes via Jupiter, pour tous les tokens de
   la liste de suivi ;
2. **Classe le marché** — chaque actif reçoit une étiquette : _tendance_,
   _range_ (oscillation) ou _inactif_. « Ne rien faire » est une décision
   legitimate ;
3. **Vérifie les positions** — stop-loss, take-profit, trailing stop. Les
   sorties de sécurité passent **toujours en premier**, avant toute recherche
   d'achat ;
4. **Fait jouer chaque stratégie en parallèle** — chacune sur son propre
   portefeuille fantôme, avec les mêmes frais que le capital réel. C'est
   ainsi qu'on compare objectivement ;
5. **Choisit la stratégie qui pilote** — la meilleure performance sur la
   fenêtre, avec un seuil d'échantillon et une hystérésis (on ne change pas
   de stratégie pour un bruit) ;
6. **Demande l'autorisation au gestionnaire de risque** — il a le dernier
   mot, toujours ;
7. **Exécute et enregistre** — en paper, tout est simulé ; en live, via
   Jupiter, avec une protection on-chain déposée sur la blockchain.

---

## Slide 4 — Les stratégies incluses

| Stratégie             | Idée                                                       | Régime visé |
| --------------------- | ---------------------------------------------------------- | ----------- |
| **trend_breakout**    | Les cassures de plus hauts sur volume confirmé continuent  | tendance    |
| **mean_reversion**    | Un écart important à la moyenne revient                    | range       |
| **grid**              | Achats par paliers sous l'ancre, sortie au retour          | range       |
| **dca_rotation**      | Un portefeuille cible se rééquilibre mieux qu'il ne dérive | tous        |
| **relative_strength** | Les actifs les plus forts sur 24 h restent forts           | tendance    |
| **regime_switch**     | Chaque régime demande une stratégie différente             | méta        |

Ajouter une stratégie est une **ligne** dans un registre, pas une
modification du cœur du bot.

---

## Slide 5 — Les garde-fous : le gestionnaire de risque

Il a **toujours le dernier mot**. Ses règles s'appliquent dans un ordre fixe,
et chaque refus est journalisé **avec ses chiffres** (« edge 38 bps < seuil
3×coûts 45 bps »). C'est l'outil de réglage principal.

1. **Kill-switch global** — fichier `STOP`, drawdown maximal, ou commande
   Telegram. Les entrées cessent, les sorties continuent.
2. **Perte journalière maximale** — les entrées s'arrêtent jusqu'à minuit UTC.
3. **Plafonds** — nombre de positions, exposition par actif, exposition totale.
4. **Edge net** — le mouvement attendu doit dépasser le coût aller-retour
   (frais + slippage + impact) d'un facteur que vous choisissez.
5. **Dimensionnement** — taille limitée par le NAV, l'exposition et l'impact.
6. **Impact de prix**, **cooldown** par actif, **réserve de gaz**.
7. **Garde de données** — un prix périmé ou non corroboré ne décide rien.

---

## Slide 6 — Trois modes : essayer → vérifier → risquer

| Mode        | Ce qui se passe                                                        | Argent réel |
| ----------- | ---------------------------------------------------------------------- | ----------- |
| **paper**   | Vrais prix, vrais coûts, fills simulés. Le portefeuille est virtuel.   | **Non**     |
| **dry-run** | Vrais devis Jupiter, vraie transaction, **simulée** sur la blockchain. | **Non**     |
| **live**    | Vrais ordres signés et envoyés.                                        | **Oui**     |

Le passage en `live` exige **trois verrous simultanés** :

1. `confirm_live: true` — un choix délibéré dans la configuration ;
2. un **backtest conforme** au garde-fou, pour l'empreinte **exacte** de la
   configuration (changer un paramètre change l'empreinte et impose de
   rejouer le backtest) ;
3. une **confirmation interactive** (« oui ») au démarrage.

---

## Slide 7 — Les backtests : de vraies données, de vrais frais

`solbot3 backtest run` rejoue le **moteur réel** sur l'historique importé
depuis GeckoTerminal :

- **le même code de décision** que le live (mêmes stratégies, même
  gestionnaire de risque, même portefeuille FIFO) ;
- **le même modèle de coûts** — c'est ce qui manquait aux projets
  précédents, où le backtest était trop optimiste et le paper plus dur ;
- des **métriques** complètes : PnL net, taux de gain, profit factor, Sharpe,
  drawdown, turnover, frais.

Et surtout : `solbot3 backtest optimize` **optimise puis valide hors
échantillon**. Les paramètres sont choisis sur la première moitié d'une
fenêtre, évalués sur la seconde, et cinq verrous anti-surapprentissage
contrôlent le résultat.

---

## Slide 8 — Lecture honnête de ces chiffres

Voici les sept backtests menés sur 90 jours et 41 actifs :

| Stratégie               | PnL net              | Sharpe | Sensibilité aux frais |
| ----------------------- | -------------------- | ------ | --------------------- |
| `relative_strength` 1 h | +221,70 $ (+22,17 %) | 2,79   | ✔                     |
| `mean_reversion` 1 h ×3 | +167,03 $ (+16,71 %) | 4,42   | ✗                     |
| `mean_reversion` 1 h ×8 | +80,01 $ (+8,00 %)   | 1,79   | ✔                     |
| `trend_breakout` 1 h    | +66,77 $ (+6,71 %)   | 1,31   | ✗                     |
| `regime_switch` 1 h     | +50,96 $ (+5,10 %)   | 1,14   | ✔                     |
| `mean_reversion` 15 m   | −18,15 $ (−1,81 %)   | −0,27  | sans objet            |
| `trend_breakout` 15 m   | −71,46 $ (−7,15 %)   | −1,44  | sans objet            |

Puis le walk-forward automatisé a passé les deux meilleures au crible :

- `relative_strength` : dégradation de 79,5 %, 53,9 % et 132,1 % selon la
  fenêtre, et **les paramètres retenus changent à chaque fenêtre** ;
- `mean_reversion` : **1 fenêtre validée sur 3**.

**Les deux sont rejetées.**

> Un bon résultat sur la fenêtre complète ne vaut rien. C'est la leçon
> centrale du projet, et elle est vérifiable : le garde-fou vient de refuser
> deux configurations qui semblaient excellentes.

**Aucune configuration n'est validée pour le live à ce jour.**

---

## Slide 9 — Les risques (ce que le bot ne peut pas éviter)

- **Le marché peut s'effondrer.** Un stop-loss protège d'une position, pas
  d'un effondrement de liquidité.
- **Un stop-loss on-chain se déclenche sur une mèche de prix**, donc à un
  prix que personne n'a vu. C'est pour ça qu'il est **désactivé par défaut**.
- **Les frais mangent les petites stratégies.** Sur 15 minutes, le seuil de
  rentabilité est parfois hors d'atteinte : c'est mesuré, pas supposé.
- **Les tokens Jupiter sont volatils.** Une partie de l'univers est des
  mèmes : la liquidité peut disparaître en minutes.
- **Le bot peut s'arrêter.** Un take-profit déposé **sur la blockchain**
  continue de s'exécuter même bot arrêté : c'est le seul filet qui résiste à
  une panne.
- **Un garde-fou peut être contourné** si vous désactivez `confirm_live` et
  que vous forcez les confirmations. Ne le faites pas.

---

## Slide 10 — Le tableau de bord

`http://<machine>:4200` — six vues, en lecture seule, alimentées en direct :

- **Vue d'ensemble** — NAV, PnL, drawdown, frais, référence buy & hold ;
- **Stratégies** — performance de chaque stratégie en shadow, et laquelle
  pilote ;
- **Positions** — valorisation, stops, âge ;
- **Trades** — chaque exécution, avec ses frais et son PnL ;
- **Décisions** — le journal filtrable : _pourquoi_ le bot a fait ça ;
- **Données** — fraîcheur des prix, couverture des bougies.

Le dashboard **n'accepte aucune écriture** : c'est vérifié par un test, pas
par une intention.

---

## Slide 11 — Démarrage : de zéro au premier run paper

```bash
npm ci
cp .env.example .env
cp config/config.example.yaml config/config.yaml

npm run solbot3 -- init        # wallet + .env en 600
npm run solbot3 -- doctor      # tout est-il en place ?
npm run solbot3 -- scan        # construit la liste de suivi
npm run solbot3 -- start --paper
```

Cinq commandes, et le bot tourne. Le [guide d'utilisation](guide.md) détaille
la suite.

> Il n'a pas fallu une seule fois de capital réel pour en arriver là. C'est
> tout l'intérêt d'un mode paper bien fait.

---

## Slide 12 — En résumé

**solbot3** ne vous promet pas un robot qui gagne. Il vous donne :

- un **moteur** réellement rejouable, où le backtest et le live partagent le
  même code ;
- des **garde-fous** qui ont le dernier mot, et qui sont auditables ;
- des **outils de mesure** honnêtes : walk-forward, sensibilité aux frais,
  rapport de parité ;
- et surtout le **droit de conclure qu'aucune stratégie ne marche encore**.

Le prochain jalon n'est pas du code : c'est **plus d'historique** (6 à 12 mois)
et un univers plus large. Ce sont les données, pas la logique, qui manquent.

---

## Annexe — Petit dictionnaire

| Terme                | Ce que ça veut dire                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| **spot**             | On achète un actif pour le détenir (pas de vente à découvert, pas de levier).                           |
| **Jupiter**          | L'agrégateur d'échange de Solana : on lui demande « échange A contre B », il trouve le meilleur chemin. |
| **backtest**         | Rejouer une stratégie sur l'historique, pour mesurer ce qu'elle aurait donné.                           |
| **paper trading**    | Trader pour de faux : vrais prix, faux argent.                                                          |
| **dry-run**          | Obtenir un vrai ordre et le **simuler** sur la blockchain, sans l'envoyer.                              |
| **slippage**         | L'écart entre le prix attendu et le prix obtenu.                                                        |
| **impact de prix**   | Le prix bouge parce que votre ordre est trop gros pour le pool.                                         |
| **edge**             | L'avantage attendu d'une stratégie, une fois les frais déduits.                                         |
| **drawdown**         | La baisse maximale depuis le sommet de l'équité.                                                        |
| **surapprentissage** | Optimiser sur les données qu'on va ensuite évaluer : on apprend le bruit.                               |
| **hors échantillon** | Une période de données **jamais vue** pendant l'optimisation.                                           |
| **kill-switch**      | L'interrupteur d'urgence : plus aucune entrée, les sorties continuent.                                  |
| **empreinte (hash)** | Une signature de la configuration. Changer un paramètre change l'empreinte.                             |
| **SSE**              | Un flux d'événements en direct, du serveur vers le navigateur.                                          |
| **Tailscale**        | Un VPN : votre machine n'est accessible que depuis vos appareils.                                       |

---

## Pour aller plus loin

- [Guide d'utilisation rapide](guide.md) — installer, lancer, comprendre.
- [README principal](../README.md) — la spécification complète.
- [Architecture](architecture.md) — comment le code est organisé.
- [Stratégies](strategies.md) — la méthode de développement d'une stratégie.
- [Runbook](runbook.md) — que faire quand quelque chose casse.
- [Journal d'expériences](../results/experiments.md) — les résultats, y compris les échecs.
