# 交接 · 排障：侧边栏点击"无响应/不跳转"（2026-10-21 立案 → 2026-10-22 定案）

> 症状：生产 `https://kaas.powervoy.com`，从 `/quotes?tab=pricing` 点侧边栏「产品」→ URL 不变、页面不变；
> 接口调用正常（用户原话）。**第二版：根因已用 A/B 实验证实并可复现**（第一版结论已作废，见 §0.2）。
> 本文仍**只记录取证与复现**；用户 2026-10-21 指令是"定位原因以后创建交接文档并推送，不用动手"，
> 因此代码保持原样（实验补丁已 `git checkout` 回滚）。修不修、何时发版由用户拍板。

## 0. 结论速览

### 0.1 根因（已证实，可 30 秒复现）

**静态导出（`output:"export"`）+ 侧边栏 `<Link prefetch={true}>` ⇒ 点击导航永久挂死。**

- 位置：`frontend/src/components/layout/sidebar.tsx:166`（`prefetch={true}`）
- 现象链：点击 → Next 的 `linkClicked` 先 `preventDefault()` → 调 `navigate(href, 'push', …, prefetchIntent)`
  → **此后 30 秒内零网络请求、零 history 调用、零 console 报错**，URL 不变。
- A/B 实验（同一份源码、同一静态服务器、同一 Playwright 脚本）：

| 变体 | 点击「产品」结果 | 点击后网络 |
|---|---|---|
| `prefetch={true}`（现状） | `/quotes` **不变**；2/5/10/20/30s 五次采样均不变 | **0 条** |
| `prefetch={false}`（实验） | `/quotes` → **`/products`** | `GET /products.txt?_rsc=…` → 200 |

- 对照（同一页面、同一会话）：页头普通 `<Link>`（`/settings/company-profile`，未写 prefetch）**点击即跳转**，
  且同样走 `linkClicked` → `preventDefault`（已用 `Event.prototype.preventDefault` 打栈证实两条链路一致）。
  ⇒ 不是 Link 坏了、不是 router 坏了，是**"带 prefetch 的 Link + 静态导出"这条组合**会挂。
- 另一条对照：`window.next.router.push('/products')`（不经过 Link）在**未被点击污染**的页面上是**成功**的
  （会发 `/products.txt?_rsc=…` 并改 URL）；但页面一旦发生上面那种"点了没反应"，后续 push 也会被一起卡住
  ⇒ 那个未完成的路由动作把队列占住了。

### 0.2 第一版结论作废说明（如实记录）

第一版把"Windows 构建导致逐段预取文件命名分叉（全站 404）"当作根因。**该缺陷真实存在，但不是本次根因**：
把文件名改成 Linux 形态（点号）后，**点击依旧不跳转**（`nested-fresh` 与 `flat-fresh` 两个变体结果相同，见 §2）。
它会带来 404 噪声与预取失效，属于**独立缺陷**，仍应修（见 §4 P1），但不要指望它能治"点不动"。

### 0.3 已排除（都实测过，别再重复怀疑）

| 排除项 | 怎么排除的 |
|---|---|
| 整页 RSC 通道坏 | `/products.txt?_rsc=…` 200、`text/plain`、build id `4Dmti-K92OFNDpa379m6W` 与 HTML 载荷一致、ETag 与本地产物相同 |
| build id 不一致 | HTML 与 RSC 载荷内 build id 相同；`fetch-server-response` 的 MPA 回退分支未触发 |
| 产物损坏/过期 | 从源码**重新完整构建**（`NEXT_EXPORT=1 next build`，39 条静态路由，exit 0）后症状**完全一致** |
| 分块缺失 | 扫描 191 个 html/txt 的 5832 条 `/_next/static/*` 引用，**0 缺失** |
| API/鉴权/工位订阅 | 全部 `/api/v1/*` 用 Playwright 打桩 200；`full_chain` 快照；页面能正常渲染 |
| CF 缓存规则 | `*.txt` 实测 `Cache-Control: public, max-age=0, must-revalidate`，未被 `/_next/static/*` 规则覆盖 |
| 路由守卫挡住 | 守卫只影响渲染，不阻止 URL 变化；实测 URL 根本没变 |
| hydrate 失败 | 无 hydration 报错、无 pageerror；同页其它 Link 可正常跳 |

