# Tracks Bun 1.3.x on Debian; pin a patch tag (e.g. 1.3.11-debian) in CI if you need byte-identical rebuilds.
FROM oven/bun:1.3-debian

# Static labels
LABEL org.opencontainers.image.source=https://github.com/sushiibot/sushii-sns
LABEL org.opencontainers.image.description="Discord SNS media downloader bot"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"

WORKDIR /usr/src/app

COPY ./package.json ./bun.lock ./

# Install dependencies
RUN bun install --production

COPY . ./

# Build info, args at end to minimize cache invalidation
ARG GIT_HASH
ARG BUILD_DATE

ENV GIT_HASH=${GIT_HASH}
ENV BUILD_DATE=${BUILD_DATE}

LABEL org.opencontainers.image.revision=${GIT_HASH}
LABEL org.opencontainers.image.created=${BUILD_DATE}

# Uses Bun only (no extra apt packages); hits loopback — not exposed to the network.
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "./src/index.ts" ]
