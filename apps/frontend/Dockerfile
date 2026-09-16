# ---------- 构建阶段：workspace 全量安装后仅构建 frontend ----------
# Node 22：pnpm@11 依赖 node:sqlite 内置模块（Node 22.5+），Node 20 下无法启动
FROM node:22-alpine AS build
WORKDIR /app
# 国内网络：依赖与 pnpm 本体均从 npmmirror 安装。
# 不用 corepack：其从镜像源拉 pnpm 时会做官方签名校验，镜像无签名导致秒失败。
# 注意：版本与根 package.json 的 packageManager 字段保持一致
ENV npm_config_registry=https://registry.npmmirror.com
RUN npm i -g pnpm@11.23.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile=false
COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
RUN pnpm --filter @zc/frontend build

# ---------- 运行阶段：nginx 静态 + /api 反代 ----------
FROM nginx:alpine
# templates 机制：启动时 envsubst 只替换已定义的环境变量（ORIGIN_TOKEN），
# $host/$remote_addr 等 nginx 内置变量不在环境变量中，不受影响
COPY apps/frontend/nginx.conf /etc/nginx/templates/default.conf.template
COPY apps/frontend/cdn-realip.conf /etc/nginx/cdn-realip.conf
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
# 兜底定义（空值）：保证 envsubst 一定能替换，避免留下 ${ORIGIN_TOKEN} 字面量导致全部 403
ENV ORIGIN_TOKEN=
EXPOSE 80
