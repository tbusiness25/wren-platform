# Wren on Raspberry Pi — small-setting edition

For childminders and small nurseries running **two tablets and not much else**.
Total hardware cost ≈ £90–130 vs £600+ for the standard mini-PC tier.

## Hardware

| | Minimum | Recommended |
|---|---|---|
| Board | Pi 4, 4GB | **Pi 5, 8GB** |
| Storage | 32GB A2 microSD | **USB SSD (any 120GB+)** — SD cards wear out under database writes |
| Power | Official PSU | Official PSU (Pi 5 needs the 27W one) |
| Network | Wi-Fi | **Ethernet** to the router |
| OS | Raspberry Pi OS **64-bit** Lite | same |

## Install

```bash
# on the Pi, from a copy of the wren self-host bundle:
bash pi/install-wren-pi.sh
```

The script checks the hardware, installs Docker, generates secrets, builds with
the Pi resource profile (`pi/docker-compose.pi.yml`) and starts Wren on
`http://<pi-ip>:8080`. Open that on the tablets → "Add to Home Screen".
Re-running the script is safe (never overwrites `.env` or data).

## What's different from the full install

- **No local AI.** A Pi can't run an LLM. `AI_PROVIDER=none` hides/degrades AI
  features gracefully (statement suggestions fall back to keyword matching).
  For AI report drafting set `AI_PROVIDER=groq` + `GROQ_API_KEY` in `.env` —
  note that sends report text to Groq's cloud (document in the setting's
  privacy notice; child names can be toggled out of prompts in a later rev).
- **Memory caps**: Postgres 512MB / app 1GB, tuned in `pi/docker-compose.pi.yml`.
- **Everything else is the same bundle** — same images (`node:20-alpine`,
  `postgres:16-alpine`, both publish linux/arm64), same first-run wizard, same
  backup story (nightly `pg_dump` cron recommended; see below).

## Backups (do this)

```bash
# nightly dump to the SSD, keep 14 days — add to crontab -e:
0 2 * * * docker exec $(docker ps -qf name=db) pg_dump -U wren wren | gzip > /home/pi/wren-backups/wren-$(date +\%F).sql.gz && find /home/pi/wren-backups -mtime +14 -delete
```

Off-site: sync `/home/pi/wren-backups` with rclone to any cloud drive.

## Not yet done / next steps
- [ ] CI arm64 image build (buildx) so installs pull a prebuilt image instead of 15-min on-Pi builds
- [ ] Verify on real Pi 4 + Pi 5 hardware (script is untested on-device — written 2026-07-03)
- [ ] Pre-flashed SD/SSD image ("Wren Pi" appliance) for the installer roadmap
- [ ] Optional Cloudflare tunnel for parent-portal-from-home

## Childminder edition

The childminder version is the same install with the **childminder preset**:

```bash
bash pi/install-wren-pi.sh --childminder
```

That strips the portal to what a childminder actually needs — learning journal
(EYFS observations + trackers), daily diary, parents portal, messaging,
invoicing/payments, planning, policies — and switches off staff/rota/HR,
health & safety and buildings, inspection machinery, CPD, and all AI.
Children, Safeguarding and System stay on always (statutory/core).

It's a preset, not a different product: everything can be switched back on
later in **Roost → System → Setup & Features** (one tap on "Full nursery").
The first login after setup gets a guided tour covering only the enabled modules.
