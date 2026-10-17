# 技术栈升级评估（2026-10-17）

> **状态：仅评估，未执行任何升级。**
> 2026-10-17 用户裁决：**暂不动依赖，只落一份升级评估文档**（见 §8 裁决记录）。
>
> 本文「当前版本」均为本机实测（2026-10-17），「最新版本」为当天 npm / PyPI 查询结果；
> 复现命令见 §1。执行任何一批之前先重跑这些命令——版本会继续前进，本文数字会过期。
>
> 执行纪律：每批完成后必须在本文追加「执行记录」，并在
> `docs/PROBLEM_STATUS_2026-10-11.md` 交接摘要登记；代码/依赖变更按项目规则 1
> 同步文档、提交并推送 `main`。

---

## 0. 结论

有，而且分三类，不能混在一起做：

1. **已经到期的安全 / 生命周期债（建议优先）**：Next 14.2.35、Node 20（CI）、ESLint 8、
   TypeScript 5.9，落后当前稳定线两代。`pnpm audit` 实测 **80 条**
   （2 critical / 19 high / 48 moderate / 11 low）；2 个 critical 都是 Next
   image optimizer 的 RCE，修复只落在 Next ≥ 15.5.24。
   与 2026-10 文档里「Next 14→15 单独排期」是同一笔债。
2. **值得排期的代际升级**：Next 16 + React 19、Tailwind 4、zod 4、Vitest 5 / MSW 3、
   TypeScript 6.0、pnpm 12、orchestrator Python 3.14。
3. **不建议现在动**：TypeScript 7（lint 工具链不支持）、生产 Neon Postgres 大版本
   （托管侧迁移窗口）、lucide-react 1.x（图标重命名风险、收益低）。

> 线上暴露面的重要限定：生产是**静态导出 + `images.unoptimized`**，
> Next image optimizer 路由不对外提供，所以 2 个 critical 的**真实线上暴露面小于审计计数**。
> 但 14.x 已不在安全补丁线（critical 修复只发 15.5.24+ / 16），继续挂着会越拖越贵。

---

## 1. 测量口径（可复现）

- 基线：`main@2c19086`，工作树干净；本机 Windows（PowerShell 5.1）。
- 前端（npmmirror 源，元数据可查）：

  ```powershell
  pnpm outdated -r --format json
  ```

- 安全审计（**必须用官方 registry**）：

  ```powershell
  pnpm audit --registry https://registry.npmjs.org --json
  ```

  > ⚠️ npmmirror 镜像**没有 audit 端点**，直接 `pnpm audit` 会报
  > `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`。**不能把「命令报错」当成「没有漏洞」**（测量纪律）。

- 后端两个 venv：

  ```powershell
  uv pip list --outdated --python backend/orchestrator/.venv/Scripts/python.exe
  uv pip list --outdated --python backend/worker/.venv/Scripts/python.exe
  ```

- 最新版本对照：`pnpm view <pkg> version` / PyPI JSON API（`https://pypi.org/pypi/<pkg>/json`）。

---

## 2. 运行时快照

| 项 | 当前 | 判断 |
|---|---|---|
| Node（本机） | 24.11.1 | LTS，可用 |
| Node（CI） | 20（`deploy.yml` / `frontend-ci.yml` 的 `node-version: 20`） | **EOL 2026-04-30**，且 Vitest 5 / MSW 3 要求 ≥ 22.12 |
| pnpm（本机） | 10.33.0 | 与 CI 的 `latest`（当前 12.14.0）不一致 |
| pnpm（CI） | `corepack enable` + `pnpm/action-setup@v4 version: latest` = 12.14.0 | 生成 lockfile 的版本与本机不同 |
| Python（orchestrator Docker） | 3.11-slim | 落后；venv 本机是 3.12.13 |
| Python（worker） | 3.14.4（Cloudflare 自 2026-09-08 起默认 3.14 / Pyodide 314.0.6；`compatibility_date` 2026-09-18 已覆盖） | **已是最新，无需动** |
| uv | 0.11.8 | 可用 |
| wrangler | `node_modules` 4.136.1（文档记录全局 4.151.1） | 升到 4.151.1 即可对齐 |

