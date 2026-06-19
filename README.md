<div align="center">

# 🦅 Wren

**A self-hosted, privacy-first management system for nurseries and schools — with sovereign, on-device AI.**

*Observations, daily diaries, attendance, ratios, rotas, safeguarding, planning, parent comms and reporting — in one place you actually own.*

</div>

---

## What is Wren?

Wren is a complete Management Information System (MIS) for early-years settings and schools, built to run **on your own hardware**. No per-child SaaS fees, no child data leaving the building, no vendor lock-in. It's already running a real Ofsted-registered nursery day-to-day.

It ships in three **editions** from one codebase:

| Edition | For |
|---------|-----|
| **EYFS** | Nurseries & pre-schools (0–5), EYFS framework tracking |
| **Primary** | Primary schools |
| **Secondary** | Secondary schools (incl. timetabling) |

Each edition exposes role-based **portals** — a tablet-friendly practitioner app, an admin/management console, an HR portal, and a parents' portal — over a single backend with hostname-based dispatch.

## Why self-host it?

- **GDPR by design.** Children's data and observations stay on your server. AI runs **locally** (Ollama) — nothing sensitive is sent to a third-party API.
- **You own your data.** Plain PostgreSQL, nightly backups, full export. Migrate in or out whenever you like.
- **No subscription treadmill.** Run it on a mini-PC or a spare box.

## Features

**Early years & teaching**
- Observations with multi-framework tagging (Development Matters, statutory EYFS areas, a SEND small-steps tracker, Leuven involvement/wellbeing scales, phonics progression) — pick an **age band first, then tick strands**
- Learning journeys, next steps, daily diaries, 2-year progress checks, summative & transition reports
- Framework coverage trackers + an observation tracker (by staff / child / EYFS area)
- Planning: long/medium/weekly, curriculum drag-and-drop, an activities bank

**Operations & people**
- Attendance register & live **occupancy + statutory staff:child ratio** forecasting (sees how numbers move as children join, leave and age into the next band)
- **Working-time patterns** → auto-generated **rotas** with ratio/DSL/first-aider checks, TOIL & absence (Bradford factor), bank-holiday handling
- Medicine records, accident/incident logs with body-map & signatures, safeguarding with sign-off chains
- Kitchen / menus, repairs, compliance & inspection readiness

**Parents & comms**
- Parents' portal, messaging, newsletters, permission slips, surveys

**AI (local & optional)**
- Voice-note transcription, report drafting, summarisation — all via your own Ollama models. Demo/sales instances can use a hosted model; production stays local.

## Tech stack

- **Backend:** Node.js + Express, PostgreSQL
- **Frontend:** server-rendered HTML + a lightweight shared shell (no heavy SPA framework); tablet-first
- **AI:** Ollama (local) — embeddings + chat/vision models
- **Deployment:** Docker / Docker Compose; reverse-proxied with nginx; Cloudflare Tunnel optional for remote access

## Running it

The fastest way is the self-host bundle in [`docker/eyfs-selfhost/`](docker/eyfs-selfhost/) — it ships its own Postgres, pre-seeded with **demo data only** (no real children), so you get a working instance in a couple of minutes. Full notes: [`docker/eyfs-selfhost/README.md`](docker/eyfs-selfhost/README.md).

```bash
cd docker/eyfs-selfhost
cp .env.example .env          # then set PG_PASSWORD and JWT_SECRET
docker compose up -d --build  # builds the app + starts Postgres
# open http://localhost:8080  (default manager login: olivia@demo.wren / PIN 1234)
```

The only host dependency is **Docker with the Compose plugin** (Docker Desktop on Windows/Mac, or Docker Engine on Linux). No Node or Postgres needed on the host. AI features are optional — point them at a local [Ollama](https://ollama.com) or a free Groq API key.

## Project status

Wren is **actively used in production** at a real Ofsted-registered nursery and under active development toward a packaged, self-hostable release across all three editions. Expect rapid iteration. Issues and PRs from self-hosters are very welcome.

## A note on frameworks & licensing

Wren ships with the free, openly-licensed frameworks: DfE **Development Matters** and the statutory **EYFS** areas (both Open Government Licence), plus a SEND small-steps tracker, Leuven involvement/wellbeing scales and a phonics progression. Other frameworks (e.g. **Birth to 5 Matters**, and the **Early Years Developmental Journal**) are **not** bundled — add them yourself under your own licence.

## Licence

**AGPL-3.0** — see [`LICENSE`](LICENSE). Download it, self-host it, modify it; if you run a modified version as a network service you must share your changes under the same licence. "EYFS", "Development Matters" and other framework names belong to their respective owners.
