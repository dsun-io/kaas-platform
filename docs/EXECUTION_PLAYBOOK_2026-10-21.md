# 执行者强化提示词 · KaaS 平台全任务线（W1/W2/W3/W4/W5 通用）

> 来源：用户 2026-10-21 直接下发。**每个被派任务的队友/子代理必须在 prompt 里携带或先读本文件。**
> 宁可慢，不能错。发现文档过时或代码已有实现时，先按 §0 判定权威，记录差异，继续推进，不停下等拍板。

## 0. 冲突判定原则

代码事实 > 旧文档；同一文档内较新的小节 > 较旧的小节（例：§2.0「Phase 3 作废」> 残留 Phase 3「引擎移植」字样）。

唯一权威文档：优化计划进度 = docs/OPTIMIZATION_PLAN_2026-10-21.md；当前口径 = docs/PROBLEM_STATUS_2026-10-11.md；架构决策 = docs/ARCH_DECISIONS.md；历史在 docs/archive/，不要用归档判断当前口径。

发现矛盾文本 → 按作废口径执行，同时把矛盾登记到文档待办，不照过时文本执行。

## 1. 架构边界（最高优先级，出错=重蹈覆辙）

- 业务规则只在 Python 内核一处实现。TS 门面只做鉴权、参数校验、协议转换（统一错误 envelope、CORS）。任何业务 if/计算/状态机/条件判断「该不该怎样」都不写在 TS 侧——哪怕「看起来只是个 if」。
- 不做引擎 TS 直译。报价/单证引擎（kaas_common/）零重写，只能经 Service Binding 调用。看到 Phase 3「引擎移植」字样=过时残留，按作废执行。
- 禁止出现第二份实现。早期两个后端合并的原因就是同一逻辑两份必然漂移。不要因为「Python 那边不方便」就在 TS 侧补一份简化版逻辑，哪怕临时。
- 边界靠门禁不靠自觉。每加一处 TS 逻辑，自问「金标 harness 能不能抓到漂移」。抓不到的，补门禁或别加。

## 2. 跨层契约（错了=静默漂移）

- TS 侧 zod schema 从 Python pydantic 模型**代码生成**，禁止手抄。没有生成器就先建生成器，不要先手写 schema「顶一下」。
- 跨层契约变更必须同 PR + 金标 harness 全绿（backend/ts-migration/golden/）。禁止单方面改请求/响应形状。
- 统一错误形状：内核不可达/5xx 一律包成 {error:"kernel_error", message, status}，4xx 原样透传。不要重新包一层或改 message。
- Service Binding 语义：内核调用走 env.KERNEL.fetch，禁用公网域名直连内核；内核 5xx 抛 KernelError，不要静默吞掉或重试出另一套语义。

## 3. 金标 harness（迁移质量主门禁）

- 当前 harness 只是原型（5 条只读 smoke）。扩到全量清单时每条必须标 side_effect；生产域名命中时写操作请求会被拒绝执行，这个防护别绕过。
- 忽略字段白名单显式登记，不要静默放过差异。diff 出差异是「发现漂移」不是噪声——先查清楚再决定是否加白名单，禁止直接加 ignore 求绿。
- 数字默认精确比较，--float-tolerance 只留 Decimal→number 迁移期，不随手放宽容差掩盖漂移。
- 不要拿「通过数变好了」当证据。只有确定性信号（错误消息、响应 diff、源码事实）算数。报数字前打印完整未过滤摘要，核对 passed+failed+skipped 总数。

## 4. 性能与运行时（W1/W3，不为快而破坏语义）

- 冷启动目标 ~50ms，但不为性能牺牲契约语义（不跳过 schema 校验、不提前短路返回）。
- bcrypt $2b$ / JWT HS256 兼容性是硬约束：已有用户密码哈希零迁移成本。别换算法、别改默认参数。
- CORS 中间件语义逐条对齐 Python 版（白名单、回退来源、OPTIONS 204、Max-Age、Vary、未捕获异常也带 CORS 头返回 500）。少一个头会把真实 500 伪装成跨域问题——项目已踩过。
- 静态资产缓存规则：Workers Assets 用 _headers，Next 静态导出不应用 next.config headers；CF 缓存规则表达式里 starts_with 函数式会 400，用 wildcard/infix。
- NEXT_DIST_DIR 只隔离产物目录，不隔离源码并发写——构建门数字只在工作区静止时作数。Next 16 静态导出不要设 NEXT_DIST_DIR（产物会落错目录）。
- （已完成登记：Python 侧懒加载裁剪 d84ce81/部署 586ab897，边际改善；根治=TS 门面。）

## 5. 结构性债务与代码健康（W2）

- 改共享内核（backend/kaas_common/）后必须跑 scripts/sync-shared.ps1，否则 worker 端是旧的。
- 静态断言门禁一个都不能跳：check-runtime-deps.py、check-schema-coverage.py、check-schema-drift.py、check-worker-bundle.py、sync-shared.ps1 -Check。已退役的（route-parity.py、export_openapi.py、contracts R6）不要跑也不要新增引用。
- schema 漂移表级门禁查不出（曾漏 team_id 列导致 500）——列/索引级漂移靠 check-schema-drift.py 对生产快照比对。生产独有表登记在 scripts/schema-drift-allowlist.txt，不要私自加条目掩盖真漂移。

## 6. 测试与测量纪律（本项目已因此错过多次）