---

## 3. 依赖矩阵

### 3.1 前端 / 工具链

| 依赖 | 当前 | 最新 | 建议 | 说明 |
|---|---|---|---|---|
| `next` | 14.2.35 | **16.4.2** | 批次 B（必做） | 跨两代；EOL + 2 critical |
| `react` / `react-dom` | 18.3.1 | **19.3.1** | 随 Next 16 | App Router 按 Next 16 要求走 19.2+ |
| `@types/react` / `@types/react-dom` | 18.3.28 / 18.3.7 | 19.3.0 | 随 React | |
| `eslint` | 8.57.1 | **10.13.0** | 随 Next 16 | `eslint-config-next@16.4+` 才支持 10；flat config |
| `eslint-config-next` | 14.2.35 | **16.4.2** | 随 Next 16 | `next lint` 在 16 已删除 |
| `@typescript-eslint/*` | 7.18.0 | **8.71.2** | 随 ESLint | peer 支持 ESLint 10 |
| `typescript` | 5.9.3 | 6.0.3（7.0.2 已发） | 批次 C → **6.0.3** | TS 7 暂无稳定编译 API，`typescript-eslint@8.71` peer 是 `<6.1.0` |
| `@sentry/nextjs` | 10.51.0 | **11.8.0** | 批次 B（可选） | 10 的 peer 也已声明支持 Next 16；Turbopack 构建出问题再升 11 |
| `tailwindcss` | 3.4.19 | **4.3.3** | 批次 C | 需重写颜色令牌；`@tailwindcss/postcss` |
| `tailwind-merge` | 2.6.1 | **3.7.0** | 随 Tailwind 4 | v3 对齐 TW4 类名 |
| `zod` | 3.25.76 | **4.6.7** | 批次 C | 全仓 197 处用法；`shared/contracts` 有 **41 处单参 `z.record()`** 必须改双参 |
| `vitest` / `@vitest/coverage-v8` | 4.1.11 / 4.1.5 | **5.0.5** | 批次 C | 要求 Node ≥22.12、Vite ≥6.4 |
| `msw` | 2.14.2 | **3.0.3** | 批次 C | 要求 Node ≥22.12；入口改为 `msw/http` 等 |
| `jsdom` | 29.1.1 | 30.1.3 | 随 Vitest | |
| `@playwright/test` | 1.59.1 | 1.64.1 | 批次 A | 小版本 |
| `@types/node` | 20.19.39 | **24.19.2** | 批次 A | 对齐 Node 24；26.x 对应 Node 26 |
| `wrangler` | 4.136.1 | 4.151.1 | 批次 A | 小版本 |
| `@commitlint/cli` / `config-conventional` | 20.5.3 | 21.2.3 | 批次 A | 大版本但纯工具 |
| `lint-staged` | 16.4.0 | 17.6.0 | 批次 A | 大版本但纯工具 |
| `lucide-react` | 0.400.0 | 1.59.0 | **暂缓** | 1.x 有图标重命名风险，收益仅为版本新 |
| `@base-ui/react` | 1.4.1 | 1.9.0 | 顺手 | 小版本 |
| `@radix-ui/react-slot` | 1.2.4 | 1.5.0 | 顺手 | 小版本 |
| `@hookform/resolvers` | 5.2.2 | 5.9.2 | 顺手 | 支持 zod 4 |
| `react-hook-form` | 7.75.0 | 7.90.0 | 顺手 | |
| `@tanstack/react-query` / `-devtools` | 5.100.8 | 5.104.3 | 顺手 | |
| `@tanstack/react-virtual` | 3.13.24 | 3.14.21 | 顺手 | |
| `postcss` / `autoprefixer` | 8.5.28 / 10.5.0 | 8.5.30 / 10.6.1 | 批次 A | 注意 Tailwind 4 会移除 autoprefixer |
| `sonner` / `idb` / `fake-indexeddb` / `tsx` | 2.0.7 / 8.0.3 / 6.2.5 / 4.21.0 | 2.0.8 / 8.0.4 / 6.2.6 / 4.23.15 | 批次 A | 补丁/小版本 |
| `shadcn`（CLI） | 未安装 / 声明 ^4.6 | 4.22.0 | 批次 A | 仅开发工具 |
| `axios` | 1.18.0 | 已最新 | — | |

