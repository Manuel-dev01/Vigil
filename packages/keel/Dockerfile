# Keel, the vigil-pay-1 sequencer, as an always-on worker (no HTTP port).
# Build from the repository root:  docker build -f packages/keel/Dockerfile .
#
# The creator's key comes from secret service variables (PRIVATE_KEY and
# QORE_PQC_RECOVERY_CODE), never from the image. Mount a volume at /data so the
# ledger snapshot survives restarts; Keel re-checks it against the chain anyway.
FROM node:24-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/keel/package.json packages/keel/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/keel packages/keel
ENV KEEL_DATA_DIR=/data/keel/vigil-pay-1 \
    KEEL_LOCK=0
# Node as PID 1 receives SIGTERM directly, so Keel stops between passes.
CMD ["node", "--import", "tsx", "packages/keel/src/main.ts"]
