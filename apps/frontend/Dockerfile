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
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 80
