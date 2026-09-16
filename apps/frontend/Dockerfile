# ---------- 构建阶段：workspace 全量安装后仅构建 frontend ----------
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile
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
