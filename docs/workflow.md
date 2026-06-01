# Workflow — VPS Monitor

## Vue d'ensemble

Le projet est divisé en 5 phases. Chaque phase doit être complète et fonctionnelle avant de passer à la suivante.

---

## Phase 1 — MVP : API Docker + Frontend minimal

### Étape 1 — Initialiser la structure du projet

Créer l'arborescence suivante à la racine du repo :

```
vps-monitor-app/
├── api/
│   ├── server.js
│   └── services/
│       └── docker.js
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── Dockerfile
└── .dockerignore
```

### Étape 2 — Mettre en place le backend Node.js

- Initialiser le projet Node : `npm init -y`
- Installer les dépendances : `npm install express dockerode`
- Créer `api/services/docker.js` : connexion au socket Docker (`/var/run/docker.sock`) via `dockerode`, exposer une fonction qui liste tous les containers avec nom, statut, ports exposés, uptime et image
- Créer `api/server.js` : serveur Express qui :
  - Monte le dossier `public/` en statique
  - Expose `GET /api/status` retournant les données containers + statut global
- Tester localement : `node api/server.js`, vérifier `http://localhost:3000/api/status`

### Étape 3 — Créer le frontend statique

- `public/index.html` : structure HTML simple avec une section "Containers" et un indicateur de statut global
- `public/style.css` : styles minimalistes, couleurs vert/rouge/orange pour les statuts
- `public/app.js` : fetch sur `/api/status` toutes les 5 secondes, mise à jour du DOM sans rechargement

### Étape 4 — Dockeriser l'application

- Écrire le `Dockerfile` :
  - Image de base : `node:20-alpine`
  - Copier les sources, installer les dépendances, exposer le port 3000
  - CMD : `node api/server.js`
- Écrire `.dockerignore` : exclure `node_modules`, `.git`
- Tester le build : `docker build -t vps-monitor .`
- Tester le container : `docker run -p 3020:3000 -v /var/run/docker.sock:/var/run/docker.sock vps-monitor`
- Vérifier `http://localhost:3020`

### Étape 5 — Intégrer dans docker-compose

Ajouter le service dans le `docker-compose.yml` existant du VPS :

```yaml
vps-monitor:
  build: ./vps-monitor
  container_name: vps-monitor
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
  ports:
    - "3020:3000"
  restart: unless-stopped
```

Lancer : `docker-compose up -d vps-monitor`

### Étape 6 — CI/CD : lint, tests et déploiement automatique sur staging

#### Objectif

À chaque push sur la branche `staging`, GitHub Actions doit :
1. Vérifier la qualité du code (lint)
2. Lancer les tests
3. Déployer automatiquement sur le VPS via SSH

#### 6.1 — Mettre en place ESLint

Installer ESLint dans `vps-monitor-app/` :

```bash
npm install --save-dev eslint @eslint/js
```

Créer `vps-monitor-app/eslint.config.js` :

```js
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': 'warn',
      'no-console': 'off',
    },
  },
];
```

Ajouter le script dans `package.json` :

```json
"lint": "eslint api/ public/"
```

#### 6.2 — Mettre en place les tests

Installer les dépendances de test :

```bash
npm install --save-dev jest supertest
```

Créer `vps-monitor-app/api/server.test.js` :

```js
const request = require('supertest');
const app = require('./server');

describe('GET /api/status', () => {
  it('répond 200 avec la structure attendue', async () => {
    const res = await request(app).get('/api/status');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('containers');
    expect(res.body).toHaveProperty('websites');
    expect(res.body).toHaveProperty('globalStatus');
  });
});
```

> Pour que `supertest` fonctionne, `server.js` doit exporter `app` sans appeler `listen` directement — séparer l'export de app et le démarrage du serveur.

Ajouter le script dans `package.json` :

```json
"test": "jest"
```

#### 6.3 — Créer le workflow GitHub Actions

Créer `.github/workflows/staging.yml` à la racine du repo :

```yaml
name: CI + Deploy staging

on:
  push:
    branches:
      - staging

jobs:
  ci:
    name: Lint & Test
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: vps-monitor-app/package-lock.json

      - name: Install dependencies
        run: npm ci
        working-directory: vps-monitor-app

      - name: Lint
        run: npm run lint
        working-directory: vps-monitor-app

      - name: Test
        run: npm test
        working-directory: vps-monitor-app

  deploy:
    name: Deploy to VPS
    runs-on: ubuntu-latest
    needs: ci

    steps:
      - name: SSH deploy
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /var/www/VPS-monitor
            git pull origin staging
            cd /var/www
            docker-compose build vps-monitor
            docker-compose up -d vps-monitor
```

#### 6.4 — Configurer les secrets GitHub

