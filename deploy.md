# NSI LiveMeet Server — Production Deploy Guide

Step-by-step guide to deploy the API server on a VPS with **PostgreSQL**, **PM2**, **Nginx + SSL**, and **GitHub Actions CI/CD**.

**Stack:** Node.js 20 · Express · Prisma · Socket.IO · PM2 · Nginx · Certbot

**Default paths used in this guide:**
- App directory: `/var/www/nsi-livemeet-server`
- API domain: `api.yourdomain.com` (replace with yours)
- App port (internal): `8000`

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [VPS initial setup](#2-vps-initial-setup)
3. [PostgreSQL setup](#3-postgresql-setup)
4. [Clone the repository](#4-clone-the-repository)
5. [Environment variables](#5-environment-variables)
6. [First manual deploy (PM2)](#6-first-manual-deploy-pm2)
7. [Nginx reverse proxy](#7-nginx-reverse-proxy)
8. [SSL with Let's Encrypt](#8-ssl-with-lets-encrypt)
9. [Firewall](#9-firewall)
10. [Zoom webhook URL](#10-zoom-webhook-url)
11. [GitHub repository setup](#11-github-repository-setup)
12. [GitHub Actions CI/CD](#12-github-actions-ci-cd)
13. [Verify deployment](#13-verify-deployment)
14. [Ongoing operations](#14-ongoing-operations)
15. [Production checklist](#15-production-checklist)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Prerequisites

On your VPS you should already have (or will install):

- Ubuntu 22.04 / 24.04 (or similar Debian-based Linux)
- PostgreSQL installed and running
- PM2 installed globally (`npm install -g pm2`)
- A domain pointing to your VPS IP (for SSL), e.g. `api.yourdomain.com`
- SSH access to the server

---

## 2. VPS initial setup

SSH into your VPS as root or a sudo user:

```bash
ssh your-user@YOUR_VPS_IP
```

### 2.1 Update system packages

```bash
sudo apt update && sudo apt upgrade -y
```

### 2.2 Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git build-essential
node -v   # should show v20.x
npm -v
```

### 2.3 Install PM2 globally (if not already installed)

```bash
sudo npm install -g pm2
pm2 -v
```

### 2.4 Create deploy user (optional but recommended)

```bash
sudo adduser deploy
sudo usermod -aG sudo deploy
```

Log in as `deploy` for the rest of the setup, or use your existing user.

### 2.5 Create app directory

```bash
sudo mkdir -p /var/www/nsi-livemeet-server
sudo chown -R $USER:$USER /var/www/nsi-livemeet-server
```

---

## 3. PostgreSQL setup

### 3.1 Connect to PostgreSQL

```bash
sudo -u postgres psql
```

### 3.2 Create database and user

Replace `YOUR_STRONG_PASSWORD` with a secure password:

```sql
CREATE USER nsi_livemeet WITH PASSWORD 'YOUR_STRONG_PASSWORD';
CREATE DATABASE nsi_livemeet OWNER nsi_livemeet;
GRANT ALL PRIVILEGES ON DATABASE nsi_livemeet TO nsi_livemeet;
\q
```

### 3.3 Test connection

```bash
psql "postgresql://nsi_livemeet:YOUR_STRONG_PASSWORD@localhost:5432/nsi_livemeet" -c "SELECT 1;"
```

### 3.4 Security note

Keep PostgreSQL listening on `localhost` only (default on Ubuntu). Do **not** expose port `5432` to the public internet.

---

## 4. Clone the repository

```bash
cd /var/www/nsi-livemeet-server
git clone https://github.com/YOUR_ORG/YOUR_SERVER_REPO.git .
```

If the repo is private, use SSH clone or a deploy key:

```bash
git clone git@github.com:YOUR_ORG/YOUR_SERVER_REPO.git .
```

Confirm you are on the `master` branch:

```bash
git branch
```

---

## 5. Environment variables

### 5.1 Create `.env` from template

```bash
cd /var/www/nsi-livemeet-server
cp .env.example .env
chmod 600 .env
nano .env
```

### 5.2 Fill in all values

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | `production` |
| `PORT` | `8000` (internal; Nginx proxies to this) |
| `DATABASE_URL` | `postgresql://nsi_livemeet:PASSWORD@localhost:5432/nsi_livemeet` |
| `JWT_SECRET` | Long random string (e.g. `openssl rand -hex 32`) |
| `PASSWORD_SALT` | Another long random string |
| `CORS_ORIGIN` | Your frontend URL(s), comma-separated |
| `ZOOM_ACCOUNT_ID` | From Zoom Marketplace app |
| `ZOOM_CLIENT_ID` | From Zoom Marketplace app |
| `ZOOM_CLIENT_SECRET` | From Zoom Marketplace app |
| `ZOOM_WEBHOOK_SECRET` | From Zoom webhook settings |

Generate secrets:

```bash
openssl rand -hex 32
```

**Never commit `.env` to git.**

---

## 6. First manual deploy (PM2)

Run these commands on the VPS inside `/var/www/nsi-livemeet-server`:

### 6.1 Install dependencies and build

```bash
npm ci
npm run build
```

### 6.2 Run database migrations

```bash
npm run migrate:deploy
```

### 6.3 Create admin user (one-time)

```bash
npm run seed-admin
```

Default credentials (change immediately after first login):
- Email: `admin@mail.com`
- Password: `admin123`

### 6.4 Update PM2 config path (if needed)

Open `ecosystem.config.cjs` and confirm `cwd` matches your deploy path:

```js
cwd: "/var/www/nsi-livemeet-server",
```

### 6.5 Start with PM2

```bash
mkdir -p logs
pm2 start ecosystem.config.cjs --env production
pm2 status
```

### 6.6 Enable PM2 on system boot

```bash
pm2 startup
# Run the command PM2 prints (sudo env PATH=...)
pm2 save
```

### 6.7 Quick local test (on VPS)

```bash
curl http://127.0.0.1:8000/
# Expected: NSI Live Meet Server ✓
```

---

## 7. Nginx reverse proxy

### 7.1 Install Nginx

```bash
sudo apt install -y nginx
```

### 7.2 Create site config

```bash
sudo nano /etc/nginx/sites-available/nsi-livemeet-api
```

Paste (replace `api.yourdomain.com`):

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

> **Socket.IO:** The `Upgrade` and `Connection` headers are required for WebSocket support through Nginx.

### 7.3 Enable site

```bash
sudo ln -s /etc/nginx/sites-available/nsi-livemeet-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 8. SSL with Let's Encrypt

### 8.1 Install Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### 8.2 Obtain certificate

```bash
sudo certbot --nginx -d api.yourdomain.com
```

Follow prompts. Certbot will update your Nginx config for HTTPS.

### 8.3 Auto-renewal test

```bash
sudo certbot renew --dry-run
```

---

## 9. Firewall

Allow SSH, HTTP, and HTTPS. Block direct access to app and database ports:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Do **not** open ports `8000` or `5432` publicly.

---

## 10. Zoom webhook URL

In the [Zoom Marketplace](https://marketplace.zoom.us/) app settings, set the webhook endpoint to:

```
https://api.yourdomain.com/api/zoom/webhook
```

Use the same `ZOOM_WEBHOOK_SECRET` in your `.env` file.

Test webhook delivery from the Zoom dashboard after deploy.

---

## 11. GitHub repository setup

### 11.1 Create GitHub repository

1. Go to GitHub → **New repository**
2. Name it (e.g. `nsi-livemeet-server`)
3. Do **not** initialize with README if pushing existing code

### 11.2 Push local server code

On your development machine, inside the `server/` folder:

```bash
cd server
git remote add origin https://github.com/YOUR_ORG/nsi-livemeet-server.git
git push -u origin master
```

### 11.3 Generate deploy SSH key (on your local machine)

```bash
ssh-keygen -t ed25519 -C "github-deploy-nsi-livemeet" -f ~/.ssh/nsi_livemeet_deploy -N ""
```

### 11.4 Add public key to VPS

```bash
cat ~/.ssh/nsi_livemeet_deploy.pub
```

On the VPS, add it to the deploy user's `authorized_keys`:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys
# Paste the public key, save
chmod 600 ~/.ssh/authorized_keys
```

### 11.5 Test SSH from local machine

```bash
ssh -i ~/.ssh/nsi_livemeet_deploy deploy@YOUR_VPS_IP
```

---

## 12. GitHub Actions CI/CD

The workflow file is at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

It runs on every push to `master` (and can be triggered manually).

### 12.1 What the pipeline does

1. Checks out code on GitHub Actions
2. Runs `npm ci`, `prisma generate`, `npm run build` (fails fast if broken)
3. SSHs into VPS and runs:
   - `git pull origin master`
   - `npm ci`
   - `npm run build`
   - `npm run migrate:deploy`
   - `pm2 startOrReload ecosystem.config.cjs --env production`
   - `pm2 save`

### 12.2 Add GitHub Secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|-------------|-------|
| `VPS_HOST` | VPS IP or domain, e.g. `123.45.67.89` |
| `VPS_USER` | SSH user, e.g. `deploy` |
| `VPS_SSH_KEY` | Full private key contents of `~/.ssh/nsi_livemeet_deploy` |
| `VPS_DEPLOY_PATH` | `/var/www/nsi-livemeet-server` |

### 12.3 Trigger first automated deploy

```bash
git add .
git commit -m "Add production deploy workflow"
git push origin master
```

Watch progress: GitHub → **Actions** tab.

### 12.4 Manual deploy trigger

GitHub → **Actions** → **Deploy Server to VPS** → **Run workflow**.

---

## 13. Verify deployment

### 13.1 Health check

```bash
curl https://api.yourdomain.com/
```

Expected response:

```
NSI Live Meet Server ✓
```

### 13.2 Login test

```bash
curl -X POST https://api.yourdomain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@mail.com","password":"admin123"}'
```

You should receive a JSON response with a `token`.

### 13.3 PM2 status

On VPS:

```bash
pm2 status
pm2 logs nsi-livemeet-api --lines 50
```

### 13.4 Database migrations

```bash
cd /var/www/nsi-livemeet-server
npx prisma migrate status
```

---

## 14. Ongoing operations

### Deploy new code

Push to `master` — CI/CD handles the rest.

### View logs

```bash
pm2 logs nsi-livemeet-api
pm2 logs nsi-livemeet-api --err
tail -f /var/www/nsi-livemeet-server/logs/pm2-out.log
```

### Restart app

```bash
pm2 restart nsi-livemeet-api
```

### Update environment variables

```bash
nano /var/www/nsi-livemeet-server/.env
pm2 restart nsi-livemeet-api
```

### Run migrations manually

```bash
cd /var/www/nsi-livemeet-server
npm run migrate:deploy
pm2 restart nsi-livemeet-api
```

### Roll back to a previous commit

```bash
cd /var/www/nsi-livemeet-server
git log --oneline -5
git checkout <commit-sha>
npm ci
npm run build
npm run migrate:deploy
pm2 restart nsi-livemeet-api
```

To return to latest:

```bash
git checkout master
git pull origin master
npm ci && npm run build && npm run migrate:deploy
pm2 restart nsi-livemeet-api
```

---

## 15. Production checklist

- [ ] Strong `JWT_SECRET` and `PASSWORD_SALT` set in `.env`
- [ ] Default admin password changed after first login
- [ ] `CORS_ORIGIN` set to your real frontend URL
- [ ] `.env` file permissions are `600`
- [ ] PostgreSQL not exposed publicly
- [ ] Port `8000` not exposed publicly (Nginx only)
- [ ] SSL certificate active and auto-renewing
- [ ] Zoom webhook URL points to HTTPS endpoint
- [ ] PM2 startup configured (`pm2 startup` + `pm2 save`)
- [ ] GitHub Actions secrets configured
- [ ] Firewall enabled (`ufw`)

---

## 16. Troubleshooting

### App won't start

```bash
pm2 logs nsi-livemeet-api --err
cat /var/www/nsi-livemeet-server/.env   # verify DATABASE_URL and secrets
```

### Database connection failed

```bash
psql "$DATABASE_URL" -c "SELECT 1;"
sudo systemctl status postgresql
```

### Nginx 502 Bad Gateway

```bash
pm2 status
curl http://127.0.0.1:8000/
sudo nginx -t
sudo tail -f /var/log/nginx/error.log
```

### Socket.IO not connecting through Nginx

- Confirm `Upgrade` and `Connection` headers in Nginx config (see [section 7](#7-nginx-reverse-proxy))
- Confirm `CORS_ORIGIN` includes your frontend URL
- Check browser devtools → Network → WS tab

### GitHub Actions deploy fails

- Verify all four secrets are set correctly
- Test SSH manually: `ssh -i ~/.ssh/nsi_livemeet_deploy deploy@VPS_HOST`
- Ensure VPS repo has `origin` pointing to GitHub and `master` branch exists
- Check deploy user owns `/var/www/nsi-livemeet-server`

### Prisma migrate errors

```bash
cd /var/www/nsi-livemeet-server
npx prisma migrate status
npm run migrate:deploy
```

---

## File reference

| File | Purpose |
|------|---------|
| [`ecosystem.config.cjs`](ecosystem.config.cjs) | PM2 process definition |
| [`.env.example`](.env.example) | Environment variable template |
| [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) | CI/CD pipeline |
| [`package.json`](package.json) | Build and migration scripts |

---

## Next steps

After the server is live, deploy the **Next.js client** separately and set:

```
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
```

on the frontend, with `CORS_ORIGIN` on the server matching the frontend URL.
