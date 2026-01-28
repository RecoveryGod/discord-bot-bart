# Déploiement du bot sur un VPS (Docker + Git)

Objectif : pousser le code via Git, puis sur le VPS faire `git pull` et `docker compose up` — sans copier-coller manuel.

---

## 1. En local : pousser le code sur un dépôt distant

Si ce n’est pas déjà fait :

```bash
git init
git add .
git commit -m "Bot Discord Amazon Gift Cards + Docker"
git remote add origin https://github.com/TON_USER/discord-bot-bart.git   # ou GitLab, etc.
git push -u origin main
```

Le `.gitignore` exclut `.env` et `node_modules`, donc ils ne sont jamais poussés.

---

## 2. Sur le VPS : prérequis

- Docker et Docker Compose installés :

  ```bash
  # Exemple Ubuntu/Debian
  sudo apt update && sudo apt install -y docker.io docker-compose-plugin
  sudo usermod -aG docker $USER
  # Puis se déconnecter/reconnecter (ou newgrp docker)
  ```

- Accès SSH au VPS et (optionnel) clé SSH pour cloner sans mot de passe.

---

## 3. Sur le VPS : première installation

Une seule fois :

```bash
# Cloner le dépôt (remplace par ton URL)
git clone https://github.com/TON_USER/discord-bot-bart.git
cd discord-bot-bart

# Créer le .env (jamais dans Git)
cp .env.example .env
nano .env   # ou vim — remplir BOT_TOKEN, PAYMENT_CHANNEL_ID, AMAZON_ROLE_ID, TICKET_CHANNEL_ID

# Lancer le bot
docker compose up -d --build
```

Vérifier que le bot tourne :

```bash
docker compose ps
docker compose logs -f bot
```

---

## 4. Mises à jour (sans copier-coller)

À chaque fois que tu as poussé du nouveau code :

Sur le VPS :

```bash
cd /chemin/vers/discord-bot-bart   # ou ~/discord-bot-bart selon où tu as cloné
git pull
docker compose up -d --build
```

- `git pull` récupère le code depuis GitHub/GitLab.
- `--build` rebuild l’image pour prendre les changements.
- `-d` relance le conteneur en arrière-plan.

Tu ne touches pas au `.env` sur le VPS sauf pour changer les variables.

---

## 5. (Optionnel) Script de déploiement sur le VPS

Pour faire tout d’un coup sur le VPS :

```bash
# Sur le VPS, dans le dossier du projet
cat << 'EOF' > deploy.sh
#!/bin/bash
set -e
cd "$(dirname "$0")"
git pull
docker compose up -d --build
echo "Deploy done."
EOF
chmod +x deploy.sh
```

Ensuite, pour déployer :

```bash
./deploy.sh
```

---

## 6. (Optionnel) Déploiement automatique au push (CI)

Avec GitHub Actions ou GitLab CI tu peux, au chaque push sur `main` :

1. Te connecter en SSH au VPS.
2. Lancer `cd discord-bot-bart && git pull && docker compose up -d --build`.

Il faut alors une clé SSH dédiée (deploy key) et un secret du type `VPS_HOST`, `VPS_USER`, `SSH_PRIVATE_KEY` dans les paramètres du repo. Si tu veux, on peut détailler un exemple de workflow (GitHub Actions ou GitLab CI) dans un prochain pas à pas.

---

## Résumé du flux

1. **En local** : tu développes, tu commits, tu fais `git push`.
2. **Sur le VPS** : tu fais `git pull` puis `docker compose up -d --build` (ou `./deploy.sh`).
3. Aucun copier-coller de code : tout passe par Git.

Le fichier `.env` reste uniquement sur le VPS (et en local sur ta machine), jamais dans le dépôt.
