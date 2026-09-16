# 综合素质测评（综测）计算平台

大连外国语大学软件学院综测全流程线上化：学生移动端分步提交加分申请与材料（后端按命名规范自动打包）→ 班委初审（zip 在线浏览）→ 辅导员复审核定 → 计算引擎自动算分排名 → 公示/异议/增量更正 → 分班/全年级严格模板导出。

## 计算模型（每学期一轮批次，100 分制）

| 维度 | 口径 |
|---|---|
| 品德 15 | 基础 9 + 奖扣分（献血+1、优秀班导生+1.5、实践志愿取最高档等）；封顶 15；不足 9 置「取消评优资格」flag |
| 学业 75 | 加权均分×0.75（公选课不计；**第一次考试成绩为准**）+ 全科加分（85+ 加 2 / 80+ 加 1，判定含公选成绩）+ 竞赛/证书/科研 − 必修不及格每科扣 1；封顶 75 |
| 文体 10 | 基础分（有专项体育课则=体育成绩/100×3）+ 学生干部取最高 ≤3 + 文体活动小计 ≤4；封顶 10 |
| 排名 | (总分↓, 品德↓, 学业↓, 文体↓, 学号↑) dense rank，年级 + 班级双排名 |

### 官方口径实证（golden test 30/30 学生逐列反推验证）

1. 等级制「优」按 **95 分**计入加权（军事技能两例算术精确验证）
2. **专业选修课（属性=任选）计入加权**，仅「公共选修课/公选」剔除
3. 「体育与健康」不折算文体基础分（基础 3）；仅「体育(一)」类专项课折算
4. 全科 85+/80+ 判定池**包含**公选课成绩
5. 舍入 ROUND_HALF_UP 2 位；导出 R 列（不及格扣分）为负值口径

## 技术栈与架构

- **后端** NestJS 10 + TypeScript + Prisma（MySQL 8 生产 / SQLite 本地）+ Redis（查分快照/限流/幂等，未配置时自动退化为进程内缓存）
- **前端** React 18 + antd 5 + Vite + react-router 6（`apps/frontend`）：学生端移动优先（底部 TabBar + 提交向导 + 查分）、班委端初审工作台（zip 在线浏览）、管理端桌面中台（导入/审核/计算/发布/导出/系统）
- **任务** 导入/计算/导出为 jobId 化后台任务（同批次同类互斥），前端轮询 `GET /imports/jobs/:id`
- **安全** JWT(access+refresh 轮换/重用检测) · argon2id · 登录双重限流+指数锁定 · RBAC+数据范围(班委锁本班/辅导员锁本年级) · 上传白名单+魔数嗅探 · zip 沙箱(炸弹/穿越/超限全量预检+懒解压) · 审计日志全链路 · 身份证 AES-GCM

```
apps/backend        NestJS API（模块：auth users students batches imports grades rules
                    applications reviews calc publish exports files notify stats audit）
apps/frontend       React SPA（学生端移动优先 / 班委端 / 管理端桌面优先，一套代码按角色分流）
packages/shared     前后端共用常量（30 列导出模板、命名规范、枚举、Redis key）
docs/操作手册.md     管理员/班委/学生三份操作指引
```

## 本地快速启动（零外部依赖：SQLite + 进程内缓存）

```bash
pnpm install
pnpm --filter @zc/shared build      # shared 常量先构建（backend 引 dist）
pnpm db:local                       # 生成 sqlite schema 并建库 prisma/dev.db
pnpm db:seed                        # 超管/2026版规则15项/竞赛白名单129项/演示批次
pnpm --filter @zc/backend build
pnpm --filter @zc/backend start     # 默认 :3000，可 PORT=3210 覆盖
```

seed 后账号：超管 `admin / Admin@Zc2026`（首登强制改密）；学生账号=学号，初始密码=学号后 6 位（首登强制改密）。

前端本地联调（需先启动 backend）：

```bash
pnpm --filter @zc/frontend dev     # Vite :5173，/api 自动代理到 127.0.0.1:3210（VITE_PROXY_TARGET 可覆盖）
pnpm --filter @zc/frontend build   # tsc --noEmit + vite build（产物含 react/antd vendor 分包）
```

## 生产部署（Docker Compose）

```bash
cp .env.example .env   # 修改全部 ChangeMe 项（JWT/AES 密钥、MySQL 密码、CORS 域名）
docker compose up -d --build
```

- `mysql:8.0`（utf8mb4 + 每晚 mysqldump）、`redis:7-alpine`（AOF）、`backend`（非 root）、`frontend`（nginx 静态+/api 反代+SPA 回退；profile 隔离，`docker compose --profile frontend up -d` 启用，默认 `http://localhost:8080`）
- backend 镜像构建走 `build:image`（先 `prisma generate` 再 tsc），首次启动自动 `prisma migrate deploy`（见 Dockerfile/entrypoint）
- uploads 卷持久化所有上传与导出产物
- 套阿里云全站加速（DCDN）：真实 IP 透传/回源 token 校验/index.html 防白屏已内置，见 `docs/阿里云CDN部署.md`

## 学期全流程（10 分钟走完）

管理员：建批次 → 导入学生（xlsx 列名自动映射+人工确认）→ 导入成绩（多学期 xls 自动过滤本学期）→ 异常面板裁决（补考多行/缺考/缓考/休学）→ 开放收集 → 班委初审 → 复审核定分值 → 清空待裁决异常 → dryRun 试算 → 正式计算 → 发布公示 → 处理异议（更正→重算→增量发布）→ 分班/全年级导出 → 归档。

详细步骤与界面指引见 `docs/操作手册.md`。

## 验证与质量

```bash
# 单元+golden+安全用例（36 个）：引擎口径、模板逐列回算、zip 沙箱恶意样本
pnpm test

# 真实数据全流程 E2E（60+ 断言）：需先 pnpm db:local && pnpm db:seed 并启动服务
# （规则文件目录默认 D:/【学校工作】/综测相关规则，可用 ZC_RULES_DIR 覆盖；默认端口 3210）
node apps/backend/scripts/e2e-full.mjs

# 查分压测（发布后）：150 用户 × 8 轮并发查分
node apps/backend/scripts/bench-score.mjs
```

最近一轮结果（2026-09-10）：

- jest **36/36 绿**（engine 15 + golden-from-files 8 + zip-sandbox 13）
- E2E **全部通过**：1035 学生导入 → 12637 成绩（437 异常落队列）→ 申请/打包/两级审核 → 计算 1026 人 **golden 对照 P 列 30/30** → 发布 → 查分缓存命中 → 异议 → 增量发布 1 人 → 分班导出 30 列/全年级 29 班 → 审计 8 动作齐
- 压测 **2239 req/s，P95=71ms**，1200/1200 快照缓存命中，零错误

## 关键设计决策

- **规则即数据**：分值/上限/白名单全部入 `RuleItem` 字典，批次激活生成快照，改规则不发版
- **发布即物化**：发布事务内把每生结果写 Redis 快照（TTL=公示期+30 天），查分单次 O(1) GET；异议更正走「重算出 CANDIDATE 新版 → 增量发布晋升变更学生 → 精准重写快照」
- **导出不锁版本号**：发布态导出取每生最新 PUBLISHED 行（增量更正过的学生不会从导出中丢失）
- **人工裁决优先**：补考多行的人工 picked 结果在引擎装配层注入（组内其他行让位），先于「期末考试优先/最高分」自动规则
- **已知口径全部可配置**：BatchRule overrides 可调全科判定阈值、等级制折算、缺考是否等同不及格等
