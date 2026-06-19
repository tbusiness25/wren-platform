# Wren on Windows

**Requirements:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (keep the WSL2 engine option ticked).

**Install:** double-click **`Install Wren (Windows).bat`**. It will:
1. check Docker Desktop is running,
2. create `.env` with strong random secrets,
3. build + start Wren (app + bundled Postgres, demo data only),
4. open `http://localhost:8080`.

Demo manager login: `olivia@demo.wren` / PIN `1234` — change it in **Staff** once you're in.

To stop: `docker compose down` (from the `docker/eyfs-selfhost` folder). Your data lives in a Docker volume and survives restarts.

> Why a script and not a packaged `.exe`? Wren runs as Docker containers, so the
> "installer" just drives Docker Desktop. A PowerShell script is transparent
> (you can read exactly what it does), needs no code-signing, and won't trip
> antivirus the way an unsigned bootstrapper `.exe` would.
