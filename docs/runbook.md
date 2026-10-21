# Runbook — procédures d'incident

Ce document décrit quoi faire **quand ça casse**. Chaque procédure est
volontairement courte : sous stress, on lit des étapes, pas des paragraphes.

> ⚠️ Le mode live manipule des fonds réels. En cas de doute, **arrêter le bot**
> (`solbot3 kill` ou `systemctl stop solbot3`) : sortir une position à la main
> coûte presque toujours moins cher qu'un incident mal géré.

## Index

| Symptôme | Procédure |
|---|---|
| [Le bot ne démarre pas](#le-bot-ne-démarre-pas) |
| [Le bot s'arrête en boucle](#le-bot-sarrête-en-boucle) |
| [`/healthz` renvoie 503](#healthz-renvoie-503) |
| [Le dashboard est inaccessible](#le-dashboard-est-inaccessible) |
| [Le moteur ne trade plus](#le-moteur-ne-trade-plus) |
| [Divergence de réconciliation](#divergence-de-réconciliation) |
| [Fuite de clé privée](#fuite-de-clé-privée) |
| [Le bot a perdu trop d'argent](#le-bot-a-perdu-trop-dargent) |
| [La base est corrompue](#la-base-est-corrompue) |

---

## Le bot ne démarre pas

```bash
npm run solbot3 -- doctor
```

`doctor` liste tous les points bloquants avec leur cause. Les trois plus
fréquents :

1. **« aucun fichier de configuration trouvé »** — créer `config/config.yaml` :
   ```bash
   cp config/config.example.yaml config/config.yaml
   ```
2. **« le mode `live` exige `confirm_live: true` »** — le double filet est
   bloqué par conception. Repasser en `mode: paper` pour diagnostiquer.
3. **« BS58_PRIVATE_KEY absent »** — le wallet n'est pas configuré :
   ```bash
   npm run solbot3 -- init
   ```

## Le bot s'arrête en boucle

```bash
journalctl -u solbot3 -n 200 --no-pager   # systemd
docker compose logs --tail=200 solbot3    # docker
```

Chercher `tick_error` ou `migration ... échouée`. Si le cycle s'arrête sur une
migration, ne jamais éditer une migration existante : en écrire une nouvelle.

## `/healthz` renvoie 503

`503` signifie *stale* ou *degraded* : le dernier tick est trop vieux ou la
base est inaccessible.

- Vérifier que le processus tourne (`ps`, `systemctl status`).
- Vérifier la base : `ls -la data/solbot3.sqlite*`.
- Un tick qui dépasse trois fois l'intervalle (90 s par défaut) suffit à
  déclencher le 503 : c'est voulu, pour que Docker et systemd redémarrent.

## Le dashboard est inaccessible

1. Le dashboard écoute sur `127.0.0.1` par défaut : depuis une autre machine,
   passer par un tunnel SSH.
2. Si `DASHBOARD_TOKEN` est défini, toutes les routes exigent le jeton
   (en-tête `Authorization: Bearer <token>` ou paramètre `?token=`).
3. Un avertissement est affiché au démarrage si le dashboard écoute sur une
   interface publique **sans** jeton : ne l'ignorez pas.

## Le moteur ne trade plus

Dans l'ordre :

1. **Kill-switch actif ?** → `data/STOP` présent. Les entrées sont coupées,
   les sorties continuent. `rm data/STOP` pour reprendre (le kill-switch ne se
   lève jamais tout seul).
2. **Pause de perte journalière ?** → la perte du jour dépasse
   `risk.daily_loss_limit_pct`. La reprise est automatique à minuit UTC.
3. **Drawdown max atteint ?** → le fichier `STOP` a été créé automatiquement.
   Il faut une action manuelle.
4. **Régime `idle` ?** → la stratégie qui pilote ne trouve rien à faire. C'est
   une décision valide, pas une panne.
5. **Edge net insuffisant ?** → chaque rejet est en base avec ses chiffres. Le
   tableau `risk_rejections` par règle dit où le temps passe.

```sql
SELECT rule, COUNT(*) FROM risk_rejections
WHERE ts > (unixepoch('now') - 86400) * 1000
GROUP BY rule ORDER BY 2 DESC;
```

## Divergence de réconciliation

Au démarrage en live, les soldes on-chain font foi. Chaque position locale
est **adoptée**, **ajustée** (FIFO) ou **clôturée**, et chaque action est
journalisée.

- Une divergence inexpliquée est un signal d'alerte : ne pas forcer la
  réconciliation à la main sans avoir compris pourquoi.
- Consulter `events` (kind `reconcile_adopt` / `reconcile_adjust` /
  `reconcile_closed`) avant toute action.
- Cause fréquente : un trade signé mais non confirmé avant le crash.

## Fuite de clé privée

**Procédure, dans l'ordre, sans délai :**

1. **Transférer tous les fonds** vers un wallet neuf, immédiatement.
2. Révoquer la clé API Jupiter et en générer une nouvelle.
3. Générer un nouveau wallet : `npm run solbot3 -- init --force`.
4. Vérifier l'historique Git : `git log -p -- .env` — si une clé a été
   commitée, elle est compromise, même après suppression du fichier.
5. Auditer les journaux : le redaction pino est en place, mais vérifier que
   aucuneDump de crash n'a été écrit.
6. Le hook de pré-commit (`scripts/install-hooks.sh`) doit être installé.

## Le bot a perdu trop d'argent

1. `solbot3 kill` — les entrées s'arrêtent, les sorties continuent.
2. Consulter la courbe d'équité et le journal des décisions : chercher le motif
   (règle de rejet la plus fréquente, stratégie pilote, régime dominant).
3. Ne pas modifier les paramètres à chaud pour « rattraper » : la correction
   se fait sur le backtest, puis en shadow.

## La base est corrompue

```bash
sqlite3 data/solbot3.sqlite "PRAGMA integrity_check;"
```

Si elle est corrompue :

1. Arrêter le bot.
2. Copier la base corrompue à part (pour analyse).
3. Restaurer le dernier backup :
   ```bash
   npm run solbot3 -- backup --list
   npm run solbot3 -- backup --restore data/backups/solbot3-....sqlite
   ```
4. La restauration est **vérifiée** (`PRAGMA integrity_check`) avant d'écraser
   la base courante.
