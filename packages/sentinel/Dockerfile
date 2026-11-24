# The sentinel as an always-on worker (no HTTP port, no key). Build from the repository root:
#   docker build -f packages/sentinel/Dockerfile .
# Configure TELEGRAM_BOT_TOKEN (secret) and optionally TELEGRAM_CHAT_ID.
FROM node:24-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/sentinel/package.json packages/sentinel/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/sentinel packages/sentinel
COPY deployments/diana.json deployments/diana.json
CMD ["node", "--import", "tsx", "packages/sentinel/src/main.ts"]