- 宣布任何「通过/失败/归零」前，必须打印完整不过滤摘要并核对 passed+failed+skipped == 总数。数字对不上=证据不足，不是「没问题」。
- 「没匹配上」≠「没有」：grep 0 命中可能只是命令没跑在预期对象上；下结论前用阳性对照或打印 cwd 确认工具作用在预期对象上。
- 不要用关键字 grep 当「某文案/控件不存在」的证据——要真实报错或渲染快照。
- 并发会让门禁瞬态红（别人改到一半）→ 先复查再认领，但不能拿它当借口：要复跑确认「现在通过」才能下结论。
- 12 条 db/integration 测试按约定 skip 是正常口径，不是失败；有 docker PG 时会真跑（总数 1572）。不要为了数字好看改 skip 标记。
- e2e 前必须探针验证 hydration 前提：Next 16 dev 走 Turbopack，main-app.js 恒 404（旧探针写法已废）；改为把 /login 页面引用的全部 /_next/*.js chunk 逐一探 200，或依赖 playwright webServer 就绪探测。不满足⇒ e2e 数字作废，不是产品信号。
- frontend/.next 是硬冲突资源：next build/NEXT_EXPORT=1 pnpm build 与 e2e 的 next dev 不能同时跑，否则客户端分块 500→不 hydration→MSW 不运行→零请求→页面全白，那一轮 e2e 数字全作废。

## 7. 前端与 UI（W1/W3 相关）

- docs/UI_STANDARDS.md 是硬性约束，新增页面/组件也必须遵守；本地跑 pnpm ui:standards + pnpm ui:contrast；pnpm e2e 的 a11y 用例会自动发现新增路由。
- 技术栈基线勿回退：Next 16.4.2 / React 19.3 / ESLint 10.13（flat config，next lint 已删除）/ TypeScript 6.0.3；CI Node 22；pnpm audit 目标 0 critical。
- 本机工具链陷阱：PATH 上的 python 是 WindowsApps 占位符 ⇒ 需要 Python 的命令一律用 backend/orchestrator/.venv/Scripts/python.exe；orchestrator 测试用 uv run --extra migrations，worker 测试用 uv run。本机没有 PowerShell 7 ⇒ pwsh scripts/… 改用 powershell -ExecutionPolicy Bypass -File scripts/…。uv 需设 UV_CACHE_DIR='D:\tools\uv-cache'（纯 ASCII 路径），pywrangler 还需 PYTHONUTF8=1。

## 8. 对外能力与收尾退役（W4/W5）

- W5 MCP + REST 建在 TS 门面（一等公民），复用鉴权；不要在 Python 内核侧另起一套鉴权/路由。
- W4 退役 Python worker 前，必须确认所有路由已迁完且金标全绿——退役是最后一步，不是并行步骤。cron 3 条留 Python 内核，不在门面。
- 旧 Neon 项目/旧 Hyperdrive 清理是破坏性操作，必须先向用户确认，不能自行删除。

## 9. 并发与提交纪律（工作区有多条线同时在写）

- 不要用 git add -A / git add . / 裸 git commit——本项目因此断过一次 HEAD。用私有 GIT_INDEX_FILE（指向 %TEMP%）只装自己的 hunk；提交后清掉 GIT_INDEX_FILE 变量，再用 git add -- <自己的路径> 把共享 index 归位。归位判据：git diff HEAD -- <自己的路径> 为空且 git status --short -- <自己的路径> 无输出。
- 提交前后都要 git status --short 自证：自己的路径干净，别人的改动原样还在。git commit -- <pathspec> 不足以保证没提交别人的东西（它记录工作树内容，不是 index）。
- 不要拿别人的文件做自证（如临时改错一个键演示门禁能抓到）——只在自己的写入范围内做。
- 部分 hunk 提交前先转 LF（工作树 CRLF、index blob LF，直接 patch 会 does not apply）。
- 换行/编码陷阱：写 secret 不要 Get-Content x | wrangler secret put（管道尾部加换行导致 401 且静默失败）；用 Set-Content + Cloudflare API 精确写入，或 printf %s 管道。commitlint subject-case 禁句首大写 ⇒ subject 用中文或全小写。

## 10. 缺东西时优先克服困难，不绕道

缺工具/缺环境 ≠ 做不了：先想「用什么办法能验证/做出来」，而不是立刻退到次选方案（例：没有 Docker 起 MinIO ⇒ 用本地 minio-py 交叉验签 + stub S3 真回环照样验死；CF API 没建 R2 S3 key 端点 ⇒ 走 dashboard 路径并写进 FAQ，而不是砍掉方案）。

可以临时回退，但要公开、留回头路（如 S3 落点「binding 优先、失败自动回退 inline」是显式记录落点的回退），回退后把「正路还缺什么」写进文档待办。例外：用户明确说「先算了/到此为止」时，按用户裁决停手并如实记录边界（≠ 自己放弃）。

## 11. 文档与密钥（贯穿所有任务）

- 改代码必须同步更新相关文档并提交推送到 main（推送偶发 Connection was reset 要重试）。当前口径文档是 docs/PROBLEM_STATUS_2026-10-11.md，每完成一项就更新它和顶部「交接摘要」；交接入口统一 docs/README.md。文档里过时状态必须改掉——宁可标「未做」，不能让文档写着旧状态。
- 密钥铁律：DSH-Admin 命名的密钥仅供 DSH AI 使用，保持用户级全局环境变量，禁配到平台/Worker/CI/GitHub Actions secrets；系统用独立 kaas-* token（一个密钥一个用途）。破坏性密钥操作（吊销/轮换/删除/改权限）必须先向用户确认，只读审计可直接做。密钥不入仓、不打印、不外传。

## 12. 必须停下问的（只有这几类，其他一律带判断往前推）

1. 破坏性操作：删生产数据、删旧 Neon/Hyperdrive、密钥吊销/轮换/删除/改权限；
2. 授权/策略口径变化（谁能发起、隔离粒度改哪层）；
3. 生产环境切流/部署口径变更（如域名切分、灰度策略调整）；
4. 你无法用任何办法验证的关键事实（且确实不是「我没查」）。
