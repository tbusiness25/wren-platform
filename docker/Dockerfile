FROM node:20-alpine

ARG EDITION=eyfs
ENV WREN_EDITION_ARG=${EDITION}

WORKDIR /app

# Install rclone for Google Drive resources route; upgrade to pull openssl 3.5.6-r0 and other security patches
RUN apk add --no-cache rclone && apk upgrade --no-cache

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY public/ ./public/
COPY editions/ ./editions/
COPY scripts/ ./scripts/
COPY shared/ ./shared/
COPY extensions/ ./extensions/

RUN mkdir -p /app/data /app/uploads

EXPOSE 3000

# Use shell form so we can reference ENV var
CMD node editions/${WREN_EDITION_ARG}/server.js
