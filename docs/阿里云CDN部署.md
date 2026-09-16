# 阿里云全站加速（DCDN）部署指南

## 架构

```
学生浏览器 ──HTTPS──▶ 阿里云 DCDN 节点
                        │  静态资源（/assets/*，hash 文件名）→ 边缘缓存命中，不回源
                        │  动态请求（/api/*）→ 就近接入 + 链路优化回源
                        ▼
        源站 nginx(frontend 容器 :8080) ──▶ backend(:3000)
```

源站侧适配已内置（无需改代码）：

| 适配点 | 位置 | 说明 |
|---|---|---|
| 真实客户端 IP | `apps/frontend/cdn-realip.conf` | 信任 CDN 回源透传的 `ali-cdn-real-ip` 头，realip 处理后 `$remote_addr` = 学生真实 IP；nginx 再把传给 backend 的 `X-Forwarded-For` **覆写**为该单一 IP，后端按 XFF 首段取 IP（登录限流/审计不受 CDN 影响，且客户端伪造的 XFF 链被丢弃） |
| 防绕过 CDN 直连 | `nginx.conf` + `ORIGIN_TOKEN` | 校验回源自定义头 `X-Origin-Token`，不匹配返回 403。攻击者直连源站伪造 `ali-cdn-real-ip`/XFF 骗登录限流会被拦截 |
| 入口 HTML 防白屏 | `nginx.conf` | `index.html` 强制 `no-cache`：CDN 缓存旧入口会指向发版后已删除的 hash 资源 |
| API 防缓存 | `nginx.conf` | `/api/*` 强制 `no-store`，DCDN 遵循源站头，绝不缓存动态响应 |
| 大文件上传 | — | 学生材料包 ≤100MB，低于 DCDN 单文件上传 300MB 上限，无需处理 |

## 一、服务器侧（源站）

```bash
# 1. 生成回源 token，写入 .env
echo "ORIGIN_TOKEN=$(openssl rand -hex 16)" >> .env

# 2. 重启 frontend 容器（重新读取 ORIGIN_TOKEN）
docker compose --profile frontend up -d frontend
```

> ORIGIN_TOKEN 留空 = 不校验（本地/未套 CDN 直连部署兼容旧行为）。

## 二、阿里云控制台配置

### 1. 添加加速域名

- 产品：**全站加速 DCDN** → 域名管理 → 添加域名
- 业务类型：全站加速
- 加速区域：仅中国内地（学校场景）或全球
- 源站信息：**IP**，填服务器公网 IP，端口 **8080**，协议 HTTP

### 2. 回源配置（关键）

域名管理 → 配置 → **回源配置 → 自定义 HTTP 回源头**（添加请求头）：

```
X-Origin-Token: <.env 里 ORIGIN_TOKEN 的值>
```

> 没有这一步，启用 token 后 CDN 回源会被源站 403，全站不可用。

### 3. 缓存配置（关键）

域名管理 → 配置 → **缓存配置 → 添加缓存规则**（优先级从上到下）：

| 规则 | 类型 | 缓存行为 |
|---|---|---|
| `/index.html` 和 `/` | 文件名/目录 | **不缓存**（TTL=0） |
| `/assets/` | 目录 | 遵循源站（源站已发 `immutable` 1 年） |
| `/api/` | 目录 | **不缓存** |

> 源站响应头已带 `no-cache`/`no-store`/`immutable`，正常情况下 DCDN「遵循源站」即可；上表是显式兜底，防止默认扩展名规则误缓存 html。

### 4. HTTPS

- 证书管理：上传学校域名证书，或用阿里云免费证书（DV）
- 域名配置 → HTTPS 配置 → 开启，强制跳转 HTTP→HTTPS
- 回源保持 HTTP:8080 即可（源站在阿里云内封闭，如需更高安全可后续上回源 HTTPS）

### 5. DNS 解析

控制台给出 CNAME 值（形如 `xxx.w.kunlungr.com`），到域名 DNS 服务商添加：

```
zc.example.edu.cn  CNAME  xxx.w.kunlungr.com
```

## 三、安全加固（建议）

1. **安全组限制 8080 直连**：控制台「工具 → 获取 CDN/DCDN 回源节点 IP」下载网段列表，安全组只放行这些网段 + 管理员办公 IP。套 CDN 后学生不再直连 8080。
2. **精确 realip 白名单**：把下载的回源网段替换进 `apps/frontend/cdn-realip.conf`（删除 `set_real_ip_from 0.0.0.0/0;`，一行一段），重新 build frontend。与 X-Origin-Token 形成双重防护。
3. 每学期检查一次网段列表是否有更新。

## 四、验证清单

```bash
# 1. 直连伪造被拦：无 token 直连源站 → 403
curl -I http://服务器IP:8080/                        # 403
curl -I -H "X-Origin-Token: 错误值" http://服务器IP:8080/   # 403

# 2. 通过域名正常访问 → 200
curl -I https://zc.example.edu.cn/                   # 200

# 3. 真实 IP 透传：frontend 容器访问日志中 remote_addr 应为学生公网 IP 而非 CDN 节点 IP
docker compose logs frontend | tail -n 20

# 4. API 未被缓存：登录接口两次请求返回不同（带新鲜 token/错误提示）
curl -X POST https://zc.example.edu.cn/api/v1/auth/login -H 'Content-Type: application/json' -d '{}'

# 5. 发版无白屏：docker compose --profile frontend up -d --build frontend 后，
#    强刷浏览器（Ctrl+F5）确认加载的是新 hash 的 assets
```

## 五、已知限制与注意

- DCDN 上传单文件上限 **300MB**（本项目学生材料包 ≤100MB，不受影响）：[DCDN 使用限制](https://help.aliyun.com/zh/dcdn/product-overview/before-you-start)
- 回源 HOST 为加速域名：源站 nginx `server_name _` 通配，无需处理
- 数字大外 CAS 登录（`POST /api/v1/auth/cas-login`）为后端代理式，不经浏览器回调，与 CDN 无关，无需改 `CAS_SERVICE`
- 4C4G 源站 + 1000 人查分：查分热路径为 Redis 快照单 GET，CDN 承接全部静态流量后源站只吃 `/api`，容量余量充足（详见 README 压测数据）
- 换 `ORIGIN_TOKEN` 需同步改控制台回源头，否则全站 403
