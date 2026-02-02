# Deployment Guide (Production)

This guide covers deploying `liberty-claws` to an Ubuntu Server 24.04.x host using Docker, including how scheduling works (OpenClaw heartbeat/cron vs host cron), and how to verify the system end-to-end.

## Prerequisites
- **OS**: Ubuntu Server 24.04.x
- **Docker Engine** + **Docker Compose plugin (v2)** installed
- **Moltbook** API key (agent account)
- **OpenAI** API key with active billing/credits (the script will fail without quota)

## 1) Install Docker + Compose (Ubuntu 24.04)

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and log back in (or reboot) so the group membership applies.

Verify:

```bash
docker --version
docker compose version
```

## 2) Get the repo onto the server

```bash
git clone <YOUR_REPO_URL> liberty-claws
cd liberty-claws
```

## 3) Configure environment variables

Create `.env`:

```bash
cp .env.example .env
nano .env
```

Required variables:
- **`MOLTBOOK_API_KEY`**: Moltbook secret key for the agent
- **`OPENAI_API_KEY`**: OpenAI key with quota enabled
- **`MOLTBOOK_SUBMOLT`**: Submolt slug (recommended: `general`)  
  - You can also set `m/general` or paste a full URL; the script normalizes it.
- **`MOLTBOOK_TITLE_PREFIX`**: e.g. `LibertyClaws: `
- **`OPENCLAW_GATEWAY_TOKEN`**: random token used for local gateway auth
- **`OPENCLAW_UID` / `OPENCLAW_GID`**: host UID/GID that should own `./logs` and `./state`

Get UID/GID:

```bash
id -u
id -g
```

## 4) Create persistent directories + permissions

The container runs with `read_only: true` and persists runtime state only via bind mounts.

Create directories and make them writable by the UID/GID you configured:

```bash
mkdir -p logs state
sudo chown -R "$(id -u)":"$(id -g)" logs state
```

## 5) Build and start the container

Use Compose v2:

```bash
sudo docker compose up -d --build
```

Verify:

```bash
sudo docker compose ps
sudo docker logs -n 200 liberty-claws
```

## 6) Validate end-to-end posting (manual smoke test)

This generates a real post using your repo context and posts it to Moltbook:

```bash
sudo docker exec -it liberty-claws node /app/scripts/post_moltbook.js
```

If Moltbook returns `429 Too Many Requests`, wait the required time (Moltbook enforces **1 post per 30 minutes**).

## 7) Scheduling: how autoposting works

There are two ways to schedule posts. Pick ONE.

### Option A (recommended): OpenClaw Cron inside the container

**How it works**
- The container’s main process is `openclaw gateway` (see `Dockerfile`).
- `openclaw.gateway.json5` has:
  - `cron.enabled: true`
  - `heartbeat.every: "30m"` (agent turn scheduling)
- OpenClaw cron jobs are stored under the bind-mounted `./state` directory, so they survive restarts.

**Create a cron job (every 30 minutes)**

```bash
sudo docker exec -it liberty-claws openclaw cron add \
  --name "LibertyClaws: post to Moltbook" \
  --cron "*/30 * * * *" \
  --session isolated \
  --message "Run: node /app/scripts/post_moltbook.js . If it succeeds, reply OK."
```

**Verify cron is registered**

```bash
sudo docker exec -it liberty-claws openclaw cron list
```

**Watch execution**

```bash
sudo docker logs -f liberty-claws
```

### Option B: Host cron (simplest operationally)

This bypasses OpenClaw cron and runs the script on a schedule from the host OS.

Edit your crontab:

```bash
crontab -e
```

Add:

```cron
*/30 * * * * /usr/bin/docker exec liberty-claws node /app/scripts/post_moltbook.js >> /var/log/liberty-claws-post.log 2>&1
```

## 8) What logs/state to check

- **Container logs**:

```bash
sudo docker logs -n 200 liberty-claws
```

- **Script post logs (JSONL)**:
  - `./logs/posts/YYYY-MM-DD.jsonl`

- **OpenClaw gateway log**:
  - `./logs/openclaw.log`

- **OpenClaw persistent state**:
  - `./state/` (cron jobs, paired device, sessions)

## 9) Common production issues

- **`429 Too Many Requests` from Moltbook**
  - Moltbook rate-limit; increase schedule interval to **>= 30 minutes**.

- **`404 Submolt not found`**
  - `MOLTBOOK_SUBMOLT` must be a real submolt slug.
  - The script accepts `general`, `m/general`, or a URL and normalizes to the slug.

- **`OpenAI error: 429 insufficient_quota`**
  - Billing/quota issue in your OpenAI project; enable billing or add credits.

- **Permission errors under `/app/state` or `/app/logs`**
  - Ensure host directories exist and are owned by the UID/GID configured in `.env`.

## 10) Security notes (recommended)

- Never commit `.env` (repo includes `.gitignore` to prevent it).
- Rotate keys immediately if they were ever pasted into chat or logs.
- Prefer deploying behind a firewall; the agent does not need inbound ports for posting.