### 3.2 orchestrator（参考实现 / 本地 / Docker）

| 依赖 | 当前 | 最新 | 说明 |
|---|---|---|---|
| `fastapi` | 0.136.1 | 0.143.3 | 小版本，会拖 Starlette 1.x |
| `starlette` | 0.52.1 | **1.8.0** | **大版本**；worker 已在 1.6.0，orchestrator 反而落后 |
| `sqlalchemy` | 2.0.49 | **2.1.5** | 2.1 移除一批 1.x 遗留 API，需跑 `-m db` 档 |
| `pydantic` / `pydantic-settings` | 2.13.3 / 2.14.0 | 2.14.1 / 2.16.0 | 低风险 |
| `alembic` | 1.18.4 | 1.20.0 | 低风险 |
| `asyncpg` | 0.31.0 | 0.32.0 | 低风险 |
| `cryptography` | 47.0.0 | 50.0.2 | 大版本（经 `pyjwt[crypto]` 引入） |
| `opentelemetry-*` | 1.41.1 | 1.45.1 | 低风险 |
| `prometheus-fastapi-instrumentator` | 7.1.0 | 8.1.0 | 大版本，需验 `/metrics` |
| `structlog` | 25.5.0 | 26.1.0 | 大版本，低风险 |
| `Pillow` | 12.3.0 | 13.0.0 | 大版本，用到图片再验 |
| `protobuf` | 6.33.6 | 7.36.2 | 传递依赖，随 OTel |
| `pytest` / `pytest-asyncio` | 9.0.3 / 1.3.0 | 9.1.1 / 1.4.0 | 低风险 |
| `pyjwt` | 2.12.1 | 2.15.1 | 低风险 |
| `python-multipart` | 0.0.27 | 0.0.32 | 低风险 |
| `psycopg2-binary` | 2.9.12 | 2.9.13 | 补丁 |
| `slowapi` / `apscheduler` / `cachetools` | 0.1.9 / 3.11.2 / 7.1.0 | 0.1.10 / 3.11.3 / 7.2.3 | 补丁/小版本 |
| Python | Docker 3.11 / venv 3.12 | 3.14.4 | 需重锁 `uv.lock` 并验 wheel |

### 3.3 worker（生产，Cloudflare Python Workers）

| 依赖 | 当前 | 最新 | 说明 |
|---|---|---|---|
| `fastapi` | 0.141.1 | 0.143.3 | 低风险 |
| `starlette` | 1.6.0 | 1.8.0 | 低风险 |
| `pydantic` | 2.13.5 | 2.14.1 | 低风险 |
| `asyncpg` | 0.31.0 | 0.32.0 | 低风险 |
| `pyjwt` | 2.14.0 | 2.15.1 | 低风险 |
| `python-multipart` | 0.0.32 | 已最新 | — |
| `bcrypt` | 5.0.0 | 已最新 | — |
| `workers-py` | 1.17.3 | 1.17.8 | 补丁 |
| `workers-runtime-sdk` | 1.8.6 | 1.9.4 | 小版本 |
| Python 运行时 | 3.14（Pyodide 314.0.6） | 3.14 | **已最新** |

> worker 是**生产唯一入口**，升级后必须复测包体大小与冷启动时间
> （Cloudflare 对启动 CPU 有限额，超限会造成间歇性 500，见 `DEPLOY.md` §0.2）。

### 3.4 基础设施 / 配置

