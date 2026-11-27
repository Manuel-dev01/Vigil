# The sentinel as an always-on worker (no HTTP port, no key). Build from the repository root:
#   docker build -f packages/sentinel/Dockerfile .
# Configure TELEGRAM_BOT_TOKEN (secret) and optionally TELEGRAM_CHAT_ID and EXIT_PAYOUTS.
# It re-executes batches with the watchtower's pure core (packages/qledger-watchtower/src/check.ts,
# imported by path), so that package's sources and dependencies are in the image; its key-holding
# parts are never run here.
FROM node:24-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/qledger-watchtower/package.json packages/qledger-watchtower/
COPY packages/sentinel/package.json packages/sentinel/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/qledger-watchtower/src packages/qledger-watchtower/src
COPY packages/sentinel packages/sentinel
COPY deployments/diana.json deployments/diana.json
# The committed inbox archive (public chain data): entries the chain has pruned, for the re-execution.
COPY data/inbox data/inbox
CMD ["node", "--import", "tsx", "packages/sentinel/src/main.ts"]
