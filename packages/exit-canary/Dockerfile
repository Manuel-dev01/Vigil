# The exit canary as a scheduled job (no HTTP port, no state). Build from the repository root:
#
#   docker build -f packages/exit-canary/Dockerfile .
#
# The image's command is a dry run: it reads the vault and the rollup and sends nothing. It sends only
# when the command is given BOTH --key <the canary's own key file> and --broadcast (see the README).
# The key never goes into the image.
FROM node:24-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/keel/package.json packages/keel/
COPY packages/qledger-watchtower/package.json packages/qledger-watchtower/
COPY packages/exit-relayer/package.json packages/exit-relayer/
COPY packages/exit-canary/package.json packages/exit-canary/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/keel packages/keel
COPY packages/qledger-watchtower packages/qledger-watchtower
COPY packages/exit-relayer packages/exit-relayer
COPY packages/exit-canary packages/exit-canary
COPY deployments/diana.json deployments/diana.json
# The committed inbox archive (public chain data): entries the chain has pruned, for the L2 replay.
COPY data/inbox data/inbox
CMD ["node", "--import", "tsx", "packages/exit-canary/src/main.ts"]