Dans le repo GitHub → Settings → Secrets and variables → Actions, ajouter :

| Secret | Valeur |
|---|---|
| `VPS_HOST` | IP ou domaine du VPS |
| `VPS_USER` | `rusty` |
| `VPS_SSH_KEY` | Clé SSH privée (contenu de `~/.ssh/id_rsa`) |

#### 6.5 — Créer la branche staging

```bash
git checkout -b staging
git push origin staging
```

Tout push sur `staging` déclenchera le pipeline. La branche `main` reste la branche stable.

---

## Phase 2 — Monitoring HTTP des applications web

### Étape 7 — Créer le service de vérification HTTP

- Créer `api/services/http.js` : liste des URLs à vérifier, fonction qui effectue un GET sur chacune avec timeout, retourne nom + URL + code HTTP + statut (OK / DOWN)

URLs à monitorer :

| Application | Chemin |
|---|---|
| TP Vue | `/B3dev-TP_VUE/` |
| SaintBarth Volley | `/saintbarthvolley/` |
| Lucky7 | `/lucky7/` |
| College La Boussole | `/collegelaboussole/` |
| Cinemap | `/cinemap/` |

### Étape 8 — Étendre l'endpoint `/api/status`

- Appeler `http.js` en parallèle avec `docker.js`
- Ajouter le champ `websites` dans la réponse JSON
- Calculer `globalStatus` : `"OK"` si tout est up, `"DEGRADED"` ou `"KO"` sinon

### Étape 9 — Mettre à jour le frontend

- Ajouter une section "Applications web" dans `index.html`
- Mettre à jour `app.js` pour afficher les statuts HTTP avec indicateurs visuels (vert/rouge)
- Afficher le nombre total de services OK / KO en en-tête

---

## Phase 3 — Actions sur les containers + Sécurité

### Étape 10 — Ajouter les actions Docker

- Ajouter `POST /api/container/restart` dans `server.js` : reçoit `{ "name": "container-name" }`, appelle dockerode pour redémarrer le container
- Ajouter (optionnel) `POST /api/container/stop` et `POST /api/container/start`
- Tester chaque action manuellement

### Étape 11 — Ajouter l'authentification

- Choisir une méthode simple : variable d'environnement pour login/password, middleware Express qui vérifie un header ou cookie de session
- Protéger toutes les routes `/api/*` et la page principale
- Stocker les credentials dans une variable d'environnement (ne pas hardcoder)
- Mettre à jour le `docker-compose.yml` pour passer les variables d'env

### Étape 12 — Mettre à jour le frontend pour les actions

- Ajouter un bouton "Restart" sur chaque carte container
- Envoyer le POST correspondant au clic, rafraîchir le statut après réponse
- Ajouter une page/formulaire de login si l'authentification est active

---

## Phase 4 — Intégration Nginx + Évolutions

### Étape 13 — Remplacer la homepage Nginx

Modifier la configuration Nginx existante pour rediriger `/` vers le container :

```nginx
location / {
    proxy_pass http://127.0.0.1:3020;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Recharger Nginx : `nginx -t && nginx -s reload`

### Étape 14 — Tests de non-régression

- Vérifier que toutes les applications existantes sont toujours accessibles via leurs routes (`/saintbarthvolley/`, etc.)
- Vérifier que la homepage affiche bien le dashboard
- Simuler un container arrêté et vérifier l'affichage (statut rouge)
- Simuler un service HTTP down et vérifier l'affichage

### Étape 15 — Logs en temps réel via WebSocket

#### Objectif

Afficher les logs d'un container en temps réel dans une modale, avec streaming continu (équivalent `docker logs --follow`).

#### 15.1 — Installer le package WebSocket

```bash
npm install ws
```

#### 15.2 — Mettre à jour `api/services/docker.js`

Ajouter la fonction `streamContainerLogs(name, tail, onData, onEnd)` :

- Appelle `container.logs({ follow: true, tail, stdout: true, stderr: true })`
- Utilise `docker.modem.demuxStream` + deux `PassThrough` pour séparer stdout/stderr
- Retourne le stream brut afin que l'appelant puisse le `destroy()` à la déconnexion

#### 15.3 — Mettre à jour `api/server.js`

- Extraire le middleware `session(...)` dans une variable `sessionMiddleware` pour le réutiliser
- Remplacer `app.listen()` par `http.createServer(app)` + `server.listen()`
- Créer un `WebSocketServer({ noServer: true })`
- Écouter l'événement `upgrade` sur le serveur HTTP : parser la session via `sessionMiddleware`, rejeter avec 401 si non authentifié, sinon déléguer à `wss.handleUpgrade`
- Sur `wss.on('connection')` : lire `name` et `tail` dans l'URL, démarrer `streamContainerLogs`, envoyer chaque chunk via `ws.send()`, détruire le stream Docker à la fermeture du WebSocket

Le chemin d'écoute WebSocket est `/ws/logs?name=<container>&tail=200`.

#### 15.4 — Mettre à jour `public/app.js`

- Remplacer le `fetch` de `showLogs` par une connexion `WebSocket`
- Construire l'URL : `ws://` ou `wss://` selon le protocole courant
- Ajouter les messages au `<pre>` au fil des events `onmessage`, avec auto-scroll
- Stocker le socket dans `activeLogSocket` pour le fermer proprement dans `closeLogs()`

