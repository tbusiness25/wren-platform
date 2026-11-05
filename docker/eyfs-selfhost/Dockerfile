FROM node:20-alpine

# WREN_EDITION_ARG kept for compatibility with existing app code
ARG EDITION=eyfs
ENV WREN_EDITION_ARG=${EDITION}

WORKDIR /app

# rclone is used by the optional Google Drive resources route; wget for healthcheck
RUN apk add --no-cache rclone wget && apk upgrade --no-cache

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY public/ ./public/
COPY editions/ ./editions/
COPY shared/ ./shared/

# Shared front-end assets are served at the /_shared/ URL. In the hosted
# deployment that path is satisfied by bind-mounting shared/ -> public/_shared/;
# this image has no bind mounts, so we copy the assets into public/_shared/ so
# /_shared/wren-demo-banner.js etc. resolve. (The demo banner self-gates on
# /api/edition's demo flag, so it stays hidden when DEMO_MODE is false.)
COPY shared/ ./public/_shared/

# Safety scrub: the repo's editions/ directory contains live .env files and
# timestamped .env.bak-* backups for the *hosted* deployments. The build
# context's .dockerignore excludes "**/.env" but NOT the ".bak" variants, so we
# delete every .env* under editions/ here. This image must never ship a real
# credential — all config is provided at runtime via env_file (.env).
RUN find /app/editions -type f -name '.env*' -delete

# The repo's scripts/ directory is intentionally NOT copied whole — some files there
# embed private API tokens / DB passwords. Instead we ship only:
#   - a no-op stub of sync-cf-allowlist.js (a route imports it at startup), and
#   - the scrubbed demo seed (so the in-app "reset demo data" button works).
# Both come from this bundle's scrubbed scripts-stub/ directory.
COPY docker/eyfs-selfhost/scripts-stub/sync-cf-allowlist.js ./scripts/sync-cf-allowlist.js
COPY docker/eyfs-selfhost/scripts-stub/demo-seed-eyfs.sql   ./scripts/demo-seed-eyfs.sql
# ...and the few scripts/ modules the app require()s at runtime (phonics lessons and
# assessments, printables, survey invites, the framework checker). Explicit files, so a
# build from the private tree still ships nothing else. Same list as RUNTIME_SCRIPTS in
# scripts/build-public-repo.sh.
COPY scripts/survey-auto-invites.js scripts/framework-checker.js ./scripts/
COPY scripts/phonics/assessment-content.js scripts/phonics/lesson-data.js scripts/phonics/validate-decodable.js scripts/phonics/illustration-kit.js ./scripts/phonics/
COPY scripts/phonics/data/cmudict.dict scripts/phonics/data/cmudict.LICENSE scripts/phonics/data/extra-pronunciations.json ./scripts/phonics/data/
COPY scripts/printables/picture-bank.js scripts/printables/frame-boxes.json ./scripts/printables/

RUN mkdir -p /app/data /app/uploads
COPY docker/eyfs-selfhost/defaults/framework-versions.json ./data/
COPY docker/eyfs-selfhost/defaults/field-config.json ./data/

EXPOSE 3000

# All configuration is injected at runtime via env vars — nothing baked in.
# Required: PG_HOST PG_PORT PG_DB PG_USER PG_PASSWORD PG_SCHEMA JWT_SECRET
# Optional: DEMO_MODE AI_PROVIDER GROQ_API_KEY

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "editions/eyfs/server-unified.js"]
