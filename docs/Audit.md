# Audit v1 Nightshift

- Date : 2026-10-01
- Commit audité : `767f30a` (branche `nightshift/card_49c12198e8-t2-audit`, après la Task 1)
- Périmètre : tout `src/`, `bin/`, `test/`, `README.md`, `.gitignore`, `package.json`, `biome.json`.
- Vérifications faites : `bunx biome check .` (0 erreur, 12 avertissements, 1 info), `bun test` (167 tests verts, ~29 s), `bun audit` (aucune vulnérabilité connue, donc aucune mise à jour de dépendance), sondes locales sur un serveur de test (voir A1, A3, A8, A12).
- Statut final : 2026-10-01, 39 constats sur 39 corrigés (0 reporté), `bun run check` : code de sortie 0 (Biome sans avertissement, tsc, 227 tests verts), `bun run test:coverage` : code de sortie 0.
- Hors périmètre (spec) : i18n, accès LAN/auth, CI, refonte.
- Revu sans constat : service des captures (`resolveScreenshot` : realpath + liste blanche issue de la description), `persistScreenshots`, rendu Markdown (`safeHref`, images limitées aux captures de la carte), `createSkill` (nom validé par `NAME_RE`), `Bun.spawn` des agents (tableau d'arguments, prompt par stdin, pas de shell), écriture atomique de `nightshift.json` et `settings.json`.

## Tableau des constats

| id | catégorie | sévérité | emplacement | tâche | statut | commit |
|----|-----------|----------|-------------|-------|--------|--------|
| A1 | sécurité | critique | src/server/server.ts:56-57,62-65,201-218,235 | Task 3 | corrigé | d8f7c0e, d6683db |
| A2 | sécurité | haute | src/server/server.ts:74-89 | Task 3 | corrigé | d8f7c0e, d6683db |
| A3 | sécurité | haute | src/server/orchestrator.ts:329-347 | Task 4 | corrigé | 1556b88 |
| A4 | robustesse | haute | src/server/orchestrator.ts:548-552,638,787 | Task 4 | corrigé | cccb7c6 |
| A5 | sécurité | haute | src/web/TestPanel.tsx:112 | Task 4 | corrigé | 162aace |
| A6 | robustesse | moyenne | bin/nightshift.ts:6,12 | Task 5 | corrigé | 6593a7b |
| A7 | robustesse | moyenne | src/server/orchestrator.ts:423-431,861-882 | Task 4 | corrigé | 18ac9b5 |
| A8 | robustesse | moyenne | src/server/server.ts:46 | Task 8 | corrigé | 1a31e7e |
| A9 | robustesse | moyenne | src/server/server.ts:54, src/server/orchestrator.ts:294-297 | Task 8 | corrigé | 75c78ad |
| A10 | robustesse | moyenne | src/server/server.ts:92-123 | Task 8 | corrigé | 52308b4 |
| A11 | robustesse | moyenne | src/server/server.ts:125-163 | Task 8 | corrigé | eed9b3e |
| A12 | robustesse | moyenne | src/server/server.ts:232 | Task 8 | corrigé | c10e2db |
| A13 | robustesse | moyenne | src/server/settings.ts:26-52 | Task 6 | corrigé | 2ef7f7a |
| A14 | robustesse | moyenne | src/server/skills.ts:30,80 | Task 7 | corrigé | 6db6d5f |
| A15 | robustesse | moyenne | src/server/store.ts:225-229,249-259 | Task 4 | corrigé | c2f4a70, 092e62f |
| A16 | tests | moyenne | test/nightshift.test.ts:6-9, test/column-emoji.test.ts:8-9 | Task 4 | corrigé | 8df9332 |
| A17 | tests | moyenne | src/server/server.ts (routes), test/ | Task 8 | corrigé | 74bfa9e |
| A18 | tests | moyenne | src/server/settings.ts, test/ | Task 6 | corrigé | 2ef7f7a |
| A19 | tests | moyenne | src/server/skills.ts, test/ | Task 7 | corrigé | 6db6d5f |
| A20 | docs | basse | README.md:3,9-10,26-30, .gitignore:4, package.json:8 | Task 9 | corrigé | ffbe957, 60eebd2 |
| A21 | lint | basse | biome.json, package.json, ensemble du dépôt | Task 1 | corrigé | be6cb27, 767f30a |
| A22 | robustesse | basse | bin/nightshift.ts:21-40 | Task 9 | corrigé | 60eebd2 |
| A23 | bonnes pratiques | basse | src/server/orchestrator.ts:212-219,349-360 | Task 9 | corrigé | 4830f69 |
| A24 | robustesse | basse | src/server/orchestrator.ts:834-848 | Task 9 | corrigé | a8c718c |
| A25 | bonnes pratiques | basse | src/server/server.ts:38 | Task 9 | corrigé | a02291c |
| A26 | robustesse | basse | src/server/skills.ts:45,67-72,81 | Task 9 | corrigé | 793a65b |
| A27 | robustesse | basse | src/server/store.ts:231-247 | Task 9 | corrigé | 27ddf12 |
| A28 | robustesse | basse | src/web/api.ts:54-60,75, src/web/App.tsx:41-51 | Task 9 | corrigé | 9628976 |
| A29 | robustesse | basse | src/web/CardModal.tsx:112-114,122,213 | Task 9 | corrigé | 9628976 |
| A30 | tests | basse | test/nightshift.test.ts (17 `Bun.sleep`, 33 `mkdtempSync`), test/run-progress.test.ts, test/time-panel.test.tsx:94,98 | Task 9 | corrigé | 9c16e79, 05b9ca5, d6e5022 |
| A31 | lint | basse | règle `suspicious/noExplicitAny` (86), 11 fichiers | Task 9 | corrigé | 238ab45 |
| A32 | lint | basse | règle `style/noNonNullAssertion` (138), 27 fichiers | Task 9 | corrigé | 6513886 |
| A33 | lint | basse | règle `suspicious/noArrayIndexKey` (24) | Task 9 | corrigé | 49b046f |
| A34 | lint | basse | règles `noAssignInExpressions` (4), `noImplicitAnyLet` (3), `useIterableCallbackReturn` (3) | Task 9 | corrigé | 9cee1fd |
| A35 | lint | basse | règle `suspicious/noControlCharactersInRegex` (3) : orchestrator.ts:843, markdown.tsx:281 | Task 9 | corrigé | 9cee1fd |
| A36 | lint | basse | règle `correctness/useExhaustiveDependencies` (15), src/web | Task 9 | corrigé | d478937 |
| A37 | lint | basse | règle `a11y/useButtonType` (39), src/web | Task 9 | corrigé | dc6b198 |
| A38 | lint | basse | règles a11y diverses (12), src/web | Task 9 | corrigé | 3952e50 |
| A39 | lint | basse | avertissements restants : `noDescendingSpecificity` (7), `noImportantStyles` (4), `noCommaOperator` (1) | Task 9 | corrigé | 9a0aa10, 9cee1fd |

Total : 39 constats (1 critique, 4 hautes, 14 moyennes, 20 basses).

## Constats

### A1 — RCE locale via CSRF, DNS rebinding et écoute sur toutes les interfaces

**Problème.** `Bun.serve` est appelé sans `hostname` (server.ts:56-57) : le serveur écoute sur toutes les interfaces (sonde : `GET http://<IP LAN>:<port>/api/settings` répond 200). Aucune route n'a de contrôle `Host`, `Origin` ni `Content-Type`, et le wrapper `h` parse le body JSON quel que soit le type de contenu (server.ts:46). Une page web quelconque ouverte dans le navigateur de l'utilisateur peut donc, par un formulaire ou un `fetch` `text/plain` (requête simple, sans préflight) ou par DNS rebinding, atteindre l'API et exécuter du code : `PUT /api/cards/:id/test` pose une commande arbitraire (server.ts:201-210) puis `POST /api/cards/:id/test/start` la lance avec `sh -c` (orchestrator.ts:830); `PUT /api/settings` change `claudePath` vers un exécutable choisi et `permissionMode` vers `bypassPermissions` (settings.ts:40-52); `PUT /api/skill` réécrit un SKILL.md utilisateur (server.ts:232). La route `/ws` n'a pas non plus de contrôle d'origine (server.ts:235) : un site tiers lit les réglages, les cartes et les logs en direct.

**Correctif.** Module `src/server/guard.ts` (`checkRequest`, spec « Module de garde HTTP ») appelé par le wrapper `h` avant la lecture du body et par `/ws` avant `srv.upgrade`; `Bun.serve({ hostname: "127.0.0.1" })`; 415 si POST/PUT/PATCH n'est pas `application/json`. Vérifier que `localhost` joint bien le serveur sous macOS, sinon afficher `http://127.0.0.1:<port>/`. Commit `fix(A1,A2)`.

**Test.** `guard-host`, `guard-origin`, `guard-content-type`, `server-security-csrf`, `server-security-rebinding`, `server-security-ws`, `server-security-bind`.

**Statut.** corrigé (d8f7c0e, d6683db).

### A2 — `/api/fs` expose le disque à toute origine

**Problème.** `GET /api/fs?dir=` liste les sous-dossiers de n'importe quel chemin absolu (server.ts:76-88), sans contrôle d'origine : avec A1, une page tierce parcourt l'arborescence de l'utilisateur (noms de dossiers, y compris hors du HOME) et lit les messages d'erreur système (`ENOENT: ... scandir '/x'`, sonde). Le besoin produit (sélecteur de projet) est légitime, la route doit rester.

**Correctif.** Couvert par la garde de A1 (Host, Origin). Aucune restriction de chemin ajoutée (le sélecteur doit parcourir tout le disque); l'erreur renvoyée ne doit plus exposer le chemin brut. Commit `fix(A1,A2)`.

**Test.** `server-security-rebinding` (GET /api/fs avec Host `attacker.example:<port>` renvoie 403).

**Statut.** corrigé (d8f7c0e, d6683db).

### A3 — Traversée de chemin dans `GET /api/cards/:id/log`

**Problème.** `getLog` construit `join(NIGHTSHIFT_HOME, "logs", <hash>, `${cardId}.jsonl`)` avec `cardId` pris tel quel dans l'URL (server.ts:223, orchestrator.ts:329-347), sans validation. Sonde : `GET /api/cards/..%2F..%2Fsecret/log` renvoie les lignes JSON du fichier `~/.nightshift/secret.jsonl`. Tout fichier `.jsonl` lisible (par exemple les transcripts de `~/.claude/projects/**`) peut être lu par un chemin relatif ; `logFile` crée aussi des dossiers (`mkdirSync`) pour n'importe quel projet. Les écritures (`log`, `start`) utilisent seulement des ids de cartes existantes.

**Correctif.** Valider `cardId` avec `/^[A-Za-z0-9_-]+$/` (comme `screenshotsDir`) dans `logFile`/`getLog` (réponse vide ou 404 sinon) et ne pas créer de dossier en lecture.

**Test.** `log-traversal` : `GET /api/cards/..%2F..%2Fsecret/log` ne renvoie pas le contenu d'un fichier `.jsonl` placé dans `NIGHTSHIFT_HOME`.

**Statut.** corrigé (1556b88).

### A4 — Rejet de promesse non géré dans `start()` : la sortie d'un agent peut arrêter le serveur

**Problème.** `this.run(...).finally(...)` n'a pas de `.catch` (orchestrator.ts:548-552). Toute exception dans `run`/`finish` devient un rejet non géré, et Bun termine alors le processus (sonde : exit 1). Déclencheurs concrets : sortie d'agent `test: { command: "x", url: 123 }` (`out.test.url?.trim()` lève dans `p.mutate`, orchestrator.ts:787); réglage `model` non-string posé par `PUT /api/settings` (`settings.model.trim()` dans `resolveModel`, appelé avant le `try` de `spawnAgent`, orchestrator.ts:638); échec d'écriture disque dans `mutate`. Après l'exception, la carte reste sans `lastRun`, donc `needsRun` est vrai et le scheduler la relance (limité seulement par la garde anti-boucle).

**Correctif.** `.catch` dans `start()` qui journalise l'erreur et appelle `finish(job, "error", { error })` (en protégeant contre une seconde exception); typer `out.test.url` (string uniquement, voir A5); la validation des réglages est dans A13.

**Test.** `run-survives-bad-agent-output` : sortie fake-claude avec `test.url` numérique ; le serveur reste vivant et la carte passe en `error` ou applique la sortie sans l'url.

**Statut.** corrigé (cccb7c6).

### A5 — XSS : URL de test rendue en lien sans filtre

**Problème.** `<a href={card.test!.url}>` (TestPanel.tsx:112) rend l'url telle quelle. Elle vient de la sortie d'un agent (orchestrator.ts:786-788, non filtrée), de `PUT /api/cards/:id/test` (server.ts:206-208) ou d'un `nightshift.json` (store.ts:185). `javascript:...` s'exécute au clic dans l'origine de l'application, qui a accès à toute l'API (donc exécution de commandes, cf. A1).

**Correctif.** Helper `safeHttpUrl(raw): string | null` dans `src/shared/urls.ts` (http/https absolues, sans espace ni caractère de contrôle). Serveur : le PUT renvoie 400 si l'url non vide est refusée; l'application de la sortie d'agent omet la clé `url`. Client : lien affiché seulement si `safeHttpUrl` l'accepte. Un `nightshift.json` existant avec une mauvaise url se charge toujours (normalisation, pas de refus). `markdown.tsx` garde son `safeHref`.

**Test.** `test-url-put`, `test-url-agent`, `test-url-render`.

**Statut.** corrigé (162aace).

### A6 — `--port` / `PORT` non validés

**Problème.** `Number(process.env.PORT) || 4545` et `port = Number(argv[++i])` (bin/nightshift.ts:6,12) : `--port abc` donne `NaN`, `--port` sans valeur donne `NaN`, `--port 70000` ou `1.5` sont passés tels quels à `Bun.serve`; `--port 0` via `PORT=0` retombe silencieusement sur 4545. L'erreur remonte comme exception brute au démarrage. Un argument inconnu (`--foo`) est pris pour un dossier de projet (ligne 18).

**Correctif.** `parseArgs(argv, env)` pur et exporté dans `src/server/cli.ts` : entier décimal strict 0..65535, sinon `Invalid port: <valeur>` sur stderr et `process.exit(2)` avant `startServer`; PORT vide ou absent donne 4545. `bin/nightshift.ts` l'appelle.

**Test.** `cli-port-invalid`, `cli-port-valid`, e2e `bun bin/nightshift.ts --port abc --no-open --no-agents` (code 2).

**Statut.** corrigé (6593a7b).

### A7 — Arrêt : agents et commandes de test peuvent survivre au processus

**Problème.** `shutdown()` envoie SIGTERM aux agents (`kill`) et aux groupes de test (`stopTest`) puis le CLI fait `process.exit(0)` aussitôt (bin/nightshift.ts:35-40). Les relances SIGKILL sont des `setTimeout` de 5 s (orchestrator.ts:427-429) et 3 s (orchestrator.ts:870) qui ne s'exécuteront jamais : un agent `claude` ou une commande de test qui ignore SIGTERM reste orphelin. Le serveur HTTP n'est pas arrêté explicitement. Le timer de `kill` n'est pas `unref` (retient les tests).

**Correctif.** `shutdown()` envoie SIGTERM, attend la sortie (borne courte) puis SIGKILL de façon synchrone avant de rendre la main; `unref` des timers; le CLI attend `shutdown()` avant `process.exit` (le fichier bin est possédé par la Task 5, coordonner ou documenter dans le rapport de la Task 4).

**Test.** `shutdown-kills-sigterm-ignoring-test` : commande de test `trap '' TERM; sleep 30`, `shutdown()`, le processus n'existe plus.

**Statut.** corrigé (18ac9b5).

### A8 — JSON invalide silencieusement remplacé par `{}`

**Problème.** `await req.json().catch(() => ({}))` (server.ts:46) : un body JSON invalide devient `{}` sans erreur. Sonde : `POST /api/cards` avec `{oops` crée une carte « Untitled » et répond 200; `PUT /api/skill` avec un body vide écrase un fichier (A12).

**Correctif.** JSON invalide : 400 `{error:"Invalid JSON body"}`; body vide sur POST/PUT/PATCH accepté (`{}`); body non-objet (tableau, nombre) : 400. GET/DELETE inchangés.

**Test.** `routes-invalid-json`.

**Statut.** corrigé (1a31e7e).

### A9 — Toute route ouvre (et crée) un projet à la volée

**Problème.** `project()` appelle `orch.get(body.project ?? url.searchParams.get("project") ?? "")` (server.ts:54), et `get` ouvre n'importe quel dossier existant (orchestrator.ts:294-297, `open` : `new Project(path)` crée `nightshift.json` et un watcher, écrit un verrou et ajoute le chemin aux réglages). Sonde : `GET /api/project` sans paramètre ouvre le dossier courant du serveur (`resolve("")`); une simple lecture d'une route avec `?project=/x` écrit dans `/x`. Les projets ne sont jamais refermés (watchers et verrous cumulés).

**Correctif.** `project()` ne résout que des projets déjà ouverts par `POST /api/projects/open` (404 « Unknown project » sinon, paramètre absent : 400). Vérifier que l'UI ouvre bien avant d'appeler (App.tsx:44-50, c'est le cas) et que les tests existants s'y conforment.

**Test.** `routes-status-codes` (projet inconnu : 404, aucun `nightshift.json` créé).

**Statut.** corrigé (75c78ad).

### A10 — `PUT /api/board` : validation incomplète des colonnes

**Problème.** `b.columns.map((c: any) => ...)` (server.ts:97-112) : une colonne `null` ou `c.instructions` non-string lève une `TypeError` (renvoyée en 400 avec un message interne); deux colonnes avec le même `id` sont acceptées (sonde : 200), alors que les cartes se rangent par `columnId`; `name` non-string devient `String(...)`. Les cas « sans colonne » et « colonne contenant des cartes » sont déjà refusés (lignes 113, 117) mais ne sont pas testés.

**Correctif.** Valider chaque colonne (objet, `id` unique, types des champs) et répondre 400 avec un message clair; garder la normalisation actuelle pour le reste.

**Test.** `routes-validation` (PUT /api/board `columns: []` : 400; retirer une colonne avec cartes : 400; id dupliqué : 400).

**Statut.** corrigé (52308b4).

### A11 — Routes cartes : entrées non typées

**Problème.** `POST /api/cards` : `b.columnId` non-string passe à `p.column()` (server.ts:129-130), `String(b.title)` transforme un objet en `"[object Object]"` (ligne 136), `b.description` idem. `POST /cards/:id/move` : `String(b.columnId)` et `b.index` non vérifié (ligne 176). `PUT /api/cards/:id/test` : `String(b.command)` d'un objet (ligne 206). Le type `any` du corps (A31) masque ces cas.

**Correctif.** Vérifier les types des champs attendus (string pour title/description/columnId/command/url, entier pour index) et répondre 400 en cas d'écart.

**Test.** `routes-validation` (POST /api/cards avec `title: {}` : 400).

**Statut.** corrigé (eed9b3e).

### A12 — `PUT /api/skill` sans `content` écrit « undefined » dans le SKILL.md

**Problème.** `saveSkill(project, String(b.name), String(b.content))` (server.ts:232). Sonde : `PUT /api/skill {project, name:"x"}` répond 200 et le fichier contient désormais exactement `undefined`. Perte de données de la définition du skill (y compris dans `~/.claude/skills`).

**Correctif.** Exiger `name` et `content` de type string (400 sinon).

**Test.** `routes-validation` (PUT /api/skill sans content : 400, fichier inchangé).

**Statut.** corrigé (c10e2db).

### A13 — Réglages : aucune validation de type (HTTP et chargement)

**Problème.** `updateSettings(patch)` fusionne n'importe quelle clé et valeur (settings.ts:40-52; sonde : `{model:5, maxParallel:"abc", recentProjects:"x"}` répond 200 et est persisté). Conséquences : `maxParallel:"abc"` donne `Math.max(1, ...)` valide ici, mais le chargement n'applique pas ce traitement (ligne 30 : `{...DEFAULT, ...raw}`), donc un fichier contenant `"maxParallel":"abc"` rend `this.jobs.size >= max` toujours faux (agents sans limite); `model` non-string plante `resolveModel` (A4); `recentProjects` non-tableau fait échouer `rememberProject` donc toute ouverture de projet; clés inconnues persistées. `getSettings` avale toute erreur (`catch {}`, ligne 34) et retombe sur les défauts : un `settings.json` corrompu est ensuite écrasé au prochain `updateSettings`. `shared.current = next` est posé avant l'écriture disque (ligne 45) : un échec d'écriture laisse la mémoire en avance sur le fichier.

**Correctif.** Patch HTTP : seules les clés de `Settings`; mauvais type ou clé inconnue : erreur (400); `claudePath` non vide après trim; `maxParallel` nombre puis borné 1..32; `permissionMode` dans `PERMISSION_MODES`; `recentProjects` tableau de strings. Chargement : un champ de mauvais type retombe sur son défaut sans exception; fichier JSON illisible : journaliser et conserver une copie `.bak` avant de l'écraser; n'affecter `shared.current` qu'après l'écriture.

**Test.** `settings-reject`, `settings-load-legacy`.

**Statut.** corrigé (2ef7f7a).

### A14 — Aller-retour frontmatter des skills cassé

**Problème.** `createSkill` écrit `description: ${JSON.stringify(desc)}` (skills.ts:80) mais `parseFrontmatter` retire seulement les guillemets (skills.ts:30) : une description contenant `"` ou `\` revient avec des échappements (`say \"hi\" \\ ok`), affichée telle quelle dans la liste des skills.

**Correctif.** Valeur entre guillemets doubles décodée par `JSON.parse` (repli sur l'ancienne règle en cas d'échec); guillemets simples : `''` devient `'`. Ne pas casser les SKILL.md existants (non quotés, blocs `>` et `|`, CRLF, apostrophes).

**Test.** `skills-roundtrip`, `skills-frontmatter-legacy`.

**Statut.** corrigé (6db6d5f).

### A15 — `nightshift.json` invalide : message obscur et écrasement d'une édition externe

**Problème.** `read()` fait `JSON.parse` sans protection (store.ts:226) : à l'ouverture, un fichier invalide renvoie une `SyntaxError` brute (« Unexpected token ... ») sans nom de fichier. Au rechargement par le watcher, l'erreur est avalée (store.ts:256-258) mais `lastWrittenMtime` a déjà été mis à jour (ligne 253) : l'édition externe invalide n'est pas retentée, aucune alerte n'est affichée, et la prochaine mutation en mémoire réécrit le fichier et efface l'édition de l'utilisateur (par exemple un `git pull` en conflit).

**Correctif.** Ouverture : message explicite (« nightshift.json invalide : <chemin> ») en 400. Rechargement : journaliser l'erreur, ne pas mémoriser le mtime d'une lecture échouée (nouvelle tentative au changement suivant), et sauvegarder le fichier invalide (`nightshift.json.invalid`) avant toute réécriture.

**Test.** `store-invalid-json` : fichier invalide à l'ouverture donne une erreur nommant le fichier; édition externe invalide puis mutation conserve une copie du contenu invalide.

**Statut.** corrigé (c2f4a70, 092e62f).

### A16 — Tests : singletons partagés entre fichiers

**Problème.** `bun test` exécute tous les fichiers dans un seul processus avec un cache de modules partagé (sonde : deux fichiers qui posent `NIGHTSHIFT_HOME` avant l'import, le second voit la valeur du premier). `settings.ts:6` lit la variable à l'import et `startServer` réutilise `globalThis.__nightshift`. Les fichiers `test/nightshift.test.ts:6-9` et `test/column-emoji.test.ts:8-9` définissent chacun leur dossier : seul le premier importé compte, le second écrit dans le dossier de l'autre, et l'état (réglages, orchestrateur, projets ouverts) fuit d'un fichier à l'autre. Deux fichiers contournent déjà le problème par un processus enfant (run-progress, screenshots-persist, screenshots-dir). Un fichier qui importerait `settings.ts` sans poser la variable écrirait dans le vrai `~/.nightshift`.

**Correctif.** Documenter et uniformiser la règle : tout test qui démarre un serveur ou touche aux réglages isole `NIGHTSHIFT_HOME` (processus enfant ou helper partagé `test/helpers.ts` qui remet `globalThis.__nightshift` et `__nightshiftSettings` à zéro); `column-emoji.test.ts` utilise le même mécanisme.

**Test.** `tests-isolation` : deux fichiers de test utilisant des `NIGHTSHIFT_HOME` différents ne partagent ni réglages ni projets.

**Statut.** corrigé (8df9332).

### A17 — Routes HTTP sans test de validation ni de codes d'erreur

**Problème.** `test/nightshift.test.ts` couvre le chemin nominal; aucune route n'est testée avec une entrée invalide : JSON invalide (A8), `PUT /api/board` sans colonne ou avec colonne portant des cartes (server.ts:113,117), carte placée dans une colonne inconnue (server.ts:130), nom de skill invalide (skills.ts:75), `PUT /api/settings` invalide (A13).

**Correctif.** Nouveau fichier `test/server-routes.test.ts` (Task 8), serveur en port 0, `NIGHTSHIFT_HOME` temporaire, `agents:false`.

**Test.** `routes-invalid-json`, `routes-validation`.

**Statut.** corrigé (74bfa9e).

### A18 — `settings.ts` sans test

**Problème.** Aucun test ne cible `updateSettings`/`getSettings` (rejets, bornes de `maxParallel`, rechargement d'un fichier ancien).

**Correctif.** `test/settings.test.ts` (Task 6) : `NIGHTSHIFT_HOME` isolé avant import, `globalThis.__nightshiftSettings` remis à zéro entre les cas.

**Test.** `settings-reject`, `settings-load-legacy`.

**Statut.** corrigé (2ef7f7a).

### A19 — `skills.ts` sans test

**Problème.** `parseFrontmatter`, `createSkill`, `listSkills` (priorité projet sur utilisateur) ne sont couverts qu'indirectement.

**Correctif.** `test/skills.test.ts` (Task 7) avec `NIGHTSHIFT_USER_SKILLS` temporaire.

**Test.** `skills-roundtrip`, `skills-frontmatter-legacy`.

**Statut.** corrigé (6db6d5f).

### A20 — README, `.gitignore` et scripts en décalage

**Problème.** (1) `.gitignore:4` ignore `nightshift.json` dans CE dépôt (board de dogfooding) alors que README.md:3 dit « committable » et README.md:28 « commit it » : à préciser. (2) Le serveur n'est pas documenté comme écoutant sur 127.0.0.1 seulement (après A1). (3) README.md:9-10 annonce `bun run dev` « avec hot reload » (la mention est à la ligne 10) mais `package.json:8` définit `dev` comme `bun bin/nightshift.ts`, identique à `start` (pas de `--hot`) ; or `start` tourne en mode développement (HMR et echo console, bin/nightshift.ts:21) tant que `NODE_ENV` n'est pas `production`. (4) Options et variables non documentées : `-p`, `--no-agents`, `PORT`, `NIGHTSHIFT_HOME`, `NIGHTSHIFT_USER_SKILLS`, `NIGHTSHIFT_NO_OPEN`; dossiers `~/.nightshift/screenshots` et `locks`; scripts `lint`, `format`, `check`, `test:coverage`. (5) `README.md` ne mentionne pas Biome.

**Correctif.** Mettre à jour README (phrase sur `nightshift.json` ignoré dans ce dépôt, écoute 127.0.0.1, options, variables, scripts) ; corriger le script `dev` (`bun --hot bin/nightshift.ts`) ou la phrase.

**Test.** aucun : pas de changement de comportement (sauf le script `dev`, vérifié à la main).

**Statut.** corrigé (ffbe957, 60eebd2). README mis à jour (nightshift.json ignoré dans ce dépôt mais à committer dans les projets, écoute 127.0.0.1 seule, options `--port/-p`, `--no-open`, `--no-agents`, `--help`, variables `PORT`, `NIGHTSHIFT_HOME`, `NIGHTSHIFT_USER_SKILLS`, `NIGHTSHIFT_NO_OPEN`, dossiers `screenshots` et `locks`, scripts, Biome). Le script `dev` reste `bun bin/nightshift.ts` (un `--hot` relancerait aussi l'ouverture du projet et du navigateur) : c'est la phrase du README qui a été corrigée. Les lignes citées plus haut sont celles du README avant correction.

### A21 — Lint et format : Biome absent (alias `A-lint`)

**Problème.** Aucun linter ni formateur ; code non formaté de façon homogène.

**Correctif.** Biome ajouté (`biome.json`, scripts `lint`, `format`, `check`, `test:coverage`) et code reformaté sans changement de comportement ; erreurs de lint corrigées. Les commits be6cb27 (`chore(A-lint): add Biome and format codebase`) et 767f30a (`style(A-lint): fix lint findings`) portent l'alias `A-lint` : ils ont été créés avant l'attribution des ids et correspondent à ce constat.

**Test.** aucun : pas de changement de comportement.

**Statut.** corrigé (be6cb27, 767f30a).

### A22 — CLI : échec d'ouverture du navigateur et absence de garde globale

**Problème.** `Bun.spawn(["xdg-open", url])` (bin/nightshift.ts:32-33) lève si l'exécutable est absent (Linux sans `xdg-open`) : exception non gérée après démarrage du serveur. Aucun handler `unhandledRejection`/`uncaughtException`, ni `SIGHUP` : la fermeture du terminal ou une exception laissent des agents orphelins (voir A7). Un argument inconnu est traité comme dossier (ligne 18).

**Correctif.** Entourer l'ouverture du navigateur d'un `try/catch` (message sur stderr); appeler `orch.shutdown()` sur `SIGHUP` et sur exception non gérée; rejeter les options inconnues (`--foo`) avec l'usage.

**Test.** aucun : pas de changement de comportement testable de façon stable (sauf option inconnue : test `parseArgs`).

**Statut.** corrigé (60eebd2). Test : `cli-sighup` (échoue avant), `cli-browser-missing` (helper `openBrowser` qui ne lève plus). L'option inconnue était déjà rejetée par `parseArgs` (Task 5).

### A23 — Orchestrateur : mémoire et fichiers de log jamais purgés

**Problème.** `logs` et `lastTestLines` (orchestrator.ts:212,219) gardent jusqu'à 3000 lignes par carte pour toute la durée du processus, y compris pour les cartes supprimées; `~/.nightshift/logs/<hash>/<carte>.jsonl` n'est jamais supprimé quand la carte l'est (seules les captures le sont, server.ts:170). `log()` avale les erreurs d'écriture (`catch {}`, ligne 358).

**Correctif.** À la suppression d'une carte : retirer ses entrées en mémoire et son fichier de log; journaliser (stderr) une seule fois un échec d'écriture de log.

**Test.** `card-delete-cleans-logs` : après DELETE, le fichier de log n'existe plus.

**Statut.** corrigé (4830f69). Test : `card-delete-cleans-logs`.

### A24 — Sortie des commandes de test : dernière ligne sans saut de ligne perdue

**Problème.** Le tampon `buf` du flux (orchestrator.ts:836-847) n'est jamais vidé à la sortie du processus : une dernière ligne sans `\n` (cas courant : `printf`, message d'erreur final) n'apparaît pas dans le journal de test.

**Correctif.** Vider le reste du tampon à la fermeture de chaque flux (`end`/`close`) avant le message « Exited ».

**Test.** `test-output-last-line` : `printf last` apparaît dans `testLog`.

**Statut.** corrigé (a8c718c). Test : `test-output-last-line`. « Exited » attend la fin des flux (bornée à 500 ms si un processus fils garde les tubes ouverts).

### A25 — Codes HTTP : tout est 400

**Problème.** `fail` renvoie 400 pour toute exception, y compris « Unknown card », « Unknown project », « Skill not found » (404 attendu) et les erreurs inattendues (500 attendu) (server.ts:38).

**Correctif.** Classe `HttpError(status, message)` dans `guard.ts`; « Unknown card », « Unknown project », « Skill not found » lèvent `HttpError(404)`; autre `Error` : 400; erreur inattendue (non `Error`) : 500 avec `console.error`. Vérifier que l'UI et les tests existants n'en dépendent pas.

**Test.** `routes-status-codes` (PATCH /api/cards/:id inconnue, projet inconnu, GET /api/skill inconnu : 404 `{error}`).

**Statut.** corrigé (a02291c). Test : `routes-status-codes`. Le test `routes-unknown-project` (A9) attend désormais 404 « Unknown project » au lieu de 400 ; « Missing project » reste 400.

### A26 — Skills : écriture non atomique et erreurs avalées

**Problème.** `saveSkill` (skills.ts:70) et `createSkill` (ligne 81) font `writeFileSync` direct sur SKILL.md : une interruption laisse un fichier tronqué (`store.ts` et `settings.ts` écrivent déjà via tmp + rename). `scan` avale toute erreur de lecture (`catch {}`, ligne 45) : un skill illisible disparaît de la liste sans trace.

**Correctif.** Écriture tmp + `renameSync` dans le même dossier (helper partagé) ; journaliser (`console.warn`) un skill ignoré.

**Test.** `skills-save-atomic` : aucun `.tmp` restant, contenu écrit en entier.

**Statut.** corrigé (793a65b). Test : `skills-save-atomic` (un lien dur vers l'ancien fichier garde son contenu, donc l'écriture passe bien par un rename). Helper partagé `src/server/fsutil.ts` (aussi utilisé par `store.ts` et `settings.ts`).

### A27 — Store : échec d'écriture et surveillance fragiles

**Problème.** `mutate` applique la fonction sur le board en mémoire puis écrit (store.ts:271-276) : si l'écriture échoue (disque plein, dossier en lecture seule), la mémoire garde la mutation et les écouteurs ne sont pas notifiés : divergence jusqu'au prochain rechargement. `watch()` avale l'échec (`catch {}`, ligne 246) : sans watcher, plus aucun rechargement externe, sans message. Le `FSWatcher` n'a pas d'écouteur `error`. `write()` avale l'échec de `statSync` (ligne 237). Le `setTimeout` de 50 ms du watcher n'est pas annulé par `close()`.

**Correctif.** Journaliser l'échec de `watch`, ajouter un écouteur `error`, annuler le timer à `close()`; en cas d'échec d'écriture, recharger l'état disque ou rétablir la mutation avant de relancer l'erreur.

**Test.** `store-write-failure` : écriture impossible (dossier en lecture seule) lève et laisse le board mémoire identique au fichier.

**Statut.** corrigé (27ddf12). Test : `store-write-failure` (le fichier temporaire est un dossier, l'écriture échoue même pour root). `mutate` restaure aussi l'état mémoire si la fonction de mutation lève.

### A28 — Client : WebSocket sans reprise propre, promesses sans `catch`

**Problème.** `connect()` rouvre le socket toutes les 1000 ms sans plafond (api.ts:59) et `JSON.parse(m.data)` n'est pas protégé (ligne 56); `api.settings().then(setSettings)` n'a pas de `catch` (ligne 75) : rejet non géré dans le navigateur au premier échec (par exemple 403 de la garde A1). `App.tsx:44-50` ne tient pas compte des réponses d'ouverture obsolètes : changer vite de projet peut afficher le board du projet précédent.

**Correctif.** Backoff plafonné, `try/catch` autour du parse, `catch` qui affiche l'erreur, annulation (drapeau `cancelled`) dans l'effet d'ouverture.

**Test.** aucun : pas de changement de comportement testable de façon stable.

**Statut.** corrigé (9628976). Tests : `client-reconnect`, `client-parse` (fonctions pures `reconnectDelay`, `parseServerEvent`). L'annulation de l'effet d'ouverture de projet n'a pas de test (pas de DOM dans la suite).

### A29 — Fiche : erreurs avalées puis action poursuivie

**Problème.** `guard()` convertit l'échec en `setError` puis résout (CardModal.tsx:96) : `guard(api.deleteCard(...)).then(onClose)` ferme la fiche même si la suppression a échoué (ligne 122, l'erreur n'est plus visible); `guard(api.answer(...)).then(() => setAnswers([]))` vide les réponses saisies en cas d'échec (ligne 213); la fermeture avec modifications lance `save()` puis démonte la fiche (lignes 112-114) : l'échec de sauvegarde n'est jamais montré.

**Correctif.** Faire retourner à `guard` un booléen (ou relancer) et n'enchaîner `onClose` / `setAnswers([])` qu'en cas de succès; afficher l'erreur de sauvegarde à la fermeture via la bannière de l'application.

**Test.** aucun : pas de changement de comportement testable de façon stable.

**Statut.** corrigé (9628976). Test : `card-modal-failed-action` (`attempt`, `deleteThenClose`, `sendThenClear`). Une sauvegarde qui échoue à la fermeture est signalée dans la bannière de l'application (la fiche se ferme quand même).

### A30 — Tests : attentes par `sleep` fixe et dossiers temporaires jamais supprimés

**Problème.** `test/nightshift.test.ts` utilise 17 `Bun.sleep` fixes (lignes 123, 197, 218, 451, 721, 815, 830, 849, 866, 893, 913, 936, 988, 1010, 1049, 1093, 1432), dont plusieurs pour affirmer qu'un événement ne se produit pas (attentes de 300-400 ms, sensibles à la charge machine); `test/run-progress.test.ts:98,128` et `test/time-panel.test.tsx:94,98` idem. Les `mkdtempSync` (33 dans nightshift.test.ts, 3 dans column-emoji, 3 dans run-progress, etc.) ne sont jamais supprimés : `/tmp` se remplit à chaque exécution. La suite dure ~29 s (`fake-claude` dort 5 s pour « slow »).

**Correctif.** Remplacer les attentes d'absence par une condition observable (`waitFor`) ou un délai borné et commenté; nettoyer les dossiers dans `afterAll`.

**Test.** aucun : pas de changement de comportement (suite relancée 3 fois, verte).

**Statut.** corrigé (9c16e79, 05b9ca5, d6e5022). Les attentes d'absence passent par `quiet()` (délai borné et commenté) ; les mtime sont fixés dans le passé au lieu d'attendre ; les dossiers temporaires sont supprimés (`tempDir` / `removeTempDirs`, arrêt du serveur enfant).

### A31 — Règle Biome désactivée : `suspicious/noExplicitAny` (86 occurrences)

**Problème.** Désactivée par la Task 1 (réécriture risquée). Répartition : test/nightshift.test.ts 49, src/server/store.ts 13, src/server/orchestrator.ts 8, src/server/server.ts 4, test/run-progress.test.ts 4, test/screenshots-persist.test.ts 3, un exemplaire dans bin/nightshift.ts, settings.ts, ColumnsEditor.tsx, SkillsModal.tsx, api.ts. Le `body: any` de `h` (server.ts:42) masque les erreurs de A10 à A12.

**Correctif.** Typer ce qui est faisable sans réécriture risquée (corps de requête en `unknown` validé, `catch (e: unknown)`), sinon laisser la règle désactivée avec la raison documentée ici ; ne pas réactiver globalement.

**Test.** aucun : pas de changement de comportement.

**Statut.** corrigé (238ab45). Plus aucun `any` explicite (corps de requête `Raw`, événements du flux `claude` et sortie structurée typés). Règle réactivée, aucune exception.

### A32 — Règle Biome désactivée : `style/noNonNullAssertion` (138 occurrences)

**Problème.** Désactivée par la Task 1. Principaux fichiers : src/web/markdown.tsx 34, test/nightshift.test.ts 27, src/server/server.ts 16, orchestrator.ts 7, skills.ts 7, store.ts 6, plus 20 fichiers de 1 à 5. Beaucoup sont justifiées (`noUncheckedIndexedAccess`).

**Correctif.** Corriger les occurrences de `src/server` où un contrôle explicite est simple ; la règle reste désactivée si le reste exige une réécriture, avec la raison documentée (index vérifiés par construction, `noUncheckedIndexedAccess`).

**Test.** aucun : pas de changement de comportement.

**Statut.** corrigé (6513886). Toutes les assertions retirées (les types suffisent) ; les autres sont devenues des gardes explicites. Règle réactivée.

### A33 — Règle Biome désactivée : `suspicious/noArrayIndexKey` (24 occurrences)

**Problème.** Désactivée par la Task 1. Clés d'index dans des listes React (lignes de log TestPanel.tsx:123, CardModal, ColumnsEditor, markdown.tsx…). Pour les listes qui ne sont pas réordonnées (lignes de log, blocs markdown) l'index est sans effet.

**Correctif.** Utiliser une clé stable quand l'élément en a une (`ColumnsEditor` a déjà `key`), sinon `biome-ignore` justifié (liste en ajout seul).

**Test.** aucun : pas de changement de comportement.

**Statut.** corrigé (49b046f). Clés stables pour `TimePanel`, rendu Markdown par un `Fragment` par nœud ; `biome-ignore` justifiés pour les listes en ajout seul. Règle réactivée.

### A34 — Règles Biome désactivées : `noAssignInExpressions` (4), `noImplicitAnyLet` (3), `useIterableCallbackReturn` (3)

**Problème.** Désactivées par la Task 1. `noAssignInExpressions` : orchestrator.ts:194,684,842 (boucles `while ((nl = buf.indexOf(...)) >= 0)`) et settings.ts:20 (`??=`). `noImplicitAnyLet` : orchestrator.ts:193,683,841. `useIterableCallbackReturn` : orchestrator.ts:791, markdown.tsx:488,531.

**Correctif.** Réécritures locales sans risque (`let m: RegExpExecArray | null`, `for (;;)`, `forEach` à bloc) ; réactiver les trois règles si tout passe.

**Test.** aucun : pas de changement de comportement (tests existants de découpage de lignes).

**Statut.** corrigé (9cee1fd). Les trois règles sont réactivées.

### A35 — Règle Biome désactivée : `suspicious/noControlCharactersInRegex` (3 occurrences)

**Problème.** orchestrator.ts:843 (retrait des séquences ANSI `\x1b[...m`) et markdown.tsx:281 (rejet des caractères de contrôle dans une URL, 2 occurrences) : les caractères de contrôle sont voulus.

**Correctif.** Réactiver la règle et ajouter `biome-ignore lint/suspicious/noControlCharactersInRegex: <raison>` sur ces deux lignes.

**Test.** aucun : pas de changement de comportement.

**Statut.** corrigé (9cee1fd). Règle réactivée avec `biome-ignore` justifié sur les trois expressions (orchestrator.ts ANSI, markdown.tsx `safeHref`).

### A36 — Règle Biome désactivée : `correctness/useExhaustiveDependencies` (15 occurrences)

**Problème.** Désactivée par la Task 1. Effets avec dépendances volontairement partielles (ex. TestPanel.tsx:29-36 : `[card.id]`, `useServerEvents` via ref). Les corriger peut relancer des effets (rechargement des logs, réouverture de projet).

**Correctif.** Corriger les cas évidents ; sinon `biome-ignore` justifié par cas, ou règle laissée désactivée avec la raison documentée ici. Pas de changement de comportement sans test.

**Test.** aucun : pas de changement de comportement.

**Statut.** corrigé (d478937). Dépendances complétées (callbacks mémoïsés, `dirty` et `editing` lus par ref, aucune boucle de rechargement) ; deux `biome-ignore` justifiés pour les effets de défilement. Règle réactivée.

### A37 — Règle Biome désactivée : `a11y/useButtonType` (39 occurrences)

**Problème.** Désactivée par la Task 1. Boutons sans `type` : CardModal.tsx 10, App.tsx 7, ColumnsEditor.tsx 6, TestPanel.tsx 5, ProjectPicker.tsx 3, SkillsModal.tsx 3, SettingsModal.tsx 2, ui.tsx 2, NextColumnButton.tsx 1. Dans un `<form>`, un bouton sans `type` soumet le formulaire.

**Correctif.** Ajouter `type="button"` (ou `submit` là où c'est voulu, ex. TestPanel.tsx:79) puis réactiver la règle. Vérifier visuellement les formulaires (TestPanel, FeedbackForm, ProjectPicker).

**Test.** aucun : pas de changement de comportement (les tests de rendu existants passent).

**Statut.** corrigé (dc6b198). Les 39 boutons étaient hors formulaire : `type="button"`. Règle réactivée.

### A38 — Règles Biome a11y désactivées (12 occurrences)

**Problème.** `noAutofocus` (3 : App.tsx:376, CardModal.tsx:229, TestPanel.tsx:68), `useKeyWithClickEvents` (2 : Screenshot.tsx:25,41), `noStaticElementInteractions` (2 : App.tsx:159, ui.tsx:23), `noNoninteractiveTabindex` (2 : CardModal.tsx:191, CardTile.tsx:55), `useSemanticElements` (2 : DoneColumn.tsx:50,73), `noNoninteractiveElementToInteractiveRole` (1 : DoneColumn.tsx:50).

**Correctif.** Corriger ce qui est simple (clavier sur la lightbox, rôles) ; l'autofocus et les overlays (fermeture au clic hors modale) sont des choix d'interaction : `biome-ignore` justifié ou règle laissée désactivée avec la raison documentée ici.

**Test.** aucun : pas de changement de comportement.

**Statut.** corrigé (3952e50). Capture ouverte par un vrai `<button>` (clavier) ; `biome-ignore` justifiés pour l'autofocus, les clics hors modale et la fiche focusable. Règle réactivée. Test : `card-screenshot-keyboard-open`.

### A39 — Avertissements Biome restants (12)

**Problème.** `bunx biome check .` sort 0 mais signale : `noDescendingSpecificity` (7 : markdown.css:127,146,160,218 ; picker.css:71,72,121), `noImportantStyles` (4 : styles.css:395-398), `noCommaOperator` (1 : test/nightshift.test.ts:1387).

**Correctif.** Réordonner les sélecteurs CSS sans changer le rendu, supprimer les `!important` si la cascade le permet (sinon `biome-ignore` justifié), remplacer l'opérateur virgule du test.

**Test.** aucun : pas de changement de comportement.

**Statut.** corrigé (9a0aa10, 9cee1fd). `noDescendingSpecificity` corrigé par réordonnancement, `!important` du mode « mouvement réduit » justifié par `biome-ignore`, opérateur virgule du test supprimé (A34), dépréciation `recommended` de `biome.json` migrée.

## Open questions

Aucune : aucun constat n'est reporté, toutes les règles Biome sont réactivées.
