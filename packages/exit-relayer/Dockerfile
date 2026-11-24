# The exit relayer as an always-on worker (no HTTP port). Build from the repository root:
#
#   docker build -f packages/exit-relayer/Dockerfile .
#
# Configured by environment:
#   EXIT_RELAYER_MODE      observe (default, sends nothing) or relay
#   RELAYER_MNEMONIC       the relayer account's key, as a secret; relay mode only. Never the rollup
#                          creator's, a watchtower's or the LP's key (the relayer refuses them)
#   EXIT_PAYOUTS           comma list of payouts (qor1… or 0x…) to serve besides those announced in the inbox
#   EXIT_RELAYER_INTERVAL  seconds between passes (default 6)
#
# It keeps no state on disk: on start it reads back the inbox and asks the chain what is already done.
# One relayer per key: never run two copies with the same RELAYER_MNEMONIC.
FROM node:24-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/keel/package.json packages/keel/
COPY packages/qledger-watchtower/package.json packages/qledger-watchtower/
COPY packages/exit-relayer/package.json packages/exit-relayer/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/keel packages/keel
COPY packages/qledger-watchtower packages/qledger-watchtower
COPY packages/exit-relayer packages/exit-relayer
COPY deployments/diana.json deployments/diana.json
ENV EXIT_RELAYER_MODE=observe \
    EXIT_RELAYER_INTERVAL=6
# Node as PID 1 receives SIGTERM directly, so the relayer stops between passes.
CMD ["node", "--import", "tsx", "packages/exit-relayer/src/main.ts"]