#### 15.5 — Tester

```bash
# Depuis le VPS
docker logs <container> --follow   # comportement attendu
# Dans l'app : cliquer "Logs" → la modale doit streamer en direct
```

---

## Phase 5 — GitOps Dashboard

### Contexte & État actuel

### Ton infrastructure

Tu as un VPS Debian 12 (`78.138.58.95`) configuré en **multi-app** :
- **Nginx** joue le rôle de reverse proxy — il reçoit toutes les requêtes et les redirige vers le bon container selon la route (`/saintbarthvolley/`, `/lucky7/`, etc.)
- **Docker** fait tourner chaque application dans un container isolé
- **vps-monitor** tourne sur le port `3020` et est le point d'entrée de `/`

#### Tes deux repos actuels

| Repo | Rôle actuel |
|------|-------------|
| `VPS-monitor` | L'application de monitoring |
| `vps-config` | Les fichiers de configuration de l'infra |

> ⚠️ **Décision prise : fusionner les deux repos en un seul.**
> `vps-config` sera supprimé. Tout sera dans `VPS-monitor`.

#### Ce qui est déployé aujourd'hui

Uniquement `vps-monitor` (v0.4.2). Les autres apps (SBV, Lucky7, CLB, CineMap, etc.) sont listées dans `vps-config` mais pas encore redéployées après le reset.

#### Le problème que ça résout

Aujourd'hui, pour déployer une app ou modifier une config, tu dois :
1. SSH dans le VPS
2. Éditer le fichier à la main
3. Recharger nginx / relancer docker
4. Pusher la modif sur GitHub manuellement

Avec la Phase 5, **tout ça se fait depuis le dashboard**, sans terminal.

---

### Fusion des repos — Nouvelle structure

#### Pourquoi fusionner

`vps-config` n'existait que comme sauvegarde des configs. Maintenant que le dashboard *gère* ces configs, les avoir dans deux repos séparés crée de la complexité inutile (deux remotes, deux push, deux pipelines). En fusionnant :

- **Un seul `git clone`** pour tout reconfigurer après un reset VPS
- **Un seul `git push`** quand le dashboard modifie un fichier
- **Une seule pipeline CI/CD**
- **Un seul endroit** à regarder sur GitHub

#### Nouvelle structure du repo `VPS-monitor`

```
VPS-monitor/
├── app/                             ← code de vps-monitor (renommé depuis vps-monitor-app/)
│   ├── api/
│   │   ├── server.js
│   │   └── services/
│   │       ├── docker.js
│   │       ├── http.js
│   │       ├── git.js               ← NOUVEAU
│   │       ├── nginx.js             ← NOUVEAU
│   │       └── deploy.js            ← NOUVEAU
│   ├── public/
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   ├── Dockerfile
│   └── package.json
├── nginx/
│   └── sites-enabled/
│       └── vps                      ← config nginx du VPS
├── apps/
│   ├── sbv/
│   │   └── docker-compose.yml
│   ├── lucky7/
│   │   └── docker-compose.yml
│   ├── clb/
│   │   └── docker-compose.yml
│   ├── cinemap/
│   │   └── docker-compose.yml
│   └── tp-vue/
│       └── docker-compose.yml
├── docker-compose.yml               ← compose racine du VPS
├── .env.example
└── README.md
```

---

### Ce qu'on va construire

#### Vue d'ensemble du dashboard

```
┌─────────────────────────────────────────────────────────┐
│                   VPS Monitor Dashboard                  │
│                                                         │
│  [Containers]  [Sites web]  [Configs]  [Déploiement]    │
│                               ↑            ↑            │
│                           NOUVEAU       NOUVEAU         │
└─────────────────────────────────────────────────────────┘
```

#### Section 1 — Éditeur de config

Un éditeur de fichiers texte intégré pour modifier directement :
- La config Nginx (`nginx/sites-enabled/vps`)
- Les `docker-compose.yml` de chaque app (`apps/*/docker-compose.yml`)

