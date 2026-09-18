# Deploying to a Linux host

Written for a Beelink (`kettlecorn`) running Ubuntu with Docker already
installed, a Synology NAS mounted for backups, and the database on local disk.
Adjust hostnames and paths to taste.

> **This has never been run end to end.** The image has been reviewed but not
> built. Treat the first deployment as the test, and do not skip step 6.

Rough timings: a few minutes of setup, a ~4 minute database transfer over
gigabit, and a first build of a minute or two.

---

## Quick path

The whole deployment. Everything below this section is detail for when a step
misbehaves — skip it until then.

```bash
# --- on the Beelink -------------------------------------------------------
docker compose version                      # must be v2
df -h /                                     # need ~30 GB

# deploy key (read-only) -> GitHub: repo > Settings > Deploy keys
ssh-keygen -t ed25519 -C "kettlecorn deploy" -f ~/.ssh/mtg_deploy -N ""
chmod 600 ~/.ssh/mtg_deploy
cat ~/.ssh/mtg_deploy.pub

cat >> ~/.ssh/config <<'CFG'
Host github-mtg
  HostName github.com
  User git
  IdentityFile ~/.ssh/mtg_deploy
  IdentitiesOnly yes
CFG
chmod 600 ~/.ssh/config
ssh -T git@github-mtg                       # expect: Hi nmanske/mtg-...!

sudo mkdir -p /srv/mtg && sudo chown "$USER" /srv/mtg
cd /srv/mtg
git clone git@github-mtg:nmanske/mtg-collection-value-tracker.git
sudo mkdir -p /srv/mtg/data && sudo chown -R 1001:1001 /srv/mtg/data

# --- from WSL on the Windows machine, with nothing running there ----------
rsync -avP /mnt/c/_PERSONAL/mtg-collection-value-tracker/data/mtg.db   nathan@kettlecorn:/srv/mtg/data/mtg.db

# --- back on the Beelink --------------------------------------------------
sudo chown 1001:1001 /srv/mtg/data/mtg.db
cd /srv/mtg/mtg-collection-value-tracker
cp .env.example .env
sed -i 's|^PORT=.*|PORT=3010|' .env
echo 'DATA_DIR=/srv/mtg/data' >> .env

docker compose up -d --build
docker compose logs -f                      # wait for "scheduled daily ingest"

# --- verify ---------------------------------------------------------------
docker compose exec app node_modules/.bin/tsx scripts/ingest-today.mts --dry-run
docker compose exec app node -e   "const d=require('better-sqlite3')('/app/data/mtg.db',{readonly:true});   console.log(d.prepare('select count(*) n from holdings').get())"
```

Then open <http://kettlecorn:3010>. Expect 3,868 holdings from that last check
— if it says 0, the database did not land where `DATA_DIR` points.

Two things worth doing before you walk away: set `CRON_SCHEDULE="* * * * *"`,
restart, watch one run reach `prices: done`, then put it back to `30 4 * * *`.
And set up the backup cron in section 8.

---

## 1. Check the host

```bash
docker --version            # 20.10+ is fine
docker compose version      # must be v2 — "docker-compose" v1 is not supported
id                          # you should be in the `docker` group
df -h /                     # need ~30 GB free; the database is ~25 GB
free -h
```

If `docker compose version` fails but `docker-compose --version` works, you are
on Compose v1, which does not understand the long-form `volumes` syntax used
here. Install the v2 plugin (`sudo apt install docker-compose-plugin`).

---

## 2. Create a deploy key and clone

The repository is private, so the host needs its own read-only key. Generate it
**on the Beelink** — a key should live on the machine that uses it, and a deploy
key can be revoked without touching your personal GitHub access.

```bash
ssh-keygen -t ed25519 -C "kettlecorn deploy key" -f ~/.ssh/mtg_deploy -N ""
chmod 600 ~/.ssh/mtg_deploy
cat ~/.ssh/mtg_deploy.pub
```

Copy that public key, then on GitHub:

**Repository → Settings → Deploy keys → Add deploy key.** Title it
`kettlecorn`, paste the key, and **leave "Allow write access" unchecked** — the
host only ever pulls.

Teach SSH which key to use for this repository by adding a host alias to
`~/.ssh/config`:

```
Host github-mtg
  HostName github.com
  User git
  IdentityFile ~/.ssh/mtg_deploy
  IdentitiesOnly yes
```

