# Deploying to a Linux host

Written for a Beelink (`kettlecorn`) running Ubuntu with Docker already
installed, a Synology NAS mounted for backups, and the database on local disk.
Adjust hostnames and paths to taste.

> **Run end to end on 2026-09-18.** The first build surfaced exactly one bug —
> `next build` imports every route to collect page data, which opened SQLite
> before the `data` directory existed — fixed since. Everything below has been
> executed on a real host rather than reasoned about.

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

One thing worth doing before you walk away: set `CRON_SCHEDULE="* * * * *"`,
restart, watch one run reach `prices: done`, then put it back to `0 10 * * *`.
Backups are optional here — section 8 says why.

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

# This instance holds your own collection, so the web importer is wanted.
# Default-closed, because on a public instance it is a stranger's button for
# overwriting somebody else's cards.
ENABLE_OWNER_IMPORT=true

# Hides every value until this is typed. Drop the line and values simply show.
PRIVACY_PASSWORD=pass

# The session cookie is dropped over plain HTTP without this, and a LAN
# instance reached at http://kettlecorn:3010 has no certificate.
ALLOW_INSECURE_COOKIE=true
```

A **public** deployment sets none of those three: no web importer, no password
in front of a visitor's own numbers, and a `secure` cookie behind TLS.

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
[cron] scheduled daily ingest at "0 10 * * *" (UTC)
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
complete run before putting it back to `0 10 * * *`:

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

**Upgrading past 0010 (uploaded collections)** needs two one-off steps:

```bash
# 1. The migration drops the portfolio cache, because both cache tables gained
#    a column in their primary key. Rebuild it, or the first page load pays a
#    20-35s recompute. The next daily ingest would do it anyway.
docker compose exec app node_modules/.bin/tsx scripts/rebuild-cache.ts

# 2. Set ENABLE_OWNER_IMPORT=true in .env, or /import returns 404 -- it is
#    default-closed now. Then: docker compose up -d
```

Nothing else changes for a self-hosted instance. The host's collection is the
rows whose scope is `''`, which is what every existing row became, and the
dashboard is still the front page as long as that collection is not empty.

---

## 8. Backups — optional, and probably not worth it

Skipped deliberately on this deployment. The reasoning, so a future reader can
weigh it again rather than assume it was an oversight:

**Almost everything here is rebuildable.** `price_snapshots` and
`vendor_prices` — 564 million rows between them — come from the MTGJSON archive
on the NAS, and card metadata comes from Scryfall. The portfolio caches are
derived. A total loss costs days of re-ingesting, not data.

**One thing is not rebuildable.** `holdings` carries `date_added`, taken from
Moxfield's `Last Modified` column, which moves forward every time a card is
edited there. Re-importing later yields different dates, so the acquisition
history as it stands exists only in this database. The same goes for
`date_added_approx`, manual price overrides, notes, and any holding added by
hand rather than imported. For a single user who can accept an approximate
history, that is a fair trade.

If you change your mind, the cheap version covers exactly that gap. The
collection export is keyed by `scryfall_id` rather than the local
`printing_key`, so it re-imports into a database rebuilt from scratch:

```bash
curl -fsS http://localhost:3010/api/export/collection   -o /mnt/nas_headless_backup/other/mtg/collection-$(date +%F).csv
```

A few hundred KB, no root, no locking to think about. Thirty of them is still
smaller than one page of the database.

The expensive version is only worth it for recovery *time* — restoring 25 GB is
minutes, rebuilding from the archive is days. Run by hand when it matters:

```bash
cd ~/mtg-collection-value-tracker
docker compose exec -T app node -e   "require('better-sqlite3')('/app/data/mtg.db').exec(\"vacuum into '/app/data/backup.db'\")"
sudo mv data/backup.db /mnt/nas_headless_backup/other/mtg/mtg-$(date +%F).db
```

`VACUUM INTO` rather than `cp`, because it snapshots consistently while the
container keeps running. It also reports fragmentation for free: if that file is
meaningfully smaller than the live database, the difference is wasted space.

## 9. Two sites, one database

A personal site on the LAN and a public one on the internet can run as two
containers over the same `mtg.db`. They differ by one flag; the 568 million
price rows they both read are identical, and copying them per site would mean
a second 27 GB file that has to be kept in step.

**The precondition is already met here: the database is on local disk.** SQLite
needs POSIX advisory locking, which NFS and SMB do not implement reliably. If
the file ever moves to the NAS, this arrangement stops being safe — not slower,
*unsafe*, with corruption as the failure mode. Both containers must also run on
the same host.

Both services are in the tracked compose file. The public one sits behind a
profile, so a plain `docker compose up -d` still means exactly what it did
before.

```bash
docker compose up -d                    # personal site only, on PORT
docker compose --profile public up -d   # both
docker compose up -d public             # public site only
docker compose down --remove-orphans    # both, whatever is running
```

Ports come from `.env`: `PORT` for the personal site (3010 here) and
`PUBLIC_PORT` for the public one (3011 by default). Only the public one needs
to be reachable from outside.

Three rules make this work, and each one is a real failure if broken:

1. **Only one instance ingests.** Two daily jobs would parse the same 50 MB
   file twice and fight over the write lock for no benefit. `CRON_ENABLED=false`
   on the public one.
2. **The session sweep runs on both regardless**, because it is not behind that
   flag. Any instance that accepts uploads expires them itself rather than
   depending on its neighbour being up.
3. **`PUBLIC_MODE=true` is what hides your collection**, and it also forces
   `ENABLE_OWNER_IMPORT` off whatever else is set. Without it, an empty owner
   collection is what triggers the upload page — and yours is not empty.

All three are set by the compose file itself rather than left to `.env`, so
the two services cannot be misconfigured into agreeing with each other.

**Do not run the two as separate compose projects.** They will fight over the
port, `docker compose down` in one directory will not stop the other, and
nothing warns you: the symptom is `Bind for 0.0.0.0:3010 failed: port is
already allocated` while `docker ps` shows a healthy container you thought you
had stopped. `docker compose ls -a` lists every project if you suspect this.

Writes from the two processes are serialised by SQLite. In WAL mode readers
never block, so the public site's pages are unaffected by an ingest in
progress; only its *writes* — an upload, a sweep — wait, for up to
`SQLITE_BUSY_TIMEOUT_MS` (30s by default, against an ingest that holds the lock
for about nine seconds).

On an upgrade, bring them up one at a time. Both run migrations at boot, and
there is no reason to have two processes discover that simultaneously.

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