| 项 | 当前 | 建议 | 说明 |
|---|---|---|---|
| docker-compose PostgreSQL | `postgres:16-alpine` | 本地可升 18，**生产不动** | 生产是 Neon 托管，大版本要迁移窗口 |
| docker-compose Redis | `redis:7-alpine` | **删除**（见 3.5） | 代码里没有 redis 客户端 |
| docker-compose MinIO | `minio/minio:latest` | 钉日期 tag | `latest` 不可复现 |
| CI Node | 20 | **24 LTS** | 批次 A，同时解锁 Vitest 5 / MSW 3 |
| pnpm | 本机 10.33 / CI latest | 钉 `packageManager: pnpm@12.14.0` | 批次 A |
| 陈旧 lockfile | `frontend/pnpm-lock.yaml`、`frontend/package-lock.json`（2026-09-26，根锁 2026-10-12） | 删除 | 双锁会让 CI 缓存键与实际安装不一致 |
| GitHub Actions | `checkout@v4` / `setup-node@v4` / `upload-artifact@v4` / `setup-uv@v5` | 升当前大版本 | 批次 A，顺手 |

### 3.5 零引用依赖（可直接删，减少升级面）

| 依赖 | 证据 | 处理 |
|---|---|---|
| `passlib[bcrypt]` | 全仓 `.py` 0 引用；worker 直接用 `bcrypt` | 删（passlib + bcrypt 5 本身也有兼容坑） |
| `langfuse` | 全仓 0 引用 | 删（还少一个 4→5 大版本） |
| `oss2` | 全仓 0 引用（S3 走 `kaas_common.files.s3` 自算 SigV4） | 删 |
| `redis_url` 配置 + compose `redis` 服务 | 只有 settings 字段，没有任何客户端/调用 | 删配置与服务（或真正接线，二选一） |

---

## 4. 安全审计要点（2026-10-17，npmjs registry）

- 总数 **80**：2 critical / 19 high / 48 moderate / 11 low。
- 2 个 critical：`next` 的 image optimizer RCE（`<15.5.24`）。
- 19 个 high 里大部分仍是 `next`（SSRF / Server Actions DoS 等），其余为
  `postcss` / `sharp` / `undici` / `fast-uri` / `braces` / `ip-address` /
  `@modelcontextprotocol/sdk`（经 shadcn CLI）。
- **现有 overrides 恰好钉在漏洞版本上**（`pnpm-workspace.yaml`）：
  - `fast-uri@3.x`: 3.1.6 —— 修复版 3.1.7；
  - `undici@7.x`: 7.29.0 —— 修复版 7.29.1（7.30.1 已存在）；
  - `sharp`：需 ≥ 0.35.5（当前由 Next 的 optional dep 带入）。
- Next 14 升级到 16 后应**复扫并重设 overrides**，不要把旧钉版带到新依赖树上。

---

## 5. 批次路线（推荐顺序，不要一把梭）

> 估算按单人；每批独立提交、独立回滚。

### 批次 A：零风险收口（P0，约 0.5–1 天）

- CI Node 20 → **24**（`deploy.yml`、`frontend-ci.yml`）；`@types/node` → 24.19.2。
- pnpm 统一：加 `packageManager: "pnpm@12.14.0"`，本机升 12，删两份陈旧 lockfile，
  CI 改用 `corepack` 的 `packageManager`（不再 `version: latest`）。
- overrides：`fast-uri` → 3.1.7、`undici` → 7.30.1、补 `sharp` → 0.35.5；再跑 audit。
- 删除 3.5 的零引用依赖；`datetime.utcnow()` → `datetime.now(UTC)`（4 处）。
- 补丁/小版本：playwright、wrangler、postcss、autoprefixer、tsx、sonner、idb、
  fake-indexeddb、react-query、react-hook-form、base-ui、radix-slot、
  commitlint、lint-staged、shadcn。
- 门禁：`lint` / `typecheck` / `test` / `contracts:check` / `NEXT_EXPORT=1 build` /
  orchestrator `pytest -m unit` / worker `pytest` / `sync-shared -Check`。

### 批次 B：Next 16 + React 19 + ESLint 10（P1，2–4 天）

- `next@16.4.2`、`react@19.3.1`、`react-dom@19.3.1`、`@types/react(-dom)@19.3.0`。
- ESLint 8 → **10.13** + `eslint-config-next@16.4.2` + `@typescript-eslint@8.71`；
  `.eslintrc.json` → `eslint.config.mjs`（flat），`"lint": "next lint"` → `eslint .`；
  CI 的 `pnpm lint` 保持（Next 16 的 `next build` 不再 lint）。
