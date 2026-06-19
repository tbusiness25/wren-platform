# Wren — EYFS edition (self-host)

Wren is a self-hosted early-years / nursery management system built for the UK
EYFS framework. This bundle runs the EYFS edition with its own bundled Postgres
database, pre-seeded with **demo data only** so the dashboards aren't empty on
first launch. Clone it, bring it up, and you have a working Wren instance on your
LAN in a couple of minutes.

> **Demo data only — no real children, parents, or staff.** The seeded records
> (Olivia Davis and colleagues, the children, the parents) are all fictional.
> Wipe them and add your own once you're set up (see *Resetting / wiping*).

---

## Prerequisites

- **Docker** with the **Compose plugin** — either Docker Desktop, or Docker
  Engine + `docker compose` on Linux. That's it. No Node, no Postgres, no other
  dependencies on the host.

### Running on Windows (WSL2 / Docker Desktop)

Wren runs on Windows with **no changes** — it's plain Docker Compose:

1. Install **[Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)** and keep **"Use the WSL 2 based engine"** ticked (the default).
2. Open **PowerShell** (or a WSL2 Ubuntu terminal) and run the Quick start commands below. `localhost:8080` works from the Windows browser.
3. **Optional AI on a GPU box:** install [Ollama for Windows](https://ollama.com/download) (or run it in WSL2 with CUDA) and set `AI_PROVIDER=ollama` + `OLLAMA_HOST`. No GPU? Use the free Groq option in `.env.example`.

If you can install Docker Desktop, you can run Wren on Windows.

---

## Quick start

```bash
# 1. Get the bundle (or copy this folder somewhere)
#    cd into docker/eyfs-selfhost

# 2. Create your config from the template
cp .env.example .env

# 3. Edit .env — at minimum set PG_PASSWORD and JWT_SECRET.
#    Generate good secrets with:
#      openssl rand -hex 24   # for PG_PASSWORD
#      openssl rand -hex 32   # for JWT_SECRET

# 4. Build and start
docker compose up -d --build
```

On first boot the database container creates the `demo_eyfs` schema and loads the
seed (this happens once, into a named Docker volume — subsequent restarts are
instant). Give it 20–30 seconds, then open:

```
http://localhost:8080
```

(or `http://<this-machine-ip>:8080` from another device on your LAN).

Change the port with `PORT=` in `.env` if 8080 is taken.

---

## Logging in

The seed creates a working **manager** account. Documented default credentials:

| Field | Value |
|-------|-------|
| **PIN** | `1234` |
| email | `olivia@demo.wren` |
| role  | manager |

All seeded demo staff use **PIN `1234`**. These are public, known defaults —
**change them before exposing Wren to anything but your trusted LAN** (see
*Security* below).

---

## Changing the admin credentials

**From the app (easiest):** log in as the manager → **Staff** → edit a staff
member → set a new PIN.

**From SQL (e.g. to rotate the manager PIN directly):** Wren stores a bcrypt hash
of the PIN. Generate a hash and update the row:

```bash
# produce a bcrypt hash of your new PIN (example uses the app's own bcrypt)
docker compose exec wren-eyfs node -e \
  "console.log(require('bcryptjs').hashSync(process.argv[1],10))" 5678

# then set it on the manager (staff id 1), using the hash printed above
docker compose exec db psql -U wren -d wren -c \
  "UPDATE demo_eyfs.staff SET pin_hash='<paste-hash-here>' WHERE id=1;"
```

(Adjust the schema name if you changed `PG_SCHEMA`.)

---

## Demo controls

This bundle ships with `DEMO_MODE=false`, so the floating **Demo controls** panel
(*Viewing as* / *AI hardware tier* / *Reset*) and the demo badge are **off** —
you get a clean instance. If you actually want those sales-demo affordances, set
`DEMO_MODE=true` in `.env` and `docker compose up -d` again.

---

## AI assistant (optional)

The in-app AI assistant needs a language-model provider. The simplest is a free
**Groq** API key from <https://console.groq.com> — add it to `.env`:

```env
AI_PROVIDER=groq
GROQ_API_KEY=your-key-here
```

Then `docker compose up -d` to pick it up. Everything else works without it.

---

## Resetting / wiping

```bash
docker compose down        # stop the stack, KEEP the database
docker compose down -v      # stop AND wipe the database volume
                            #   -> next `up` re-creates the fresh demo from scratch
docker compose up -d        # start again
```

`down -v` is the clean-slate button: it deletes the `db-data` volume so the
seed runs again on the next start.

---

## Ports

| Service    | Container port | Host port            |
|------------|----------------|----------------------|
| Wren app   | 3000           | `${PORT}` (default **8080**) |
| Postgres   | 5432           | *not published* (internal only) |

Postgres is intentionally **not** exposed to the host — only the app talks to it
over the internal Docker network. If you need direct DB access, use
`docker compose exec db psql -U wren -d wren`.

---

## Security

Wren self-host is **LAN-first** — designed to run on a trusted local network
(behind your router), not naked on the public internet. Before exposing it more
widely (a reverse proxy, a VPN, a tunnel, etc.), rotate every default:

1. **`PG_PASSWORD`** — set a strong, unique Postgres password in `.env`
   (`openssl rand -hex 24`). Do this *before the first `up`*, because it's baked
   into the database on first boot.
2. **`JWT_SECRET`** — set a long random value (`openssl rand -hex 32`). This signs
   login sessions; the default placeholder is guessable and must be replaced.
3. **The seeded admin PIN (`1234`)** — change it (see *Changing the admin
   credentials*). Every seeded account uses it.
4. **Put TLS in front of it** — terminate HTTPS at a reverse proxy (Caddy,
   nginx, Traefik) or a tunnel (Cloudflare Tunnel, Tailscale) rather than serving
   plain HTTP across an untrusted network.

If you've already started the stack with the defaults and *then* changed
`PG_PASSWORD`, run `docker compose down -v && docker compose up -d` so the
database is re-created with the new password.

---

## Troubleshooting

- **Page won't load / 502:** give the app ~30s on first boot (it waits for the DB
  healthcheck). Check logs: `docker compose logs -f wren-eyfs`.
- **DB didn't seed:** the seed only runs on a *fresh* volume. If you changed the
  seed or want a clean DB: `docker compose down -v` then `up -d`.
- **Port already in use:** change `PORT=` in `.env`.