## 1. 复现环境（本机，全离线，不依赖生产）

脚本都在 `artifacts/nav-repro/`（gitignored，可随时重跑）：

| 脚本 | 作用 |
|---|---|
| `serve.mjs <dir> <port>` | 静态服务器，模拟 Workers Assets + SPA 回退（无扩展名/目录 → `*.html`；仅 `Accept: text/html` 才回退 index） |
| `flatten.mjs <src> <dest>` | 把 Windows 导出的 `__next.X\Y\Z.txt` 扁平化成 Linux 形态 `__next.X.Y.Z.txt`（验证 §0.2 用） |
| `click7.cjs <base> <label>` | 打开 `/quotes`，等 6–8s，依次点侧边栏 `/products`→`/dashboard`→`/customers`，报 URL 与网络 |
| `longwait.cjs <base>` | 点一次后 2/5/10/20/30s 采样（证明是"永久挂死"而非"慢"） |
| `click5.cjs <base>` | 依次验证 `router.refresh()` / `push()` / `prefetch()` / 直写 history 的行为 |
| `click8.cjs <base>` | 给 `Event.prototype.preventDefault` 打栈，看"谁吞了这次点击" |

```powershell
# 1) 构建（工作区静止；NEXT_EXPORT=1 会产出 frontend/out）
cd frontend; $env:NEXT_EXPORT='1'; node node_modules/next/dist/bin/next build; cd ..

# 2) 起静态服务
node artifacts/nav-repro/serve.mjs frontend/out 4173             # 现状（nested 段文件名）
node artifacts/nav-repro/flatten.mjs frontend/out artifacts/nav-repro/flat
node artifacts/nav-repro/serve.mjs artifacts/nav-repro/flat 4175 # 段文件名已修正

# 3) 点击实验
node artifacts/nav-repro/click7.cjs http://127.0.0.1:4173 nested
node artifacts/nav-repro/click7.cjs http://127.0.0.1:4175 flat
node artifacts/nav-repro/longwait.cjs http://127.0.0.1:4173
```

> 实验时给 `/api/v1/*` 打桩（`page.route`）：`/auth/me`、`/me/workstations`(full_chain)、`/teams/me` 按真实形状返回，
> 其余返回空列表；`has_token=1` cookie 让 `AuthGate` 放行。打桩形状不对会先崩页面（`terms.ladder.findIndex` 等），
> 与导航问题无关——那是测试夹具问题，已被脚本里的 `shape()` 处理。

## 2. 实验原始结果

**A. 点击侧边栏（两个变体都挂）**

```
nested-fresh  /products  -> /quotes (不变)  seg: []
              /dashboard -> /quotes (不变)  seg: []
              /customers -> /quotes (不变)  seg: []
flat-fresh    /products  -> /quotes (不变)  seg: []
              /dashboard -> /quotes (不变)  seg: []
              /customers -> /quotes (不变)  seg: []
```

**B. 关掉 prefetch 后同一目标一次成功**

```
no-prefetch   /products  -> /products (跳转!)
              seg: REQ /products.txt?_rsc=YE0JWx0soY2IZPl6 -> RES 200
```

**C. 同一页面里"普通 Link"与"侧边栏 Link"的差别（click8）**：两者 preventDefault 的调用栈**完全相同**
（`chunk 1p19p_u-tojf4.js` 的 `linkClicked` → `onClick`），差别只在 `prefetch` 传参。

**D. 长时间采样（longwait，prefetch=true）**：点击后 2/5/10/20/30 秒采样，URL 恒为 `/quotes`，
网络恒为空 ⇒ **不是慢，是挂死**。

## 3. 机理（能确认的部分 / 未逐行确认的部分）