`IdentitiesOnly yes` matters. Without it, SSH offers every key in the agent, and
GitHub authenticates you as whichever it accepts first — which can silently be a
different account.

```bash
chmod 600 ~/.ssh/config
ssh -T git@github-mtg
```

Expect:

```
Hi nmanske/mtg-collection-value-tracker! You've successfully authenticated,
but GitHub does not provide shell access.
```

That names the repository rather than a user, which is how you know the deploy
key is the one being used. Then clone through the alias:

```bash
sudo mkdir -p /srv/mtg && sudo chown "$USER" /srv/mtg
cd /srv/mtg
git clone git@github-mtg:nmanske/mtg-collection-value-tracker.git
cd mtg-collection-value-tracker
git remote -v        # should show github-mtg, not github.com
```

Because the alias is baked into the remote URL, later `git pull`s need no extra
flags.

---

## 3. Prepare the data directory

The database lives on local disk, not on the NAS. SQLite needs POSIX advisory
locking and uses a shared-memory file for its write-ahead log, neither of which
works over NFS or SMB.

```bash
sudo mkdir -p /srv/mtg/data
sudo chown -R 1001:1001 /srv/mtg/data
```

`1001` is the unprivileged `nextjs` user inside the image. The host does not
need a user with that id; the number is what matters. Get this wrong and the
container fails at startup with `SQLITE_CANTOPEN`.

---

## 4. Copy the database across

Check first that nothing on the source machine is holding the database — stop
any dev server and any running ingest. Then confirm the write-ahead log is
empty, which means the single `mtg.db` file is self-contained:

```powershell
# on the Windows machine
Get-ChildItem data\mtg.db*
```

`mtg.db-wal` at 0 KB means you can copy the file directly. If it is not empty,
either close everything cleanly (SQLite checkpoints on the last connection
closing) or take a consistent snapshot with `VACUUM INTO` as in step 8.

```bash
# from WSL, so the transfer can resume if it drops
rsync -avP /mnt/c/_PERSONAL/mtg-collection-value-tracker/data/mtg.db \
  nathan@kettlecorn:/srv/mtg/data/mtg.db
```

Git Bash has `scp` but not `rsync`, and you want resume on 25 GB.

```bash
# back on the Beelink
sudo chown 1001:1001 /srv/mtg/data/mtg.db
ls -lh /srv/mtg/data/
```

Skipping this step is fine too — the container will build its own database from
scratch — but it will spend hours re-ingesting what you already have, and it can
only reach back about 90 days for prices.

---

## 5. Configure and start

Keep this as its own compose project rather than merging it into the stack that
runs Plex. `docker compose down` on the media stack then cannot take the tracker
with it, and updates touch one service.

```bash
cd /srv/mtg/mtg-collection-value-tracker
cp .env.example .env
```

Edit `.env`:

```
DATA_DIR=/srv/mtg/data
PORT=3010
```

`DATA_DIR` keeps the host path out of the tracked compose file, so `git pull`
never conflicts. Port 3010 rather than 3000 because 3000 is heavily contested —
Homepage, Grafana, Uptime Kuma all want it.

If you also want a memory cap — sensible on a box that transcodes — create
`docker-compose.override.yml`, which is untracked and merged automatically:

```yaml
services:
  app:
    mem_limit: 3g
```

The daily ingest spikes to 1–2 GB. Because it runs as a child process, hitting
the cap kills the ingest and leaves the web app serving, which is the failure
you want.

```bash
docker compose up -d --build
docker compose logs -f
```

The first build takes a minute or two. Expect to see:

```
[cron] database ready at /app/data/mtg.db
[cron] scheduled daily ingest at "30 4 * * *" (America/Chicago)
```

Then open <http://kettlecorn:3010>.

---

## 6. Verify

The image carries more than the standalone bundle. `better-sqlite3` is traced
into it, but `stream-json` and `tsx` are not, so a pruned production
`node_modules` is layered underneath for the ingest. These checks confirm that
survived, and that nothing else is quietly broken.

