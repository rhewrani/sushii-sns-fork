FROM oven/bun:1.1.38-debian

# Static labels
LABEL org.opencontainers.image.source=https://github.com/sushiibot/sushii-sns
LABEL org.opencontainers.image.description="Discord SNS media downloader bot"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"

# Install curl
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

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

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD [ "curl", "-f", "http://localhost:8080/v1/health" ]

USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "./src/index.ts" ]