**Flux d'une modification :**
```
Tu édites dans le dashboard
        ↓
API vps-monitor écrit le fichier sur le disque VPS
        ↓
git add → commit → push sur GitHub (VPS-monitor)
        ↓
Si nginx modifié : nginx -t && systemctl reload nginx
        ↓
Confirmation ✅ dans le dashboard
```

#### Section 2 — Panneau de déploiement

Un panneau pour gérer le cycle de vie de tes apps sans SSH :

| Action | Ce que ça fait |
|--------|----------------|
| **Déployer** | `git clone` le repo de l'app + `docker compose up -d` |
| **Mettre à jour** | `git pull` + `docker compose up -d --build` |
| **Stop / Start / Restart** | Déjà existant dans vps-monitor |

---

### Architecture technique

#### Le pattern GitOps

```
GitHub (VPS-monitor)  ←──── source de vérité unique
        ↑
        │ git push (automatique après chaque modif depuis le dashboard)
        │
Disque VPS (/var/www/VPS-monitor/)
        ↑
        │ lit et écrit les fichiers
        │
API vps-monitor (Node.js + Express)
        ↑
        │ appels HTTP
        │
Dashboard (HTML/JS vanilla)
```

#### Auth GitHub : Personal Access Token (PAT)

Le VPS doit pouvoir pusher sur `VPS-monitor`. On utilise un **GitHub PAT** :

**Pourquoi PAT plutôt que clé SSH ?**
- Stocké dans le `.env` → sauvegardé dans `.env.example` sur GitHub
- Si le VPS est resetté, tu colles le token dans le `.env` et c'est reparti
- Pas de clé SSH à regénérer et réenregistrer sur GitHub à chaque fois

**Scope nécessaire du token :** `repo` (accès lecture/écriture sur tes repos privés)

#### Nouvelles variables d'environnement

```env
# .env de vps-monitor (à ajouter)
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_USER=RustyRory
VPSCONFIG_PATH=/var/www/VPS-monitor
```

#### Nouvelles routes API

```
GET    /api/config/files           → liste les fichiers éditables
GET    /api/config/file?path=...   → lit le contenu d'un fichier
POST   /api/config/file            → écrit + commit + push
POST   /api/config/nginx/reload    → nginx -t && reload

GET    /api/deploy/apps            → liste les apps (depuis apps/)
POST   /api/deploy/clone           → git clone une app + docker compose up -d
POST   /api/deploy/update          → git pull + rebuild
GET    /api/deploy/status/:app     → statut de déploiement d'une app
```

---

### Étapes

### Étape 17 — Préparer la fusion des repos (hors code)

#### 17.1 — Restructurer le repo VPS-monitor sur GitHub

```bash
# 1. Renommer vps-monitor-app/ → app/
# 2. Créer les dossiers nginx/ et apps/
# 3. Copier les fichiers de vps-config dans VPS-monitor
# 4. Committer et pusher
git add .
git commit -m "chore: fusion vps-config dans vps-monitor"
git push
```

#### 17.2 — Mettre à jour le chemin sur le VPS

```bash
cd /var/www/vps-monitor
git pull
# Vérifier que la structure correspond bien à la nouvelle arborescence
```

#### 17.3 — Supprimer vps-config

Une fois la fusion vérifiée et fonctionnelle :
- Archiver ou supprimer le repo `vps-config` sur GitHub
- Supprimer `/var/www/vps-config` sur le VPS si présent

#### 17.4 — Générer le GitHub PAT

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token → scope `repo` coché
3. Copier le token (il ne s'affiche qu'une fois)
4. L'ajouter dans le `.env` sur le VPS : `GITHUB_TOKEN=ghp_xxx`
5. L'ajouter dans `.env.example` : `GITHUB_TOKEN=`

#### 17.5 — Configurer git sur le VPS

```bash
git config --global user.email "mail"
git config --global user.name "RustyRory"

# Configurer l'URL remote pour utiliser le token HTTPS
source /var/www/vps-monitor/.env
git -C /var/www/vps-monitor remote set-url origin https://${GITHUB_TOKEN}@github.com/RustyRory/vps-monitor.git
```

---

### Étape 18 — Service git.js

Créer `app/api/services/git.js` :

```javascript
// Fonctions exposées :
// - getFileContent(relativePath)            → lit un fichier du repo
// - writeAndCommit(relativePath, content)   → écrit + git add + commit + push
// - listEditableFiles()                     → retourne nginx/ et apps/*/docker-compose.yml
```

Utilise `child_process.exec` pour les commandes git et `fs.readFile` / `fs.writeFile` pour les fichiers.

---

### Étape 19 — Service nginx.js

Créer `app/api/services/nginx.js` :

