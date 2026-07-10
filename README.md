<div align="center">

# 🐦 Wren

**Self-hosted nursery & school management — your data on your hardware, AI that never leaves the building.**

Wren runs an early-years setting (or a school) end to end: children's learning journeys, daily diaries, photos, observations, attendance, medicine, funding, rotas, parent messaging and more — across staff, admin, HR and parent portals. It's built to be **self-hosted**, so the nursery owns its data outright and the AI features run on your own machine, not someone else's cloud.

Source-available under BSL 1.1 · Node + Postgres · one `docker compose up` · runs on a Raspberry Pi

</div>

---

## Why Wren exists

Most nursery software is a subscription that holds your families' data on the vendor's servers and charges per child, forever. Wren was built by a nursery owner who got tired of that: **install it once on a mini-PC or a Pi in the office, and it's yours.** No per-child fees, no data leaving the building, no lock-in.

For the self-hosting crowd specifically:

- 🔒 **Your data stays on your box.** Postgres on your hardware. No telemetry, no phone-home.
- 🧠 **Local AI.** Observation write-ups, report drafting, an admin assistant and more run against a local [Ollama](https://ollama.com) model. No OpenAI key required; nothing sent to the cloud. (A cloud provider is *optional* if you'd rather.)
- 🐳 **One command.** `docker compose up -d`. Postgres + app, done.
- 🥧 **Runs on a Pi.** A Raspberry Pi 4/5 handles a small setting comfortably (AI features degrade gracefully or point at a beefier box on your LAN).
- 📴 **Offline-tolerant.** Staff can keep logging observations when the internet drops; they sync when it's back.
- 🧩 **Modular.** Turn whole sections on/off in the setup wizard — a childminder preset strips it back to just the learning journal and parent sharing.

## What's in it

**Early Years (EYFS) — the core:**
- Learning journeys & observations (photo/video, EYFS / Birth-to-5 / Development Matters / Leuven framework tagging)
- Daily diary — meals, naps, nappies, bottles, sun cream
- Attendance register with sign-in/out, medicine records, accident/incident sheets
- Two-year progress checks, next steps, cohort trackers
- Funding & invoicing, funded-hours reconciliation, parental FEEE declarations

**Staff & HR:**
- Rota builder with live ratio/wage tracking, work patterns, Bradford scores
- Supervisions, CPD academy, training matrix, TOIL
- An AI "Fair Leave" tool that ranks competing holiday requests by objective rules (and flags — never scores down — protected characteristics)

**Parents:**
- A parents portal (PWA — installable on a phone) for the diary, learning journey, photos, messaging, calendar subscribe, funding forms

**Admin:**
- Occupancy/admissions pipeline & waiting list, enquiries, kitchen & food safety, policies, an inspection-readiness dashboard
- A local-AI assistant grounded in your own documents

**Also has:** primary & secondary school editions (CTF import, timetabling, homework, parents' evenings) — earlier-stage than the EYFS core.

## Quick start (self-host)

Everything you need is in [`docker/eyfs-selfhost/`](docker/eyfs-selfhost/).

```bash
git clone https://github.com/tbusiness25/wren-platform.git
cd wren-platform/docker/eyfs-selfhost

# Mac / Linux:
cp default.env.example .env      # then edit .env (a DB password + JWT secret; the Pi installer generates these for you)
docker compose up -d

# Raspberry Pi (one-shot installer — generates secrets, builds, starts):
bash pi/install-wren-pi.sh
#   ...or for a stripped-down childminder instance:
bash pi/install-wren-pi.sh --childminder

# Windows: install Docker Desktop (uses WSL 2), then run
#   "Install Wren (Windows).bat"  (in docker/eyfs-selfhost/windows/)
```

Then open the URL it prints. A **browser-based setup wizard** walks you through your setting's name, rooms, staff (you create the first manager + PIN), children and which modules you want — followed by a guided tour of everything you switched on.

**AI features:** point `OLLAMA_HOST` at an Ollama instance (same box, or another machine on your LAN for bigger models). Leave it unset and AI features hide or fall back gracefully.

**Back it up:** nightly local dumps are automatic; see the self-host README for one-command USB and Google-Drive (rclone) off-site backup recipes.

## Tech

Node.js + Express, PostgreSQL, vanilla-JS portals (no heavy framework), service-worker PWAs, optional Ollama for AI. Base images are multi-arch (amd64 + arm64).

## Status & honesty

Wren is **live in real nurseries** and actively developed, but it's young and moving fast — expect rough edges, and the school editions are earlier than the EYFS core. It's built and maintained by a very small team (currently one nursery owner who codes), so self-host support is best-effort and community-driven. Issues and PRs welcome; be kind.

## Licence

Source-available under the **Business Source License 1.1** (see [`LICENSE`](LICENSE)):

- ✅ **Free** to download, self-host and modify for **your own setting** — nursery, childminder or school.
- ❌ You can't resell it, offer it as a hosted service to others, or ship it pre-installed on hardware — those rights stay with Wren Software Ltd (that's what funds development).
- 🔓 Each released version **automatically becomes open source (AGPL-3.0) four years after release.**

If you run your own nursery and want to self-host Wren for it, you're exactly who this is for. 🐦
