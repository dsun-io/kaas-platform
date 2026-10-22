# KaaS 平台 · 项目规则（每次会话自动生效）

> 这些是**用户明确下达的全局规则**。放在仓库根而不是只留在对话里，
> 是为了让**每一次新会话自动遵守**，不依赖"上次那位记得"。

## 0. 密钥铁律（用户全局规则，2026-10-21）

**用户原话**：

> 全局rules: DSH-Admin 仅供DSH ai使用, 不能用作其他用途, 保持全局环境变量

**具体含义（强制）**：

- **凡命名 `DSH-Admin` 的密钥**（Cloudflare API token、Neon API key、Resend API key、GitHub PAT，以及由其派生的 R2 S3 凭据）**仅供 DSH AI 使用**：
  - **禁止**配置到平台 / Worker / CI / GitHub Actions secrets / 其他单位或项目；
  - 必须保持为**用户级全局环境变量**：`CLOUDFLARE_API_TOKEN`、`NEON_API_KEY`、`RESEND_API_KEY`、`GITHUB_TOKEN`、`GH_TOKEN`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`；
  - 值只存 `~/.dsh/secrets/`（`inventory.md` 记录归属与命名），**不入仓、不打印、不外传**。
- **系统一律用独立命名**的 `kaas-*` token（如 `kaas-r2-system-*`、`kaas-ci-system-*`、`kaas-prod-system-*`）：
  **一个密钥只用于一个地方**，命名必须能看出归属（DSH-Admin=DSH 专用；`kaas-*-system`=平台系统）。
- **破坏性密钥操作**（吊销 / 轮换 / 删除 / 改权限）执行前**必须向用户确认**；只读审计可直接做。
- **写 Worker secret 的铁律（2026-10-21 实测）**：**不要**用 PowerShell 管道 `Get-Content x | wrangler secret put`——`|` 会给值尾部追加换行，导致 Resend/S3 等 401 且**静默失败**。正确做法：`Set-Content` 写值文件后用 **Cloudflare API** 精确写入（`PUT /accounts/{id}/workers/scripts/{name}/secrets`，body `{name,type:"secret_text",text}`），或 `printf %s` 管道（bash/CI）。写入后必须用真实链路验证（如 Resend 发信记录、R2 presign 回环）。

## 1. 项目更新 = 代码 + 文档 + 推送（缺一不可）

**用户原话（2026-10-11）**：

> 项目更新一定要更新相关文档以及将最新代码提交到远程

具体含义：

- **改代码必须同步更新相关文档**。当前口径文档是
  `docs/PROBLEM_STATUS_2026-10-11.md`；**每完成一项就更新它**，
  并在其顶部「交接摘要」里同步进度。
  - **交接/检索入口统一为 `docs/README.md`**（当前权威 / 运行手册 / 归档分层）；
    主交接文档是根 `README.md`，历史文档在 `docs/archive/`，不要用归档判断当前口径。
  - 文档里过时的状态**必须改掉**。宁可标注"未做"，也不能让文档写着旧状态
    ——后来者会按它判断。本项目已多次出现"代码做了、文档还标着 ❌"。
- **必须提交并推送到远程**（`main`）。本地有未推提交时，**先补推再收尾**。
  推送偶发 `Connection was reset` / `Failed to connect`，**要重试**。

## 2. 需要用户确认的，必须弹窗

**用户原话（2026-10-11）**：

> 全局rules：需要我确认的必须弹窗

- 用 `ask_user_question` 提出，**不要用纯文本问**。
- 一次把相关选项给全（含推荐项与代价），不要挤牙膏式地反复问。

## 3. 不确定的不要擅自动手

**用户原话（2026-10-11）**：

> 不确定的不要擅自动手

- 涉及**授权策略、数据删除、生产环境、跨大版本升级**等，先取证再定，
  需要用户拍板的走规则 2。
- 但要**区分两类不确定**：
  - **策略不确定**（谁能发起、粒度选哪层）→ 弹窗问；
  - **事实不确定**（这段代码还有人用吗、表里有没有数据）→ **自己去查证**，
    不要把"我没查"包装成"需要你定"。本项目在这方面已栽过：曾把
    「我没搭起来测试环境」写成「这段代码根本测不了」，也差点把
    「有活页面的区域」当成死代码清掉。

## 其它需要知道的口径

- **租户 ≠ 团队**：`tenant_id` 恒为 `"default"`，**团队（`team_id`）才是隔离边界**。
- **两层架构（ADR-008，2026-10-21 拍板）**：TS Worker(Hono)=对外门面（UI 路由/鉴权/MCP/REST 网关），
  Python Worker=内核（kaas_common 报价/单证引擎、未来 AI/数据能力、cron 3 条），经 Service Binding 互调。
  **铁纪律：业务规则只在 Python 内核一处实现；TS 门面只做鉴权/参数校验/协议转换，禁止写业务逻辑；**
  TS 侧 zod schema 从 Python pydantic 模型代码生成，禁止手抄；跨层契约变更必须同 PR + 金标 harness 全绿
  （backend/ts-migration/golden/）。优化全计划与进度唯一权威 = `docs/OPTIMIZATION_PLAN_2026-10-21.md`。
- **双 Worker 发布纪律（2026-10-22 落盘，硬约束）**：生产自定义域名**只归 `kaas-edge`**；内核
  `backend/worker/wrangler.jsonc` 的 `routes` 必须为 `[]`（新增域名/回填会被
  `scripts/check-deploy-domains.py` 的静态断言和 `--live` 线上归属断言拦下，CI 与 deploy 前置都跑）。
  发布唯一入口 = `.github/workflows/deploy.yml`：
  · **自动触发（2026-10-22 用户下令恢复）**：push 到 `main`（`docs/**`、`archive/**`、`**/*.md` 除外）即触发；
    `wait-for-ci` 先等同 SHA 的 CI（backend:test / contracts:check / Frontend CI / ts-edge）全绿，任一失败则不 build/migrate/deploy；
    之后 `build-frontend` → `migrate` → `deploy-kernel` → `deploy-edge`，`needs` 保证先内核后门面、内核失败不更新门面。
  · `workflow_dispatch` 保留排障与单端发布（`target=both|kernel|edge`，仍需输入 `confirm=deploy`）；
    edge-only 不跑 migrate/内核。手工部署仅排障且必须内核→门面。
- **共享内核**：共享逻辑全部放 `backend/kaas_common/`（**S4 起含报价引擎 `export_quote/` 与
  `domain/enums.py`；orchestrator 不再是任何真源**）。改完必须跑
  `powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1`，否则 worker 端是旧的。
- **技术栈基线（2026-10-20 升级后，勿回退）**：Next **16.4.2** / React **19.3** /
  ESLint **10.13（flat config：`frontend/eslint.config.mjs`，`next lint` 已删除）** /
  TypeScript **6.0.3**；CI Node **22**。`pnpm audit` 目标：0 critical。
- **UI 设计规范**：[docs/UI_STANDARDS.md](docs/UI_STANDARDS.md) 是硬性约束；新增页面/组件也必须遵守。
  本地必须跑 `pnpm ui:standards` + `pnpm ui:contrast`；`pnpm e2e` 的 a11y 用例会**自动发现新增路由**。
- **门禁**（改完都要跑；**2026-10-21 收口实测口径**，工作区静止时数字才作数）：
  - orchestrator（仅迁移/模型/内核测试，**247** 条）：
    `cd backend/orchestrator; uv run --extra migrations pytest tests -q`
  - TS 门面（对外唯一入口，切流后新增）：`cd backend/ts-worker; pnpm typecheck; pnpm test`（**208 测 / 22 文件**）；
    路由面机检 `tests/route-surface.test.ts`（249 = 163 直接 + 86 透传，0 缺失 0 多余）；
  - worker（Python 内核，**1565 passed + 12 skipped**；12 条 db/integration 档按约定 skip，有 docker PG 时这 12 条会真跑、总数 1572）：`cd backend/worker; uv run --frozen --with pytest --with httpx2 python -m pytest tests -q`
  - 前端：`cd frontend; pnpm typecheck`（内含 `next typegen && tsc --noEmit`）`; pnpm lint; pnpm test`（**934 passed / 110 files**）`; pnpm contracts:check; pnpm mocks:check; pnpm ui:standards; pnpm ui:contrast; pnpm e2e`（**27 条 = 27 passed + 0 skipped**；a11y 路由自动发现）
  - 静态断言：`scripts/check-runtime-deps.py`、`scripts/check-schema-coverage.py`、
    `scripts/check-schema-drift.py`、`scripts/check-worker-bundle.py`、`scripts/check-deploy-domains.py`、
    `scripts/sync-shared.ps1 -Check`
  - 构建：`cd frontend; $env:NEXT_EXPORT="1"; pnpm build` → **`frontend/out`**（门面 assets 伺服）
    —— **构建后必须 `pnpm assets:check` 通过**（Linux 产物校验，见上一条硬约束）
  - **静态导出产物口径（2026-10-22 实测，硬约束）**：**禁止用 Windows 本机构建的 `out/` 直接 deploy** ——
    `path.relative()` 返回反斜杠、而 Next 只把 `/` 换成 `.`，逐段预取文件会被写成目录（`__next.X\Y.txt`），
    客户端请求点号名 ⇒ **全站预取 404**。正解：CI（ubuntu）或 Docker `node:22` 容器内构建；发版前必须跑
    `cd frontend; pnpm assets:check`（校验：无含 `\` 的文件名、无 `__next.*` 目录、`/_next/static/*` 引用全部可解析）。
    另：**侧边栏等 `Link` 不要显式 `prefetch={true}`** —— 静态导出下点击导航会永久挂死（`linkClicked` 先 preventDefault、
    随后等 prefetch 永不 resolve）；根因与取证见 `docs/HANDOVER_2026-10-21_NAV_STUCK.md`。
  - **导出态 e2e（2026-10-22 新增，nightly）**：`cd frontend; pnpm e2e:export`（构建导出产物 → 起静态服务 →
    跑 `e2e-export/*.spec.ts`：真实点侧边栏跳转 + RSC 200 + 无逐段 404 + 路由直达）。**dev 态 `pnpm e2e` 抓不到导出态缺陷**
    （2026-10-22 两个线上事故都在这个盲区）；CI 里是 `frontend-ci.yml` 的 `e2e-export` job，只在 schedule/手动跑。
  - **部署（2026-10-21 起两个 Worker）**：`kaas-edge`（TS 门面，对外域名）+ `kaas`（Python 内核，无公网域名）；
    发布唯一入口 = GitHub Actions `deploy`（`target=both|kernel|edge`，先内核后门面，见上条纪律）；
    本机手工部署仅排障（两者都必须带 `$env:CLOUDFLARE_API_TOKEN`，wrangler OAuth 已过期）；先内核后门面；
    详见 `docs/HANDOVER_2026-10-21_CUTOVER.md` §2
    （Next 16 下**不要**设 `NEXT_DIST_DIR`：静态导出会落到该目录，导致 `out/` 缺产物）
  - **已退役**（不要再跑/不要新增引用）：`route-parity.py`、`export_openapi.py`、contracts `R6`
    —— 归档在 `scripts/archive/`，说明见 `scripts/archive/README.md`。

### ⚠️ 契约检查口径（S4 后变了）

- `contracts:check` 保留（R0–R5），但**契约源已迁移**：
  R0 → `backend/kaas_common/domain/schema_registry.py`；R1/R5 → `backend/contracts_frozen/*.py`（冻结快照）；
  R2 → `backend/kaas_common/domain/workstations.py`；R3 → `backend/kaas_common/domain/enums.py` +
  `backend/kaas_common/workstation/number_rules.py`；R4 → `backend/worker/src/**`。
- `R6 openapi.json 新鲜度已退役`：单应用后没有第二后端源码可做基准；artifact
  `backend/orchestrator/docs/openapi.json` **冻结**，不再需要“重生成产物 → 提交 → 再跑”。
  改 worker 路由不会再让 contracts:check 变红；前端契约靠 R1–R5 + `pnpm test` 兜。
- **本机工具链（2026-10-19 实机核对；换设备需重核）**：
  - DSH runtime：`C:\Users\76516\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
    + `...\dependencies\pnpm\bin\pnpm.cjs`（注意是 `dependencies\pnpm\bin\pnpm.cjs`，不是 `node\pnpm\…`）。
  - 本机 PATH 上已有 `D:\Node.js\node.exe` 与 pnpm（`C:\Users\76516\AppData\Roaming\npm\pnpm.ps1`），
    一般可直接用 `pnpm` / `node`。
  - ⚠️ **本机没有 PowerShell 7**（`pwsh` 不在 PATH，只有 5.1）⇒ 所有 `pwsh scripts/…` 改用
    `powershell -ExecutionPolicy Bypass -File scripts/…`。
  - ⚠️ **PATH 上的 `python` 是 WindowsApps 占位符**（执行无输出、退出 1）⇒ 需要 Python 的命令
    （`scripts/check-*.py` 等）一律用 `backend/orchestrator/.venv/Scripts/python.exe`；
    orchestrator 测试用 `uv run --extra migrations …`，worker 测试用 `uv run …`。
  - ⚠️ 用户名会变：本机是 `76516`；历史文档写过 `HJ` / `河北慷逊公司`，按旧路径调用会
    `CommandNotFoundException`。以 `$env:USERPROFILE` 为准。
  - git hook：`.husky/pre-commit` 调 `pnpm lint-staged`（实测本机可直接解析）。若换设备报
    `pnpm: command not found`，加一个无 BOM 文本 shim（内容 `exec "<node.exe>" "<pnpm.cjs>" "$@"`）
    放进 PATH，Windows 路径写进 shim 内部最稳。
  - ⚠️ **commitlint 的 `subject-case` 规则**禁止句首/帕斯卡大小写 ⇒ subject 用中文或**全小写**才过。
  - ⚠️ **uv 的 pyodide 探针在 CJK 用户名路径下会坏**（2026-10-20 实证）：设
    `$env:UV_CACHE_DIR='D:\tools\uv-cache'`（纯 ASCII 路径）即修复；`pywrangler sync/deploy`
    还须 `$env:PYTHONUTF8='1'`（否则读含中文注释的 `wrangler.jsonc` 报 GBK 解码错）。
  - ⚠️ **worker 依赖版本由 `backend/worker/pylock.toml` 锁定（已入库）**：pywrangler 检测到
    锁文件即以其为约束；**禁止删该文件**，升级依赖走显式 `pywrangler sync` + diff 审查提交。

## 4. 这个工作区可能**同时有多个任务在写** —— 提交纪律

2026-10-11 实测：同一工作区里**多条线并行**（不同的 DSH 会话 / 队友），
`git status` 里随时有**别人的未提交改动**。

- **`git commit -- <pathspec>` 不足以保证"没提交别人的东西"** ✗
  它记录的是**工作树内容**，不是 index ⇒ **同一个文件里别人的未提交 hunk 会被一起提交**。
  （实测：`backend/worker/src/main.py` 里两拨人的 hunk 混在一起，且别人的 hunk 依赖一个
  **未跟踪**文件 ⇒ 那提交必然 ImportError / CI 红。）
  ⇒ 改用**私有 `GIT_INDEX_FILE`**（指向 `%TEMP%`）只装自己的 hunk，**不碰共享 index、不碰他人工作树**。
- **提交前自检**：`git diff --cached --stat` 只应出现自己的文件；
  `git diff --cached -- <file>` 只应含自己的 hunk。
- **提交后自检**：`git status --short` 里**别人的改动必须原样还在**。
- **部分 hunk 提交要先转 LF**：本仓库工作树是 **CRLF**、index blob 是 **LF**
  ⇒ `git diff` 出的补丁含 CR ⇒ 对 LF 的 index blob 直接 `patch does not apply`
  （实测 130 个 CR）⇒ 转 LF-only 后 `git apply --cached --check` 通过。
- **不要拿别人的文件做自证**（例如为了演示门禁能抓到而临时改错一个键）：
  **一律只在自己的写入范围内做**；确实需要跨范围，**先问**。
  实测发生过一次"险过"——临时改的文件正被别人并发编辑。
- **不要用 `git add -A` / `git add .` / 裸 `git commit`**。本项目已因此**断过一次 HEAD**。

#### 用私有 `GIT_INDEX_FILE` 提交后，**必须**把自己涉及的路径在共享 index 里归位

**实测（2026-10-12，两拨人都踩到）**：用私有 index 提交后，**共享 `.git/index` 仍停在旧 HEAD 上** ✗
⇒ 你这次**新增的文件**在别人眼里会立刻变成 **`D ` staged 删除 + `??` 未跟踪**
（下一次**裸提交/按 index 提交会把它们删掉** ✗）。

**收尾动作（只动自己的路径，别碰别人的）**：
```bash
git reset -q HEAD -- <你这次提交涉及的路径…>      # 或等价地 git add -- <同样这些路径>
```
之后：你自己的路径恢复干净，**别人的 staged/worktree 改动逐条原样保留** ✓（用前/后 `git status --short` 对比自证）。

> 同一轮里另有两位队友独立踩到这条并各自发现，故写入配方。

⚠️ **补丁（2026-10-12 下午场实测，又踩一次）**：上面这条 `git reset -q HEAD -- <路径>` **在
`GIT_INDEX_FILE` 环境变量还指向私有临时索引时是无效的** —— 它归位的是**私有索引**，共享
`.git/index` **照旧停在旧 HEAD**，症状完全一样（`D ` + `??`）。
**提交脚本里必须先把私有索引用完再清掉变量，两个动作分开**：

```bash
# ① 私有索引提交（GIT_INDEX_FILE 指向 %TEMP%）
git read-tree HEAD && git add -- <自家路径…> && git commit -m "…"
# ② 清掉变量后再归位共享索引（关键：不能和 ① 写在同一条 shell 里紧接着跑）
Remove-Item Env:GIT_INDEX_FILE          # PowerShell；bash 用 unset GIT_INDEX_FILE
git add -- <自家路径…>                   # 用 add 最稳：让共享 index 与工作树/HEAD 一致
git status --short                       # 自证：自家路径干净，别人的改动原样在
```
判据：`git diff HEAD -- <自家路径>` **为空** 且 `git status --short -- <自家路径>` **无输出**，才算真归位。

### `frontend/.next` 是硬冲突资源

并发 `next build` / `NEXT_EXPORT=1 pnpm build` 会**覆盖 `frontend/.next`**，而 e2e 的
`next dev` 也读写同一目录 ⇒ 客户端分块变 500（`Cannot find module './xxxx.js'`）⇒
**不 hydration ⇒ MSW 不运行 ⇒ 零请求 ⇒ 页面全白** ⇒ **e2e 那一轮数字全部作废**（不是产品信号）。

- **构建/导出 与 e2e 不能同时跑**；跑 e2e 前的分块探针（2026-10-20 更正）：Next 16 dev 走
  Turbopack，**不再有** `/_next/static/chunks/main-app.js`（恒 404，旧探针是 Next 14 webpack 时代写法）。
  等效口径：请求 `/login` 触发编译后，**把页面引用的全部 `/_next/*.js` chunk 逐一探测 200**（2026-10-20
  实测 25/25），或直接依赖 playwright webServer 的就绪探测；不满足 ⇒ hydration 前提不成立，e2e 数字作废。
- **构建门的数字只在工作区静止时作数**（`NEXT_DIST_DIR` 只隔离产物目录，**不隔离源码并发写**）。

## 5. 测量纪律（本项目已因此错过多次）

- **宣布任何"通过 / 失败 / 归零"之前，必须先打印完整、不过滤的摘要**，
  并核对 `passed + failed + skipped == playwright test --list 的总数`。
  **数字对不上就是证据不足，不是"没问题"。**（曾用过滤视图得出过假的"0 failed"，
  并用整轮撤回。）
- **"没匹配上" ≠ "没有"**：grep **0 命中**可能只是**命令没跑在预期对象上**；
  `[绕过MSW]` 这类探针在请求 **abort 时不会打日志** ⇒ "日志里没有" 不等于 "被拦住了"。
  下结论前要用**阳性对照**或打印 cwd 确认工具确实作用在预期对象上。
- **不要用关键字 grep 当"某文案 / 控件不存在"的证据** —— 要**真实报错**或**渲染快照**。
  （曾据此错判 `events`、`kb` 两条，被迫更正。）
- **通过数在环境不稳时没有比较意义**。只有**确定性信号**（错误消息、请求/响应证据、
  源码事实）配作为依据；"通过数变好了"不能当改善的证据。
- **并发会让门禁出现瞬态红**（别人改到一半）⇒ 先复查再认领，**但也不能拿它当借口**：
  要复跑确认"现在通过"才能下结论。

## 6. 缺少东西时优先克服困难，而不是绕道

**用户原话（2026-10-11，当时口头答复"记下了"但 2026-10-12 才落盘 —— 本条就是迟到的补救，
本身即反例）**：

> 以后缺少的优先选择克服困难，而不是直接绕道

具体含义：

- **缺工具/缺环境 ≠ 做不了**：先想"用什么办法能把它验证/做出来"，而不是立刻退到次选方案。
  · 例：没有 Docker 起不了 MinIO ⇒ 用本地 `minio-py` 做**交叉验签** + 自建 stub S3 做真回环，
    照样把 S3 路径验死（2026-10-11 实测）。
  · 例：Cloudflare API 没有"创建 R2 S3 密钥"的端点 ⇒ 走通 dashboard 路径，并把步骤写进 FAQ，
    而不是砍掉 S3 方案。
  · 例：构建被并发的 `next dev` 弄红 ⇒ 定位为"产物目录争用"，加 `NEXT_DIST_DIR` 隔离，
    而不是跳过构建门禁。
- **可以临时回退，但要公开、要留回头路**：如 S3 落点的"binding 优先、失败自动回退 inline"
  是**显式记录 storage 落点**的回退，不是偷偷降级；回退后要把"正路还缺什么"写进文档待办。
- **例外**：用户明确说"先算了/到此为止"时，按用户裁决停手并如实记录边界（≠ 自己放弃）。
- **把这条规则本身写进本文档**就是一次教训：口头"记下了"不算数，用户下达的**长期行为准则**
  必须像规则 1–5 一样**当场落盘**，否则下一个会话不会自动遵守。
