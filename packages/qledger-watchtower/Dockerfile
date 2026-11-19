# The qledger watchtower as a long-running container. Build from the repo root:
#
#   docker build -f packages/qledger-watchtower/Dockerfile .
#
# Configured by environment:
#   WATCHTOWER_ROLLUP    rollup id, a comma list, or "all" (default vigil-pay-1)
#   WATCHTOWER_MODE      observe (default, sends nothing) or challenge
#   WATCHTOWER_MNEMONIC  the watchtower account's key, as a secret; challenge mode only
#   WATCHTOWER_INTERVAL  seconds between passes (default 10)
#   WATCHTOWER_DATA      archive and status directory; mount a volume here (default /data/watchtower)
#
# One watchtower per key: never run two copies with the same WATCHTOWER_MNEMONIC.
FROM node:24-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/qledger-watchtower/package.json packages/qledger-watchtower/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/qledger-watchtower packages/qledger-watchtower
ENV WATCHTOWER_ROLLUP=vigil-pay-1 \
    WATCHTOWER_MODE=observe \
    WATCHTOWER_INTERVAL=10 \
    WATCHTOWER_DATA=/data/watchtower \
    WATCHTOWER_FOLLOW=ws \
    WATCHTOWER_GAS_PRICE=0.3 \
    WATCHTOWER_CHALLENGE_DELAY=0
CMD ["sh", "-c", "exec node --import tsx packages/qledger-watchtower/src/cli.ts --rollup \"$WATCHTOWER_ROLLUP\" --mode \"$WATCHTOWER_MODE\" --interval \"$WATCHTOWER_INTERVAL\" --data \"$WATCHTOWER_DATA\""]
