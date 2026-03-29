# sushii-sns

Private Discord bot for downloading media from social links (`dl …` in whitelisted channels), extracting attachment URLs (`links` reply), and optionally running the Instagram **monitor** (connections, review UI, SQLite). See [docs/architecture.md](docs/architecture.md) and [CLAUDE.md](CLAUDE.md).

## Commands

```bash
bun install
bun dev          # logs via pino-pretty
bun start        # production-style logging
bun run typecheck
bun test
```

Health and status: HTTP server on port **8080** (`/v1/health`, `/v1/ready`, `/v1/status`, …).

Runtime: [Bun](https://bun.sh).