```bash
# 1. The ingest runtime and its ESM-only parser are present.
docker compose exec app ls node_modules/.bin/tsx node_modules/stream-json

# 2. The ingest runs and its imports resolve. --dry-run writes nothing.
docker compose exec app node_modules/.bin/tsx scripts/ingest-today.mts --dry-run

# 3. The schedule was registered at boot.
docker compose logs app | grep "scheduled daily ingest"

# 4. HTTPS works from inside the container. A missing trust store would fail
#    every ingest, quietly, once a day.
docker compose exec app node -e \
  "fetch('https://mtgjson.com/api/v5/Meta.json').then(r=>console.log(r.status))"

# 5. The database the container sees is yours, not a fresh empty one.
docker compose exec app node -e \
  "const d=require('better-sqlite3')('/app/data/mtg.db',{readonly:true});\
   console.log(d.prepare('select count(*) n from holdings').get())"
```

Then prove the schedule actually fires, rather than waiting a day to find out it
does not. Set `CRON_SCHEDULE="* * * * *"` in `.env`, restart, and watch one
complete run before putting it back to `30 4 * * *`:

```bash
docker compose up -d
docker compose logs -f app | grep --line-buffered "\[cron\]"
```

A healthy run is a couple of minutes: ~150,000 snapshots and ~230,000 vendor
rows, then a portfolio cache rebuild, ending in `prices: done`. A failure prints
the tail of the child's output and is recorded for the dashboard banner.

---

## 7. Updating

```bash
cd /srv/mtg/mtg-collection-value-tracker
git pull
docker compose up -d --build
docker builder prune -f      # optional, reclaims build cache
```

Migrations run automatically at startup, so a newer schema upgrades in place.

---

## 8. Backups

This is the right use for the NAS: a backup is a sequential file copy, with none
of the locking a live database needs.

`VACUUM INTO` earns its time here — it takes a consistent snapshot while the
container keeps running, which a plain `cp` cannot. Write it to local disk
first, then move it, so SQLite is not writing across NFS:

```bash
#!/usr/bin/env bash
# /srv/mtg/backup.sh — run as root. The snapshot is written by uid 1001 into a
# directory owned by uid 1001, which your own user cannot move a file out of.
set -euo pipefail
DEST=/mnt/nas_shared/mtg
mkdir -p "$DEST"

cd /srv/mtg/mtg-collection-value-tracker
docker compose exec -T app node -e \
  "require('better-sqlite3')('/app/data/mtg.db').exec(\"vacuum into '/app/data/backup.db'\")"

mv /srv/mtg/data/backup.db "$DEST/mtg-$(date +%F).db"
# keep the last 7
ls -1t "$DEST"/mtg-*.db | tail -n +8 | xargs -r rm --
```

`-T` disables TTY allocation, which cron does not have. Run it from root's
crontab so the `mv` out of the 1001-owned directory succeeds:

```bash
sudo chmod +x /srv/mtg/backup.sh
sudo crontab -e
# 30 3 * * *  /srv/mtg/backup.sh >> /srv/mtg/backup.log 2>&1
```

Run it by hand once before trusting the schedule: `sudo /srv/mtg/backup.sh`.

Expect roughly 15 minutes and ~25 GB per snapshot, so watch the retention count
against free space on the share.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `SQLITE_CANTOPEN` at startup | `/srv/mtg/data` not writable by uid 1001 | `sudo chown -R 1001:1001 /srv/mtg/data` |
| Collection is empty after start | Container built a fresh database; the copy did not land where `DATA_DIR` points | Check `DATA_DIR` in `.env` and `ls -lh /srv/mtg/data` |
| `prices: FAILED` with certificate errors | No trust store in the image | Check 4 above; the runner installs `ca-certificates` |
| `prices:` never appears in the logs | `INGEST_COMMAND` empty, or the scheduler disabled | `CRON_ENABLED=true`, and leave `INGEST_COMMAND` unset |
| Dashboard banner says prices are behind | A run failed or did not happen | `docker compose logs app \| grep cron`; the last run is recorded in `sync_meta` |
| Pages take 20–30 s | Portfolio cache invalidated by an ingest | Expected once after a backfill; `docker compose exec app node_modules/.bin/tsx scripts/rebuild-cache.ts` |
| `git pull` conflicts on `docker-compose.yml` | Host paths edited into a tracked file | Use `.env` (`DATA_DIR`, `PORT`) or `docker-compose.override.yml` |
| Build killed on a small host | Out of memory | The build peaks ~0.4 GB on webpack; if it is Turbopack, see `TODO.md` — `npm run build` must pass `--webpack` |
