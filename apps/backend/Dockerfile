# ---- build ----
FROM node:20-slim AS build
WORKDIR /repo
# 国内网络：npm 与 corepack 下载 pnpm 本体均走 npmmirror（淘宝镜像）
ENV npm_config_registry=https://registry.npmmirror.com \
    COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN npm i -g corepack@latest && corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
RUN pnpm install --frozen-lockfile=false --filter @zc/backend... --filter @zc/shared...
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN pnpm --filter @zc/shared build && pnpm --filter @zc/backend build

# ---- runtime ----
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo ./
RUN groupadd -r zc && useradd -r -g zc zc && mkdir -p /app/uploads /app/tmp && chown -R zc:zc /app
USER zc
EXPOSE 3000
CMD ["node", "apps/backend/dist/main.js"]