```javascript
// Fonctions exposées :
// - testConfig()   → exécute nginx -t, retourne { ok: true/false, output }
// - reload()       → exécute systemctl reload nginx
```

⚠️ Nécessite que le process node puisse exécuter sudo nginx et sudo systemctl.
À configurer dans `/etc/sudoers` sur le VPS :
```
rusty ALL=(ALL) NOPASSWD: /usr/sbin/nginx, /bin/systemctl reload nginx
```

---

### Étape 20 — Routes API Config

Dans `app/api/server.js`, ajouter les routes `/api/config/*` (protégées par `requireAuth`) :

```
GET  /api/config/files          → appelle git.listEditableFiles()
GET  /api/config/file           → appelle git.getFileContent(path)
POST /api/config/file           → appelle git.writeAndCommit(path, content)
POST /api/config/nginx/reload   → appelle nginx.testConfig() puis nginx.reload()
```

---

### Étape 21 — Service deploy.js

Créer `app/api/services/deploy.js` :

```javascript
// Fonctions exposées :
// - listApps()           → lit apps/ et retourne la liste avec statut (déployée ou non)
// - cloneApp(name, url)  → git clone dans /var/www/ + docker compose up -d
// - updateApp(name)      → git pull + docker compose up -d --build
// - getAppStatus(name)   → vérifie si le dossier existe + container running
```

---

### Étape 22 — Routes API Deploy

Dans `server.js`, ajouter les routes `/api/deploy/*` (protégées par `requireAuth`) :

```
GET  /api/deploy/apps           → appelle deploy.listApps()
POST /api/deploy/clone          → appelle deploy.cloneApp(name, url)
POST /api/deploy/update         → appelle deploy.updateApp(name)
GET  /api/deploy/status/:app    → appelle deploy.getAppStatus(name)
```

---

### Étape 23 — Frontend : onglet Configs

Dans `index.html` + `app.js` : nouvel onglet "Configs" avec :
- Liste des fichiers éditables (nginx + docker-compose par app)
- Clic sur un fichier → modale avec `<textarea>` pré-rempli du contenu
- Bouton "Sauvegarder" → POST `/api/config/file` → confirmation ✅
- Si fichier nginx : bouton "Recharger Nginx" → POST `/api/config/nginx/reload`

---

### Étape 24 — Frontend : onglet Déploiement

Dans `index.html` + `app.js` : nouvel onglet "Déploiement" avec :
- Liste des apps connues (depuis `apps/`)
- Badge : déployée 🟢 / non déployée ⚪
- Bouton "Déployer" (si absente) ou "Mettre à jour" (si présente)
- Champ URL repo GitHub pour les nouvelles apps
- Output en temps réel via WebSocket (déjà en place)

---

### Étape 25 — Tests end-to-end

- Modifier un `docker-compose.yml` → vérifier le fichier sur le VPS ET le commit sur GitHub
- Modifier la config nginx → vérifier le reload + que les apps répondent toujours
- Déployer une app depuis le dashboard → container qui apparaît dans le monitoring
- Mettre à jour une app → rebuild visible dans les logs

---

### Étape 26 — Mettre à jour le README

Réécrire `README.md` de `VPS-monitor` pour refléter la nouvelle structure et la nouvelle procédure de zéro :

```bash
# Reconfigurer le VPS de zéro (nouvelle procédure simplifiée)

# 1. Cloner le repo
git clone https://github.com/RustyRory/VPS-monitor.git /var/www/VPS-monitor

# 2. Configurer le .env
cp .env.example app/.env
nano app/.env  # remplir les secrets + GITHUB_TOKEN

# 3. Configurer git avec le token
cd /var/www/vps-monitor
git remote set-url origin https://<TOKEN>@github.com/RustyRory/vps-monitor.git

# 4. Configurer Nginx
sudo cp nginx/sites-enabled/vps /etc/nginx/sites-enabled/vps
sudo nginx -t && sudo systemctl reload nginx

# 5. Lancer vps-monitor
docker compose up -d vps-monitor

# 6. Tout le reste se déploie depuis le dashboard ✅
```

---

### Récapitulatif des fichiers à créer / modifier (plan initial)

| Fichier | Action |
|---------|--------|
| `vps-monitor-app/` → `app/` | Renommer |
| `app/api/services/git.js` | Créer |
| `app/api/services/nginx.js` | Créer |
| `app/api/services/deploy.js` | Créer |
| `app/api/server.js` | Modifier (nouvelles routes) |
| `app/public/index.html` | Modifier (nouveaux onglets) |
| `app/public/app.js` | Modifier (logique nouveaux onglets) |
| `app/public/style.css` | Modifier (styles éditeur + déploiement) |
| `.env.example` | Modifier (VPSCONFIG_PATH) |