- `next.config.mjs`：`experimental.typedRoutes` → 顶层 `typedRoutes: true`；
  `middleware.ts` → `proxy.ts` 或删除（见 §6-2）。
- 验证 Turbopack 默认构建与 Sentry 插件是否兼容（见 §6-1），必要时 `next build --webpack`。
- 门禁：`NEXT_EXPORT=1 build` + 全量 e2e + 生产冒烟 + 灰度（`wrangler versions deploy`
  分比例）后再 100%。
- 预期收益：清掉 2 critical 与绝大多数 high；14.x EOL 债清零。

### 批次 C：Tailwind 4 / zod 4 / TS 6 / Vitest 5（P2，2–3 天）

- Tailwind 3.4 → **4.3.3** + `tailwind-merge@3.7`：`@import "tailwindcss"`、
  `@tailwindcss/postcss`、移除 autoprefixer，`tailwind.config.ts` 的 oklch 令牌迁到
  `@theme`；**必须做视觉回归**（e2e 目前是功能断言，不覆盖像素）。
- zod 3.25 → **4.6.7**：建议先在 3.25 下改 `zod/v4` 子路径跑绿，再翻主版本；
  41 处 `z.record(x)` → `z.record(z.string(), x)`；`.errors` 已删（仓库无 ZodError.errors，
  影响小）；`.default()` 语义变化需过契约测试。
- `typescript@6.0.3`（不是 7.0.2），`tsconfig` target 可顺带 ES2017 → ES2022。
- Vitest 4 → **5.0.5** + MSW 3.0.3 + jsdom 30：`clearMocks` 默认变 true；MSW 改
  `msw/http` 入口、`onUnhandledRequest` → `onUnhandledFrame`。
- 门禁：vitest 全量、e2e 全量、`contracts:check`、`NEXT_EXPORT=1 build`。

### 批次 D：后端与基础设施（P3，1–2 天）

- orchestrator：Docker Python 3.11 → **3.14**（或先 3.13），`requires-python` 收紧，
  重锁 `uv.lock`；FastAPI 0.143 + Starlette 1.8 + SQLAlchemy 2.1 + 其余小版本；
  跑 `pytest -m unit` 与 `-m db`（需本地 PG）。
- worker：依赖小版本（§3.3）+ 复测包体/冷启动/冒烟；`compatibility_date` 可顺带推进。
- compose：PG 16 → 18（仅本地）、钉 MinIO tag、删 Redis。

### 每批统一门禁

orchestrator `pytest -m unit`、worker `pytest`、前端 `typecheck` / `lint` / `test`、
`contracts:check`、`python scripts/route-parity.py`、`sync-shared.ps1 -Check`、
`NEXT_EXPORT=1 pnpm build`；涉及模型/路由时按 `contracts:check` 的「先提交产物再跑」顺序。

---

## 6. 风险与坑（按踩坑概率排序）

1. **Next 16 默认 Turbopack + Sentry 插件**：`withSentryConfig` 会注入 webpack 配置，
   Next 16 遇到自定义 webpack 配置会直接失败。先验证 Sentry 11 的 Turbopack 支持，
   不行就 `next build --webpack` 回退（并为后续升级留 todo）。
2. **静态导出不支持 proxy / middleware / rewrites**（官方 static-exports 文档明确列出）。
   仓库里 `frontend/src/middleware.ts` 只在 `next dev` / e2e 服务模式下有意义，
   生产静态站点靠客户端守卫。升级时要**明确决策**：删除（推荐）或迁 `proxy.ts` 仅保 dev。
3. **Tailwind 4 颜色令牌**：现有 `oklch(var(--x) / <alpha-value>)` 的 `<alpha-value>` 插槽在
   v4 不再适用，需改 `@theme inline` + `color-mix`；这是全站视觉风险最高的一步。
4. **zod 4 的 41 处单参 `z.record()`**：v4 直接移除单参用法（编译/运行都会挂），
   必须逐个改双参；`ZodSchema` 仍导出但已 deprecated，`safe-query.ts` 建议改 `z.ZodType`。