- 能确认：`node_modules/next/dist/client/app-dir/link.js` 的 `linkClicked()` 在本地 URL 上先
  `e.preventDefault()`，再 `require('../components/navigator').navigate(href, 'push', scroll, linkInstanceRef.current, transitionTypes, prefetchIntent)`。
  `sequential-router-queue.js:73` 的 `navigate()` 用 `startTransition` 包住 `startRouterTransition(…, prefetchIntent)` +
  `dispatchAppRouterAction(ACTION_NAVIGATE)`。实测 **dispatch 之后没有任何 fetch**，且随后 `router.push` 也被卡住
  ⇒ 卡点在"等 prefetch 完成"的那一步（`ensurePrefetchThenNavigate` 路径），而静态导出下这条 prefetch **永远不会 resolve**，
  也没有超时兜底。
- 未逐行确认：为什么 export 模式下 prefetch 不 resolve（候选：`_tree` 响应缺 Next 期望的完成信号 / 逐段请求在
  Windows 产物上是 404 导致 entry 一直被 reject 重试）。注意 §0.2：把段文件修正成 200 后**点击仍然挂**，
  所以"404 导致"这条候选**已被削弱**，更像是 export 模式下 prefetch 完成信号本身缺失。

## 4. 处置建议

### P0（治"点不动"，一行 + 重建 + 部署；已本机验证）

`frontend/src/components/layout/sidebar.tsx:166`：`prefetch={true}` → `prefetch={false}`。

- 影响面只在本机验证过（静态服务器 + Playwright，prefetch=false 变体点击立即跳转）。
- 代价：侧边栏失去预取（首次进入各页会多一次 `xxx.txt?_rsc=…` 请求，几十毫秒级），换来"点了能跳"。
- 更好的替代（未验证）：升级 Next；或保留 prefetch 但加"点击兜底"（`onNavigate`/超时后 `window.location`）。
  不建议把侧边栏整体换成 `window.location`（丢 SPA、丢状态）。

### P1（治"全站逐段预取 404"，独立缺陷）