---

### Notes d'implémentation — écarts par rapport au plan

#### `git.js` — non implémenté
Le push git depuis le dashboard a été écarté. Les apps gèrent leur propre dépôt. vps-monitor se contente de `git clone` / `git pull`.

#### `nginx.js` — implémenté différemment
Pas d'éditeur de fichier nginx complet. À la place : ajout/suppression de blocs `location` via des fonctions dédiées (`addApp`, `removeApp`). La validation `nginx -t` a été retirée des routes — le binaire nginx du VPS (Ubuntu/glibc) ne peut pas s'exécuter dans le container Alpine (musl libc). nginx refuse le reload si la config est invalide, ce qui sert de filet de sécurité.

#### `compose.js` — nouveau service (non prévu)
Gère le fichier `/var/www/docker-compose.yml` global via des includes Docker Compose. Fonctions : `addInclude`, `removeInclude`, `listIncludes`, `composeUp`, `composeRebuild`, `composeDown`, `composeIsRunning`.

#### `deploy.js` — `deleteApp` ajouté (non prévu)
En plus des fonctions prévues, `deleteApp` : arrête le container (`composeDown`), retire l'include du compose global, supprime l'entrée dans `apps.json`, supprime le dossier `/var/www/<nom>`, et nettoie le bloc nginx si applicable.

#### Build asynchrone — clone et update non-bloquants
`cloneApp` et `updateApp` ne lancent plus le build Docker dans leur propre `await`. Ils retournent le nom du service et c'est `server.js` qui déclenche `composeUp` / `composeRebuild` **après avoir envoyé la réponse HTTP**, via `.catch()` pour logger les erreurs en background.

Raison : le build de certaines apps (multi-services, npm install + Vite) dépasse le timeout nginx de 60s → 504 Gateway Timeout côté client. Le dashboard reçoit `{ ok: true, building: true }` immédiatement, et l'app passe à l'état "stopped → running" au fil du build.

#### `apps.json` — registre de métadonnées
Fichier JSON stockant les métadonnées des apps déployées (URL GitHub, chemin nginx, port). La source de vérité reste le compose global (includes) — `apps.json` enrichit uniquement l'affichage et permet la suppression propre du bloc nginx.

#### Dockerfile — binaires requis
```dockerfile
RUN apk add --no-cache git docker-cli docker-cli-compose
```
- `git` : pour `git clone` et `git pull`
- `docker-cli` : binaire Docker client
- `docker-cli-compose` : plugin `docker compose` (v2)

Le binaire nginx n'est **pas** monté depuis le host — incompatible Alpine/Ubuntu.

#### `deployment/docker-compose.yml` — variables d'environnement
```yaml
environment:
  BASE_URL: "http://<IP_VPS>"   # pour les health checks HTTP depuis le container
```
Sans `BASE_URL`, les checks se font sur `localhost:3000` (vps-monitor lui-même) au lieu de passer par nginx.

#### Démarrage de vps-monitor
Toujours utiliser le compose dédié, **pas** le compose global :
```bash
docker compose -f /var/www/vps-monitor/deployment/docker-compose.yml up -d
```

---

## Guide — Ajouter une nouvelle application via le dashboard

### Prérequis dans le repo de l'app

Créer `deployment/docker-compose.yml` à la racine du repo :

```yaml
services:
  nom-app:                          # doit correspondre au "Nom" saisi dans le dashboard
    build: ..
    restart: unless-stopped
    ports:
      - "127.0.0.1:PORT:PORT_INTERNE"
```

Le `Dockerfile` doit être à la racine du repo (référencé par `build: ..` depuis `deployment/`).

Exemple pour une app Laravel sur le port 3088 :

```yaml
services:
  cinemap-app:
    build: ..
    restart: unless-stopped
    ports:
      - "127.0.0.1:3088:80"
```

> Si l'app est un bot Discord (pas de web) : omettre la section `ports` et laisser le champ "Chemin nginx" vide dans le dashboard.

### Apps multi-services (ex : Vue + Express + MongoDB)

Pour les apps avec plusieurs containers, utiliser `depends_on` pour que le démarrage du premier service entraîne le démarrage de tous les autres. Le premier service dans le fichier est celui que vps-monitor utilise (`getFirstServiceName`).

Exemple — `B3dev-TP_VUE` (Vue frontend + Express API + MongoDB) :