5. **TypeScript 7 暂不可用**：`typescript-eslint@8.71` peer 上限 `<6.1.0`；
   Next 16 自身可用 TS 7 的 `tsc`，但 lint 会断。**锁 6.0.3**，等 typescript-eslint 跟进。
6. **Node 版本是前置条件**：Vitest 5 / MSW 3 都要求 ≥22.12，必须先做批次 A 的 Node 24；
   否则装完直接跑不起来。
7. **Python 3.14**：`datetime.utcnow()` 弃用（已有 4 处）、部分二进制依赖要 wheel、
   SQLAlchemy 2.1 移除旧 API；orchestrator 不对外，风险主要在测试环境。
8. **pnpm 12 vs 本机 10.33**：lockfile 由不同大版本生成/消费，`--frozen-lockfile` 可能因
   格式或 peer 解析差异假红；先统一再升级依赖，避免把包管理器问题误判成依赖问题。
9. **Next 16 已把 `next dev` 与 `next build` 产物目录分开**：现有 `NEXT_DIST_DIR`
   并发 hack（见 `next.config.mjs` 注释）可以简化/删除，别再为旧问题加绕行。
10. **部署窗口**：每次 Worker 部署都会重置 isolate、经历数分钟冷启动窗口
    （`DEPLOY.md` §0.2）；Next 升级要选低峰、用 `wrangler versions deploy` 灰度，
    并提前准备回滚版本 ID。
11. **lint 位置**：`lint-staged` 在仓库根跑 `eslint --fix`，flat config 落地时要保证
    根目录能找到配置（或在 lint-staged 里 `pnpm --filter kaas-frontend exec eslint`）。

---

## 7. 明确不建议现在做

| 项 | 原因 |
|---|---|
| TypeScript 7.0.2 | typescript-eslint 尚不支持（peer `<6.1.0`）；收益是速度，代价是 lint 断链 |
| 生产 Neon Postgres 大版本 | 托管侧迁移窗口，不是代码升级；本地 compose 升 18 即可 |
| lucide-react 1.x | 图标重命名/删除风险，纯视觉收益，等有需求再动 |
| 先升 Next 15 再升 16 | 多一次大版本迁移与回归，直接用官方 codemod 跳 16 |
| 把 B/C/D 合成一批 | 回归无法定位、回滚粒度太粗；本项目历史上已因「升级完没全量验证」踩过坑 |

---

## 8. 裁决记录

| 日期 | 决策人 | 内容 | 依据 |
|---|---|---|---|
| 2026-10-17 | 用户（David） | **暂不执行升级，只落评估文档**（本文） | 用户在弹窗中选择「暂不动，只落一份升级评估文档」 |
| 2026-10-17 | 用户（历史） | Next 14→15/16 属「单独排期」 | `docs/PROBLEM_STATUS_2026-10-11.md` 原记录；本文将其细化为 A/B/C/D 批次 |

**提前启动条件**：线上出现 Next 14 相关安全公告、或新依赖强制要求 Next 16 时，
直接启动批次 B（可先做批次 A）。启动前需再次确认维护窗口与灰度比例。

---

## 9. 参考

- Next.js 16 升级指南：<https://nextjs.org/docs/app/guides/upgrading/version-16>
- Next.js 静态导出（明确列出 proxy/middleware/rewrites 不支持）：
  <https://nextjs.org/docs/app/guides/static-exports>
- Tailwind CSS v4 升级指南：<https://tailwindcss.com/docs/upgrade-guide>
- Zod v4 迁移指南：<https://zod.dev/v4/changelog>
- Vitest 5 迁移指南：<https://vitest.dev/guide/migration/>
- MSW 2.x → 3.x：<https://mswjs.io/docs/migrations/2.x-to-3.x>
- TypeScript 7.0 RC（无稳定编译 API，7.1 才有）：
  <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/>
- Cloudflare Python Workers Python 3.14（Pyodide 314.0.6，兼容日期 ≥ 2026-09-08）：
  <https://developers.cloudflare.com/changelog/post/2026-09-08-python-workers-314/>