静态导出改用 **Linux/CI 构建**（`deploy.yml` 的 ubuntu-latest 产物，或 WSL），不要"Windows 本机构建 + 直接 deploy"。
判据：`frontend/out` 下不应再出现名字里带 `\` 的文件；部署后
`/products/__next.!KGFwcCk.products.__PAGE__.txt` 应为 200。

### P2（防复发）

- 在 AGENTS.md 部署段立规：Windows 构建的静态导出不得直接 deploy；门禁可加一条"out/ 下不得有含反斜杠的文件名"。
- 给"导出产物 + 点侧边栏 → URL 变化"补一条 e2e（当前 e2e 跑 dev server，抓不到导出态这类问题）。

## 5. 影响面

- 生产当前**所有**"带 `prefetch` 的 Link"都会这样：侧边栏全部入口（`sidebar.tsx:166` 是唯一显式写 `prefetch={true}` 的地方，
  `grep -r "prefetch" frontend/src` 只此一处）；其它 `<Link>`（页头、卡片等，未写 prefetch）点击正常。
- 用户能看到的表现就是"侧边栏点了没反应"，但站内其它链接、刷新、直接输入 URL 都正常。

## 6. 待办登记

| 项 | 状态 | 证据/备注 |
|---|---|---|
| P0：`prefetch={false}` + 重建 + 部署门面 | ✅ **已完成（2026-10-22，用户弹窗批准）** | 见 §7 |
| P1：改 CI/Linux 构建静态导出并重新部署 | ✅ **已完成（2026-10-22，Docker `node:22` 容器内构建）** | 见 §7.5 |
| P2：AGENTS.md 立规 + 产物门禁 + 垃圾忽略 | ✅ **已完成（2026-10-22）** | 见 §7.6 |
| P3：导出态 e2e（nightly，真实导出产物上点侧边栏） | ✅ **已完成（2026-10-22，6/6 通过并接入 nightly）** | 见 §7.7 |

## 7. 执行记录（2026-10-22，P0）

1. **改代码**：`frontend/src/components/layout/sidebar.tsx:166`，`prefetch={true}` → `prefetch={false}`（带注释说明原因）。
2. **重建产物**：`cd frontend; $env:NEXT_EXPORT='1'; node node_modules/next/dist/bin/next build` → exit 0（39 静态路由）。
3. **发版前本机复验**（对即将上传的同一份 `frontend/out`）：`serve.mjs frontend/out 4173` + `click7.cjs` →
   **`/quotes` 点「产品」→ `/products`，`GET /products.txt?_rsc=…` 200**（修复生效）。
4. **门禁**：`pnpm typecheck`（`next typegen && tsc --noEmit`）**exit 0**。
5. **部署**：`cd backend/ts-worker; node node_modules/wrangler/bin/wrangler.js deploy`（带 `CLOUDFLARE_API_TOKEN`）
   → **Uploaded 153 files（148 unchanged），Worker Startup 27ms，version `fe855137-87ac-4c05-8238-9d5266d44567`**；
   `kaas.powervoy.com` / `api.kaas.powervoy.com` 两条 custom domain 已接。
6. **生产验证**：
   - 产物一致性：线上 `GET /quotes` 与本地 `frontend/out/quotes.html` **SHA256 完全相同**（`901F91EF3B88…`）
     ⇒ 线上跑的就是本机通过点击实验的那份产物。
   - 冒烟：`/health` 200、`/api/v1/auth/me` 401（门面鉴权仍在）、`/products` 200、`/login` 200。
   - 限制（如实）：**「点击侧边栏」无法用 curl 在生产复验**（需登录态）；判定依据 = 产物逐字节一致 + 本机同产物点击通过。
     若复访仍点不动，请先 **Ctrl+F5 强刷**（旧 chunk 可能被 immutable 1 年 + CF 30d 规则留住），并把 Console/Network 截图给我。

### 7.3 P1 缺陷说明（已修，留档）

Windows 本机构建时，Next 用 `path.relative()` 得到反斜杠路径、而 `convertSegmentPathToStaticExportFilename()` 只把 `/` 换成 `.`，
于是逐段文件被写成 **目录**：`out/products/__next.!KGFwcCk/products/__PAGE__.txt`；
客户端请求的是点号名 `__next.!KGFwcCk.products.__PAGE__.txt` ⇒ 全站预取 404（不阻塞导航，只损预取 + 404 噪声）。
Linux 构建（`path.relative()` 返回 `/`）直接产出正确点号名，故此缺陷只在 Windows 构建时出现。

### 7.4 并发提交碰撞留痕（2026-10-22，已核对无内容丢失）

本工作区当日上午**另有会话在并行提交 CI 瘦身**，我的提交与它撞了 `HEAD` ref 锁，结果：

- `c6da7ef`（对方）：CI 瘦身正式提交，内容完整；
- `e972c78`（**message 是我的、内容其实是对方 `CI_OPTIMIZATION_2026-10-22.md` 的 +15 行补充**）；
- `432fec4`（我的真修复）：只含 `sidebar.tsx` + 3 份文档，`git show --stat` 已逐条核对。

核对结论：**双方内容都没有丢失**（对方的 CI 文档在 `c6da7ef`+`e972c78` 里都在；我的修复在 `432fec4`）。
唯一问题是 `e972c78` 的 commit message 与内容不符（历史已推送，改写需 force-push 共享 main）。
**处置（2026-10-22 已完成）**：用户确认「其他会话已暂停、仓库可正常改写」后，把 `e972c78` 的 message 改正：
`git checkout --detach c6da7ef` → 依次 `cherry-pick -n <c>` + `git commit -C <c>`（`e972c78` 那步再 `--amend -m "docs(ci): 补额度用尽实证（job 0-3s 失败与恢复路径）"`）→
`git checkout -B main` → `git push --force-with-lease origin main`。

- 重写后：`e972c78` → **`6ef5a24`**，其后 5 个提交 hash 顺延（`432fec4`→`99c7648`、`0401bdf`→`7dc80e0` 等），**内容零变化**；
- 自证：`git diff --stat backup/main-before-reword-20261022..main` **为空**（备份分支保留改写前 tip，可随时对照/回滚）。

### 7.5 执行记录（2026-10-22，P1：改用 Linux 构建产物）

背景：CI 走不通（当日上午 GitHub Actions 额度被账单拦截，本地也无 Linux 环境），改用 **Docker 容器构建**。

1. **准备最小树**：把 `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` / `frontend/`（排除 `node_modules` `.next` `out`）/ `shared/`
   复制到 `%TEMP%\kaas-linux-build`（552 个文件）。
2. **容器内构建**（`node:22`，挂载该目录为 `/work`，pnpm store 单独挂载复用）：
   `pnpm install --frozen-lockfile`（1035 包，约 9 分钟，含拉镜像）→ `cd frontend && NEXT_EXPORT=1 pnpm build`
   → **`✓ Compiled successfully in 39.0s`**，39 条静态路由，`out/` **302 文件**。
   - 期间 Docker Desktop 自行重启过一次（daemon 版本 29.9.1→29.9.2），第一次 `docker run --rm` 被 `unexpected EOF` 打断；
     改为 **detached + 日志轮询**（`docker run -d --name kaas-build … > /work/build.log`）后才稳定跑完。
3. **产物验收（本地）**：`out/products/` 下为 `__next.!KGFwcCk.products.__PAGE__.txt`、`__next._full.txt`、`__next._tree.txt`；
   `Get-ChildItem -Recurse | Where-Object { $_.Name -match '\\\\' }` **0 命中**；`__next.*` 目录 **0 个**。
   静态服务 4176：点号名 **200**、旧目录形态 **404**；`click7.cjs` 点侧边栏 **`/quotes` → `/products` 跳转成功**。
4. **部署**：`node node_modules/wrangler/bin/wrangler.js deploy` → **Uploaded 237 files（64 unchanged），version `71be6dbb-56c7-4b78-b4cb-a0634abc5032`**。
5. **生产验证**：
   - `GET /products/__next.!KGFwcCk.products.__PAGE__.txt` → **200**（修复前 404）；
   - `GET /quotes/__next.!KGFwcCk.quotes.__PAGE__.txt` → **200**；旧形态 `/products/__next.!KGFwcCk/products/__PAGE__.txt` → **404**（符合预期）；
   - 产物一致性：线上 `/quotes` 与本地 `frontend/out/quotes.html` **SHA256 相同**（`73CDFC94E33C…`）；
     线上逐段文件与本地同名文件 **SHA256 相同**（`AAF42F842B7D…`）；
   - 冒烟：`/health` 200、`/api/v1/auth/me` 401、`/products` 200、`/login` 200。
6. **结论**：P0（点击挂死）+ P1（逐段预取 404）**均已修复并上线**；后续发版请走 Linux/CI 构建，别再用 Windows 产物直接 deploy（见 §7.6）。

### 7.6 执行记录（2026-10-22，P2：防复发）

1. **立规（AGENTS.md 门禁段）**：新增硬约束「**禁止用 Windows 本机构建的 `out/` 直接 deploy**」+「侧边栏等 `Link` 不要显式
   `prefetch={true}`」，并把 `pnpm assets:check` 写进构建门禁行（构建后必须通过）。
2. **产物门禁 `scripts/check-export-assets.mjs`**（`cd frontend; pnpm assets:check`）四类确定性检查：
   - [A] `out/` 不允许名字含反斜杠的文件；
   - [B] `out/` 不允许出现 `__next.*` **目录**（Windows 构建的实际表现；A 在 Windows 上造不出这种文件名，B 才是可观测形态）；
   - [C] 191 个 html/txt 里 **5832 条** `/_next/static/*` 引用必须全部可解析（产物完整性）；
   - [D] `frontend/src/**` 不允许 `prefetch={true}`（**跳过注释** —— 第一版把修复注释里的说明判成违规，已修）。
3. **门禁自证（阳性对照，按测量纪律）**：在 `%TEMP%` 造违规样本（`out/products/__next.BAD/x.txt` + 非注释的 `prefetch={true}`），
   门禁 **exit 1** 并逐条点名 `[B]`/`[D]`；对当前 Linux 产物跑 **PASS**（`badNames=0 nextDirs=0 missingRefs=0 prefetchTrue=0`）。
4. **为什么不写「导出态 e2e」**：一次真实导出要 `next build`（分钟级）+ 静态服务 + 浏览器，CI 分钟成本与本仓库既有的
   `frontend/.next` 硬冲突纪律都吃不消；而本次两个缺陷的根因特征都能**静态判定**（A/B/C/D），故用门禁代替。
   代价（如实）：门禁只抓「已知形态」，抓不到新的未知交互类回归；真要做端到端，建议放 nightly 独立 job 再立项。
5. **未跟踪垃圾**：`.gitignore` 新增「未跟踪垃圾一律忽略」段（含实测的 `%SystemDrive%/`、`*.orig`、`*.rej`）。

### 7.7 导出态 e2e（nightly，2026-10-22 补齐）

补的是「dev 态 e2e 的盲区」：现有 27 条 e2e 全部跑 `next dev`（`frontend/playwright.config.ts` 的 webServer），
2026-10-22 两个线上事故（P0 点击挂死、P1 逐段 404）在 dev 态根本复现不出来 ⇒ 只能靠人肉构建+手点。

**新增文件**：

| 文件 | 作用 |
|---|---|
| `frontend/playwright.export.config.ts` | 独立配置：`webServer` 起静态服务器（4173），`baseURL` 同源，只跑 `e2e-export/` |
| `frontend/e2e-export/global-setup.ts` | 种 `has_token` cookie + `kaas_token`（origin 换成 4173，不能照抄 3000） |
| `frontend/e2e-export/navigation.spec.ts` | 3 条：点击`产品`URL 变化+RSC 200；连点 3 个入口不挂死；全程无 `__next*.txt` 4xx |
| `frontend/e2e-export/smoke.spec.ts` | 3 条：关键路由直达 200 且有内容；点号段文件 200；未命中 `.txt` 必须 404（不被 SPA 回退伪装） |
| `frontend/scripts/build-export-e2e.mjs` | 构建导出产物（`NEXT_EXPORT=1` + mock API），Windows 上把段文件名拍平成 Linux 形态 |
| `frontend/scripts/serve-export.mjs` | 静态服务器，SPA 回退语义对齐 Workers Assets（只对 `Accept: text/html` 回退） |
| `.github/workflows/frontend-ci.yml` | 新 job `e2e-export`，`if: schedule / workflow_dispatch`，跑 `pnpm e2e:export` |

**本地跑法**：`cd frontend; pnpm e2e:export`（自动构建+跑）；只想重跑用例：`pnpm e2e:export:only`。

**实测口径（2026-10-22，本机 Windows）**：

- `6 passed (11.3s)`，构建 `9.5s`（Turbopack 增量）；
- Windows 构建照例把 **37 个**逐段文件写成目录，`build-export-e2e.mjs` 拍平后与 Linux 产物同形 ⇒ 本地可测；
  **CI（ubuntu）上 `path.relative()` 返回 `/`，该拍平函数是 no-op**，测的是原生 Linux 产物；
- **阳性对照（证明用例不是空跑）**：把 `products/__next.!KGFwcCk.products.__PAGE__.txt` 删掉 ⇒ P1 用例 `Expected: 200 / Received: 404` 失败；
  把 `products.txt` 删掉 ⇒ 导航用例 `期望 /products.txt?_rsc=… 的 200` 失败（实捕获 `[{"url":"…/products.txt?_rsc=…","status":404}]`）。

**边界（如实）**：产物用 mock API 构建（`NEXT_PUBLIC_API_MODE=mock`）+ 本地静态服务器，不覆盖真实 API / CF 缓存 / 域名；
`/e2e` 之外的真实数据流仍由契约测试 + ts-worker 测试兜。CI 只在 nightly/手动跑（含构建约 3–4 分钟）。

---

*取证与修复：lead（DSH AI），2026-10-21 立案 / 2026-10-22 定案并修复上线。*