```yaml
services:
  tp-vue-front:               # ← premier = celui géré par vps-monitor
    build:
      context: ../my-project
      dockerfile: deployment/Dockerfile
    ports:
      - "127.0.0.1:8080:80"
    depends_on:
      - tp-vue-api

  tp-vue-api:
    build:
      context: ../express-project
      dockerfile: deployment/Dockerfile
    ports:
      - "127.0.0.1:3003:3000"
    environment:
      MONGO_URI: mongodb://mongo:27017/madb
    depends_on:
      - mongo

  mongo:
    image: mongo:7
    volumes:
      - tp_vue_mongo:/data/db

volumes:
  tp_vue_mongo:
```

`docker compose up -d tp-vue-front` démarre automatiquement `tp-vue-api` puis `mongo` (chaîne de `depends_on`).

### Proxy interne pour les apps multi-services

vps-monitor ne crée qu'**un seul bloc nginx** par app (le port déclaré au dashboard). Pour les apps avec une API et/ou WebSocket sur un port différent, la solution est de faire proxy dans le **nginx du container frontend** plutôt que dans le nginx du VPS.

Les containers d'un même `docker-compose.yml` partagent un réseau Docker — ils se joignent par hostname (ex : `tp-vue-api:3000`).

Exemple — `my-project/deployment/nginx.conf` gérant API + Socket.io + SPA :

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # Proxy API (le préfixe /chemin-app/ est déjà strip par le VPS nginx)
    location /api/ {
        proxy_pass http://tp-vue-api:3000/api/;
    }

    # Proxy Socket.io WebSocket
    location /socket.io/ {
        proxy_pass http://tp-vue-api:3000/B3dev-TP_VUE/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Le VPS nginx proxifie `/B3dev-TP_VUE/` → port 8080 (bloc unique géré par vps-monitor). Le container nginx prend en charge le routage interne vers les autres services.

### Sur le dashboard — onglet Déploiement

Remplir le formulaire "Déployer une nouvelle app" :

| Champ | Exemple | Obligatoire |
|---|---|---|
| Nom | `cinemap-app` | ✅ (doit correspondre au nom du service dans le compose) |
| URL | `https://github.com/RustyRory/mon-app.git` | ✅ |
| Chemin nginx | `/cinemap-app/` | ❌ (vide si bot) |
| Port | `3088` | ❌ (requis si chemin nginx) |

Cliquer **Déployer** — vps-monitor va :
1. `git clone` le repo dans `/var/www/<nom>/`
2. Lire `<nom>/deployment/docker-compose.yml` pour récupérer le nom du service
3. Ajouter l'include dans `/var/www/docker-compose.yml`
4. `docker compose up -d <service>` (build inclus)
5. Ajouter le bloc `location` dans `/etc/nginx/sites-available/vps` + reload

### Vérification

- Onglet **Monitoring** → le container apparaît en vert
- Onglet **Configs** → nginx → la card `/cinemap-app/` est présente
- `http://<IP>/cinemap-app/` répond

### Mettre à jour une app

Onglet **Déploiement** → bouton **Mettre à jour** sur la card de l'app.

vps-monitor fait : `git pull` + `docker compose up -d --build <service>`.

### Supprimer une app

Onglet **Déploiement** → bouton **✕** sur la card de l'app (confirmation demandée).

vps-monitor fait :
1. `docker compose stop <service>` + `docker compose rm -f <service>`
2. Retire l'include du compose global
3. Supprime l'entrée dans `apps.json`
4. Supprime `/var/www/<nom>/`
5. Retire le bloc nginx + reload

### CD automatique (GitHub Actions)

Pour déclencher un redéploiement automatique à chaque push :

```yaml
- name: Trigger update via vps-monitor
  run: |
    curl -sf -c cookies.txt \
      -X POST "${{ secrets.VPS_MONITOR_URL }}/auth/login" \
      -H "Content-Type: application/json" \
      -d '{"username":"${{ secrets.VPS_MONITOR_USER }}","password":"${{ secrets.VPS_MONITOR_PASS }}"}' \
      | grep -q '"ok":true' || { echo "Login failed"; exit 1; }

    curl -sf -b cookies.txt \
      -X POST "${{ secrets.VPS_MONITOR_URL }}/api/deploy/update" \
      -H "Content-Type: application/json" \
      -d '{"name":"<nom-app>"}' \
      | grep -q '"ok":true' || { echo "Update failed"; exit 1; }
```

Secrets GitHub requis : `VPS_MONITOR_URL`, `VPS_MONITOR_USER`, `VPS_MONITOR_PASS`.

---

## Phase 6 — Infrastructure partagée & améliorations déploiement

### Mongo partagé via compose infra

Les apps multi-services qui utilisaient leur propre service `mongo` dans leur compose posent un problème : à la suppression de l'app, mongo est stoppé. Et plusieurs apps ne peuvent pas partager la même base si chacune embarque la sienne.

**Solution** : un compose `infra` géré par vps-monitor, toujours inclus en tête du main compose.

Au démarrage de vps-monitor, `ensureInfraInclude()` :
1. Crée `/var/www/infra/docker-compose.yml` si absent (avec le service `mongo:7`)
2. Injecte `infra/docker-compose.yml` en première entrée du main compose
3. Lance `composeUp('mongo')`

Le service `infra` est filtré de la liste des apps supprimables dans le dashboard.

Les apps qui ont besoin de mongo suppriment leur service `mongo` du compose et utilisent simplement :
```yaml
environment:
  MONGO_URI: mongodb://mongo:27017/madb
```
Les containers partagent le réseau Docker via les `include:` du main compose — ils se joignent par hostname.

### deleteApp — arrêt de tous les services

Avant : `deleteApp` ne stoppait que le premier service de l'app (celui retourné par `getFirstServiceName`). Les services secondaires (API, etc.) restaient en vie en tant qu'orphelins.

**Fix** : ajout de `getAllServiceNames(name)` dans `compose.js` — parse le bloc `services:` du compose de l'app et retourne tous les noms. `deleteApp` appelle `composeDown` sur chacun en parallèle avant de supprimer les fichiers.

### Suppression de containers depuis le dashboard

Nouveau bouton **Supprimer** sur les cards container dans l'onglet Monitoring. Visible uniquement quand le container est arrêté (Stop → Supprimer). Utilise `container.remove({ force: false })` via dockerode.

API : `POST /api/container/remove` avec `{ name }`.

### Nginx — option `stripPrefix`

**Problème** : le template `addApp()` générait toujours `proxy_pass http://127.0.0.1:${port}/;` avec un trailing slash qui supprime le préfixe de l'URL avant de transmettre au container. Correct pour les apps statiques (Vue SPA, nginx interne), mais cassant pour les apps **Next.js avec `basePath`** — Next.js reçoit `/` au lieu de `/Lucky7/` et retourne 404.

**Fix** : `addApp(path, port, stripPrefix = true)` — si `stripPrefix = false`, génère `proxy_pass http://127.0.0.1:${port}` sans trailing slash, le préfixe est conservé.

**Dashboard** : case à cocher **"Conserver le préfixe"** dans le formulaire nginx et dans le formulaire de clone. Coché = `stripPrefix: false`.

Règle : cocher pour les apps **Next.js avec `basePath`**. Ne pas cocher pour les apps Vue/statiques avec un nginx interne qui attend le path strippé.

### Lucky7 — configuration déploiement

App Next.js (frontend) + Express+Socket.io (backend) + mongo partagé.

**Architecture** :
- `lucky7-front` : port `8081`, nginx block `/Lucky7/` avec **"Conserver le préfixe" coché** (Next.js basePath = `/Lucky7`)
- `lucky7-back` : port `4001`, nginx block `/Lucky7-api/` avec strip (Socket.io avec path par défaut `/socket.io/`)

**Fichiers créés/modifiés** :
- `deployment/docker-compose.yml` : two services, mongo partagé
- `lucky7-app/frontend/Dockerfile` : `NEXT_PUBLIC_BACKEND_URL` comme build ARG
- `lucky7-app/frontend/src/lib/socket.ts` : parse `NEXT_PUBLIC_BACKEND_URL` pour extraire origin + construire le socket.io path (`url.pathname + '/socket.io'`)
- `.github/workflows/deploy-staging.yml` : SSH → vps-monitor API

**Pourquoi parser l'URL dans socket.ts** : `io('http://host/path')` interprète `/path` comme un namespace Socket.io, pas comme un path de connexion. Il faut `io(origin, { path: '/path/socket.io' })` pour que le WebSocket passe par le bon bloc nginx.

### Fix B3dev-TP_VUE

Deux bugs corrigés :

1. **Double `/api`** : `VITE_BACKEND_URL` valait `http://78.138.58.95/B3dev-TP_VUE/api` alors que le code Vue ajoutait `/api/...` → `http://.../api/api/auth/...` → 404. Corrigé : `VITE_BACKEND_URL: http://78.138.58.95/B3dev-TP_VUE`.

2. **WebSocket bloqué** : le template nginx de `addApp()` ne transmettait pas les headers `Upgrade` et `Connection`. Corrigé : ajout systématique de ces deux headers dans le bloc généré.

---

## Phase 7 — Évolutions futures

- Alertes email / Discord quand un service tombe
- Historique d'uptime (stockage fichier ou SQLite)
- Graphiques CPU / RAM via `dockerode.stats`
- Support multi-serveurs
- `git config --global --add safe.directory '*'` dans le Dockerfile vps-monitor (les repos clonés par le container root ne sont pas accessibles en `git` par l'utilisateur host)

---