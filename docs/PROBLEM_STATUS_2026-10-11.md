# 现存问题对账（2026-10-11）

> **本文是「问题状态」的当前口径。**
> 此前多份文档（`CURRENT_IMPLEMENTATION_MAP` / `MULTI_PRODUCT_QUOTE_PLAN` /
> `DUAL_BACKEND_CONVERGENCE` / `WORKER_ORCHESTRATOR_DRIFT` / `EXECUTION_SUMMARY_2026-10-10` /
> `FRONTEND_PRODUCTION_READINESS`）记的是**当时**的判断，其中相当一部分**已经修复**。
> 想知道"现在还剩什么问题"，看这一份；想了解当时的判断过程，去看原文。

***

## 交接摘要（滚动更新 · HEAD 以 `git log` 为准 · 文件域/产品媒体特性 2026-10-12 收口）

> **📌 主交接文档已切换：[README.md](../README.md)**（2026-10-19 晚场起，架构 / 三环境隔离矩阵 /
> 方案 B 决策 / 冷启动线 / 测试策略的唯一权威）。**最新交接总入口（2026-10-20 定稿）：
> [`HANDOVER_2026-10-20_FINAL.md`](./HANDOVER_2026-10-20_FINAL.md)**（状态/资源清单/踩坑/发布检查单/待办）。
> 本文件继续只做"问题状态"滚动口径。
>
> **（2026-10-20 · 口径修订：「待办清零/触发条件制」废止 → 活跃待办账本）**
>
> 用户裁决（2026-10-20 晚）：真实工作项不应以触发条件制隐藏，**下方「终局裁决：全部待办清零」中
> ⏳ 触发条件制的部分废止**，受影响项全部恢复活跃跟踪。账本 =
> [`docs/TODO.md`](./TODO.md)（A 单证内容专项 9 项：内容级版本 / 服务端签发兜底 / 缺失字段可发现 /
> 素材库 / 编辑体验 / 真单据对照 / 单证加固 P1-P2 / PDF 归档尾巴 / 指纹对账调度；B 产品配置化 3 项；
> C 原 I-1~I-7 其余 6 项；D 发布窗口 6 项）。**由用户排期执行**；完成一项在 TODO.md 销账并在
> 本摘要登记。本条压过下方「待办清零」条目中与之冲突的表述。
>
> **（2026-10-20 · S5 预览链修复 + 云资源清理 + 审批门禁解除）**
>
> 1. **三个真 bug 修掉（均有实测证据）**：
>    ① GitHub 会**静默丢弃含密码的 job output**（日志 `Skip output 'PREVIEW_DATABASE_URL' since it
>    may contain secret`）⇒ 迁移 job 拿空 DSN；改 `scripts/preview/db-url.py` 在 job 内自取。
>    ② 预览**选错库**：每个 Neon 分支有两个库（`kaas_v2_test` / `neondb`），ensure 取 `databases[0]`
>    连到空库；改为跟生产 Hyperdrive `origin.database` 同库名（连的仍是**预览分支快照**，隔离不变）。
>    ③ 预览 Hyperdrive **查询缓存开着** ⇒ 改库后 60s 内读旧行（重置密码后登录持续 401）；
>    预览 config 改为 `caching.disabled=True`（生产保持原状）。
> 2. **审批门禁解除**：`preview.yml` 重写 —— secrets 逐项注入（**去掉 `toJSON(secrets)` 整包**）、
>    写权限下沉 job 级、迁移/冒烟修正（冒烟等 6 分钟）；实测 `workflow_dispatch` **全绿且不再
>    action_required**（run `39375956315`）。预览链已可全自动。
> 3. **云资源清理（用户授权，先备份后删）**：删 `kaas_v2_test`（生产分支，13MB/81 表/冻结
>    `202609300001`/0 用户，备份 13 个 CSV 到 `backend/.tools/backup-kaas-v2-test-20261020/`）；
>    删 dev 分支 `kaas_v2_test_records`（89 表/25 行，备份在 `...-records-20261020/`）；
>    删分支 `pre-deploy-20261018-2150`；删 **`kaas-ppg` Hyperdrive**（PPG 废弃线残留，规则要求不保留）。
>    现状：分支 = production / dev / preview-pr-424242，各自仅 `neondb`；Hyperdrive = `neon-kaas`（生产）
>    + `kaas-preview-424242`（演示）。其他项目资源（gaojin/lianjia/powervoy-web）**未动**。
> 4. **演示预览可用**：424242 连预览分支 neondb（生产快照：10 客户/2 报价/2 单证/3 个生产账号），
>    补演示管理员 `demo@kaas.preview`；**14 分钟连续 200 无崩溃**（KV 版）。"~10 分钟必崩"**未再复现**,
>    先前最可能叠加因素 = 错误库（旧 schema `kaas_v2_test`）+ 指向被删 config 的绑定。KV-less 对照
>    实验开关（`--no-kv`）已加，观察中；依赖钉版（`pylock.toml` 入库）待根因定论后做。
> 5. **仓库可见性**：当前 **public**（用户裁决：保持公开以让 CI 免费跑，本人稍后自行转回 private；
>    原"已转回 private"表述已过期）。
> 6. **并行线**：UI/UX 优化任务（另一会话）与本线**写范围不相交**（本线只动 `docs/`、`.github/`、
>    `scripts/preview/`、后端脚本），未碰 `frontend/**`。
> 7. **依赖钉版已落地（2026-10-20，`3abdcad`）**：`backend/worker/pylock.toml` **入库**（解析结果 =
>    9/22 基线可稳组合：fastapi 0.141.1 / starlette 1.6.0 / pydantic 2.12.5 / asyncpg 0.31.0 /
>    bcrypt 5.0.0），`.gitignore` 改为只忽略 POC 子目录；pywrangler 检测到锁文件即以其为约束 ⇒
>    **不再"每次部署解析当天最新依赖"**。AGENTS.md 补：uv pyodide 探针在 CJK 路径下坏的修法
>    （`UV_CACHE_DIR` 指 ASCII 路径 + `PYTHONUTF8=1`）。
> 8. **预览链端到端验证（2026-10-20）**：① `workflow_dispatch` 部署 **全绿**（preflight→ensure→
>    migrate→build→deploy→smoke，run `39377320026`，锁文件版）；② **PR 关闭 → teardown 自动执行成功**
>    （PR #4 closed 事件 run `39377738492`，7s 回收）；③ 演示环境登录 200 + `/auth/me` + 客户列表
>    2 条（生产快照数据可读写）；④ 稳定性：CI 部署版**连续 14 分钟 200 无崩溃**（此前"~10 分钟必死"
>    未再复现）；KV-less 对照版 **13 分钟 16/16 全 200** ⇒ 崩溃与 KV 开关无关，最可能由"错误库/旧绑定"
>    叠加导致，当前未复现。
> 9. **夜间收尾（2026-10-20）**：① 演示环境（424242）**已按用户指令 teardown**（worker/Hyperdrive/
>    Neon 分支/KV/R2 前缀全清、0 残留）；② **最终交接文档定稿** `docs/HANDOVER_2026-10-20_FINAL.md`
>    （含三环境现状、云资源清单、踩坑结论、发布检查单、待办与并行写提醒）；③ 归档三份已清零账本
>    （`HANDOVER_2026-10-20`/`USER_ACTIONS_2026-10-19`/`MASTER_EXEC_PLAN_2026-10-19` →
>    `docs/archive/2026-10-20-closeout/`，活文档链接 0 残留）。**下一节点 = UI 任务收尾 → 用户预览
>    验收 → 发布（检查单见 FINAL §5）**。
>
> **（2026-10-20 · 终局裁决：全部待办清零 —— 压过本摘要内所有旧待办条目）**
>
> ⚠️ **（2026-10-20 晚口径修订）本条的「⏳ 触发条件制、不再活跃跟踪」部分已废止**：工作项恢复
> 活跃待办，见顶部最新条目与 [`docs/TODO.md`](./TODO.md)；✅ 完成项的结论不变。下文 ⏳ 各条仅作
> 历史处置记录，**当前状态以 TODO.md 为准**。
>
> 用户裁决：未关闭待办全部清零 —— ✅ = 完成；⏳ = **触发条件制**（到点自动执行 / 用户一声令下），
> **不再活跃跟踪**。逐项处置见归档的 `USER_ACTIONS_2026-10-19.md` 状态列与
> `MASTER_EXEC_PLAN_2026-10-19.md` §5 / 顶部 2026-10-20 状态行。关键落点：仓库可见性见上条（现为
> public，用户自转）；Neon Protected 为付费功能、不升级，预览脚本「删分支双保险校验」替代
> （U-S5 ✅，README §2.2 已标注）；生产 R2 桶**永久保留 `kaas-files`**（U-S6 ✅，目标态改名取消）；
> R2 新 keys + `RESEND_API_KEY`（U-B1/U-B5）、U-E3/U-E4 发布窗口、**Hyperdrive 缓存关闭**、
> **生产测试数据 / 流失拒绝文件历史清理** → ⏳ **发布窗口**（**数据清理执行当次仍需用户确认**；
> 检查单 = `HANDOVER_2026-10-20_FINAL.md` §5）。
> 过时文档已 `git mv` 归档 `docs/archive/2026-10-20-closeout/`（22 份 + 目录 README）。
> **下一活跃节点 = 用户发布指令。**
>
> **（2026-10-20 · UI/UX 全系统优化方案已出，未改产品代码）**
> 方案文档：`docs/UI_UX_OPTIMIZATION_2026-10-20.md`（纯前端展示与交互层；诊断 11 个维度 + 8 节方案 + 验收清单）；
> 证据：1440×900 改前截图（`docs/ui-redesign/before/`）+ 三屏高保真原型（`docs/ui-redesign/prototype/`）。
> 结论要点：组件未收编（标题 2 套 / Tab 3 套 / 状态标签 3 套 / 按钮 2 套）、列表缺结构、加载态 28 处纯文本、
> 可访问性无焦点/aria/降级动画。**待用户确认视觉方向与优先级后再按 P0→P1→P2 落地**（落地须同步跑前端门禁）。
>
> **（2026-10-20 · UI/UX 第一批已落地：客户管理 + 登录页，浅色毛玻璃 + 电光蓝）**
> 用户评审后改方向：石墨冷灰 + 电光蓝（去掉紫调）、侧栏改浅色毛玻璃、客户详情从「列表下方展开」改为
> **屏幕内弹窗**（玻璃底但保证阅读）、往来记录**并入询盘 tab**（每条询盘展开看 报价单→订单→单证）。
> 为准确挂接，records 的 quote 节点补只读 `inquiry_id`（共享内核 + worker SQL + 前端类型 + mock）。
> 同步修复：登录 logo 被 flex 拉伸、侧栏底部字段重叠（去掉版本号 + 关闭 dev 指示器）、客户页原生 select → 统一 Select、
> 已报价询盘按钮显示「重新报价」。
> 证据：`docs/ui-redesign/phase2/`（列表/登录/弹窗/询盘后续/下拉框/1366）。
> 门禁：typecheck 0 / lint 0 err / vitest 455 / contracts R0–R6 PASS / e2e 23+4 skipped=27 /
> NEXT_EXPORT build out/268 / orchestrator records 8 / worker records+parity 65 / sync-shared PASS。
> **其余 30+ 页面内容迁移与 P1/P2 项仍未做**，详见方案文档 §0.1。
>
> **（2026-10-20 · UI/UX 第二轮修订：信息密度与询盘链路）**
> 侧栏/顶栏毛玻璃再透；联系人并入「信息」tab（主要置顶 + 其余添加时间倒序，前端排序）；
> 客户详情弹窗固定 1080×760 不再随内容伸缩；询盘条目按推导状态展示「已成交 + 最新订单状态」
> （有订单时不再显示过时的已报价，**未改后端 status**），整卡点击展开、操作收进「…」；
> 展开后单证改为**扁平表 + 生成时间倒序**（类型/编号/状态/金额/时间），点击弹单证信息并可跳
> `/trade-docs?doc=<id>` 看完整单据（深链已加）；mock 单证补金额/时间、联系人补到 3 位。
> 证据：`docs/ui-redesign/phase3/`；门禁：typecheck 0 / lint 0 err / vitest 455 / e2e 23+4=27 / build out/268。
> 详见方案文档 §0.2。
>
> **（2026-10-20 · UI/UX 第三轮：询盘编号/阶段/单证内嵌预览/账号区）**
> 询盘列表改为“询盘编号 + 阶段徽章（关闭/询盘/报价/订单/发货/完结）”，产品名降为副行只显示名称；
> 阶段按单证类型 + 订单状态**展示推导**（不改后端 status）；展开删掉重复的报价单/订单编号行，
> 单条订单扁平、多条按订单分组，单证按生成时间倒序；联系人只写名字、点击弹联系人信息（不跳页）；
> 单证点击**有权限时直接内嵌完整预览**（DocPreview + render-data），无权限给说明；footer 重做；
> 预览内展示归档 PDF 版本链（files API 的 version/is_current/supersedes）；顶栏右侧头像删除，
> 侧栏底部加账号卡 + 个人信息弹窗（只读，后端无资料修改接口）。mock 补 render-data 样板数据。
> 证据：`docs/ui-redesign/phase4/`；门禁：typecheck 0 / lint 0 err 86 warn / vitest 455 / e2e 23+4=27 / build out/268。
> 详见方案文档 §0.3。
>
> **（2026-10-20 · 单证签发后自动上传）**
> 业务口径统一叫「上传单证」（不再叫归档；内部文件角色仍是 `render_pdf(_superseded)`）。
> Web UI 签发成功即自动 `render-data → renderTradeDoc → POST /trade-docs/{id}/pdf` 上传（版本让位沿用
> `render_pdf_superseded`）；手动上传/导入入口保留用于渲染器不可用、第三方单据、历史补档。
> 边界：直接走 API/其他客户端签发不会自动上传（HTML 模板在前端），服务端兜底需跨栈改造，已登记待办。
> mock 的 `/pdf` 返回 503，前端提示手动上传、不假装成功。
> 证据：`frontend/src/lib/trade-doc/auto-archive.ts` + 3 条单测；门禁：typecheck 0 / lint 86 warn / vitest 458 / e2e 23+4 / build out/268。
> 详见方案文档 §0.4。
>
> **（2026-10-20 · 后续 UI 路线已登记）**
> 剩余工作盘点 + 批次安排写入方案文档 §9（P0-A 页头/状态/颜色/loading 收编；P0-B 仪表盘/报价/订单/单证/产品模板化；
> P0-C a11y/1366；P1/P2 后续；后端依赖单列）。已删除未引用的 `customer-records-tree.tsx`。
> 下一步从 P0-A 开始，按批跑门禁/截图/文档/push。
>
> **（2026-10-20 · 报价工位重构第一阶段）**
> 报价页统一 `PageHeader`；产品报价改双栏工作台（左：整单参数摘要+产品行；右：sticky 整单汇总/单证/保存/签发），
> 整单参数默认收起、保留原字段与校验；删除工作台内部重复 h1；规格选择 1440/1366 改 3 列。
> 未改算价/接口/字段/tab 深链；e2e 通过。第二阶段：产品行紧凑化（算完自动收起为摘要行）已落，
> 批量报价已选摘要+骨架+空态、报价记录表格骨架+空态已落；成本历史补 mock 矩阵，tab 不再卡加载；
> 仪表盘 6 卡已按“业务指标 2 / 系统运行 4”分组并去掉纯文本加载态。窄屏吸底待做。
>
> **（2026-10-20 · P0-A 页头收编完成）**
> 手写 `<h1>` 清零：billing / intel / market-view / products / spec-config / spec-config wizard /
> pricing-data / admin gray-release / admin spec-proposals / onboarding 全部改 `PageHeader`；
> gray-release、spec-config、pricing 表格的“加载中…”改骨架屏。e2e/typecheck/lint/test 通过。
>
> **（2026-10-20 · P0 订单/单证加载与表头收编）**
> orders 列表、trade-docs 台账的“加载中…”改骨架行；两页表头补 `scope="col"`（空勾选列表头加 sr-only）；
> 两页已无硬编码红绿黄。e2e/typecheck/lint/test 通过。
>
> **（2026-10-20 · P0-C 可访问性/1366 第一批）**
> `TableHead` 默认 `scope="col"`（全站表头一次覆盖）；事件/报价/出货/贸易统计等 icon-only 按钮补
> `aria-label`；移除 viewport `maximumScale:1`；globals 补 `prefers-reduced-motion`；
> 1366×768 抽查 dashboard/quotes/customers/orders/trade-docs/products/settings 无横向溢出。
>
> **（2026-10-20 · 报价重构第二阶段收尾）**
> 产品行算完自动收起；批量报价/报价记录/成本历史骨架与空态统一；<xl 底部吸底动作条
> （总额/产品行 + 保存/单证/签发）已落，xl 起隐藏；报价工位重构完成。
>
> **（2026-10-20 · P1 首批：事件/操作日志/设置/团队加载态）**
> 事件列表、操作日志的“加载中/暂无”改为骨架 + `EmptyState`；设置页租户/平台账号、
> 团队页成员/邀请/工位面板的“加载中…”全部改骨架。e2e/typecheck/lint/test 通过。
>
> **（2026-10-20 · P1 第二批：intel / shipments）**
> intel 内部 4 个 tab 从手写 border-b-2 收编到统一 `Tabs`（keepMounted=false 行为不变）；
> shipments 列表加载改骨架、表头补 `scope`；intel 货运表格空态改 `EmptyState`。
> 证据：`docs/ui-redesign/phase5/`；详见方案文档 §10。
>
> **（2026-10-20 · P2 首批：筛选条件记忆）**
> 新增 `usePersistentState`（localStorage；挂载后恢复、避免 SSR hydration mismatch）；
> 事件审计、操作日志的筛选条件刷新/切换页面后保留。其余 P2（列配置/密度/快捷键）待做。
>
> **（2026-10-20 · P2 密度切换 + 后端依赖方案）**
> 订单列表新增「舒适/紧凑」密度切换（localStorage 记忆，只改行高/字号，不改列含义）；
> 后端依赖项（服务端自动上传、单证内容版本、个人信息编辑、询盘状态机、报价/订单 1:N 约束）
> 已单独整理为 `docs/UI_BACKEND_DEPENDENCIES_2026-10-20.md`，含现状/建议方案/验收/顺序。
>
> **（2026-10-20 · P2 列配置）**
> 订单列表新增「列配置」：只隐藏现有 7 列、默认全显、至少保留 1 列；偏好 localStorage 记忆。
> 证据：`docs/ui-redesign/phase5/orders-column-config.png`。
>
> **（2026-10-20 · P2 客户搜索快捷键）**
> 客户管理支持 `/` 聚焦搜索、Esc 退出（输入框/可编辑区不劫持）；占位文案与 `aria-keyshortcuts` 同步。
>
> **（2026-10-20 · P2 tab 收编与语义色）**
> spec-proposals / market-view / research 三处手写 border-b-2 tab 收编到统一 `Tabs`；
> spec-proposals 加载/空态改骨架+`EmptyState`；research 供应能力图标改 `text-success/text-destructive`。
>
> **（2026-10-20 · P2 语义色清零）**
> 全站 `app/(app)` 里 `text-red/green/amber/emerald-*`、`bg-*-100` 等硬编码色清零（原 13 文件 23 处），
> 统一改 `success/warning/destructive` 语义 token（含暗色取值）。
>
> **（2026-10-20 · P0 数据区加载态收尾）**
> 新增共享 `LoadingBlock`；audit-timeline、客户详情、market、products 定义/图片、报价订单记录、
> 企业抬头/公章、税务管理、盖章回传的“加载中…”改骨架。剩余纯文本仅为图片/按钮内联状态，
> 属正常反馈，不再是整块数据区占位。
>
> **（2026-10-20 · 终验：§8.4 清单 + DOM 审核）**
> 1366 实测：10 个页面每页 h1=1、无未声明 scope 的表头、icon-only 按钮无可访问名=0、无横向溢出；
> 源码手写 h1=0、硬编码红绿黄=0、业务页手写 tab=0。修复产品页图片 tab 重复 PageHeader、
> products 手写 `<th>` 补 scope。详细结论见方案文档 §11。
> 对比度抽查 8 个核心页无真实失败（头像白字为渐变背景误报）；核心路线图完成，
> 可选 P2（窄屏卡片化/暗色令牌校准）与后端 5 项单独留档。
>
> **（2026-10-20 · 新会话接手核对：本地 main 同步 + 分支残留清理 + 生产 secrets 实测 + 本机工具链）**
>
> 1. **本地 main 已快进到 `fb4b2aa`**（此前落后 origin/main 33 个提交 —— 本地曾停在 10-19 下午的
>    `4b156fc`，任何按本地 HEAD 做的判断都已过时；最新交接 = `HANDOVER_2026-10-20.md`）。
> 2. **残留分支清理**：`docs/plan-b-handoff`、`feat/plan-b-single-worker`（远端已删、内容被 main 覆盖，
>    后者唯一提交是更旧版 PLAN_B_EVALUATION）—— 本地 worktree 与分支已删（用户裁决）。
>    **`feat/convergence-aprime` 保留**（含决策 1 明令不得合并的 PPG 改动：wrangler 切 PPG +
>    `scripts/migrate-ppg/`；其 3 项可用改动已由 `88132af` 收编）。远端 `prisma-cloud/setup` 已被他人删除。
> 3. **生产 Worker secrets 实测缺 `RESEND_API_KEY`**（期望 5 个，实测 4 个）⇒ 生产「忘记密码」邮件
>    静默不发。key 已由用户提供（对应已验证域名 `send.powervoy.com`），暂存本机 `.env.local`（gitignored）。
>    **用户裁决：当前不进生产，发布窗口随部署一起补**（实测直接 `wrangler secret put` 因版本管理
>    被拦、生产零改动）。已登记 `USER_ACTIONS` **U-B5** + `HANDOVER_2026-10-20.md` §7 检查单第 2 步；
>    同窗口可顺带（需单独批准）Hyperdrive `--caching-disabled`（10-18 起挂账，"新建客户 60s 旧读"根因）。
> 4. **本机工具链补齐（2026-10-20）**：Docker Desktop 4.96 / 引擎 29.9.1 / compose v5.6.0 **已可用**
>    （曾因 WSL 3.0.3 更新中断起不来，已恢复）；pnpm **12.14.0** 已装并入 PATH
>    （`C:\Users\河北慷逊公司\AppData\Roaming\npm`）；gh CLI **v2.102.0** 已装并入 PATH
>    （`D:\tools\gh-cli\bin`，**未登录** ⇒ GitHub secrets/billing/可见性仍需你 `gh auth login` 或网页操作）。
>    ⚠️ 本会话 shell 的 PATH 是会话启动时的快照 ⇒ 本会话内一律用绝对路径调用上述工具。
> 5. **GitHub 侧已对账（2026-10-20，gh 已登录 dsun-io）**：仓库可见性 = **private** ✅（U-S2 关闭）；
>    Actions 开关 enabled 但**最近 3 次 push 触发的 CI 全部失败 = billing 限额**（job 未启动，
>    "recent account payments have failed"）⇒ U-B4 仍待你处理账单；repo secrets **只有 2 个**
>    （`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`，2026-09-22）⇒ **无 `PROD_DATABASE_URL`**
>    （U-S7 确认未配，deploy 自动迁移仍会跳过）、**无 S5 预览所需的 `NEON_API_KEY`/`NEON_PROJECT_ID`**。
> 6. **本地环境验收门禁（2026-10-20，Docker PG 真跑）**：orchestrator **222 passed** ✅；
>    worker **959 passed / 0 failed** ✅（含真 PG 集成 5 条，用 `kaas_worker_test` 库）；静态断言
>    check-runtime-deps / check-schema-coverage **PASS**，check-schema-drift **PASS**（列漂移 0；
>    ⚠️ 该脚本在 GBK 控制台会因 ⚠️ 字符 UnicodeEncodeError 崩溃 ⇒ **必须 `PYTHONIOENCODING=utf-8` 跑**）、
>    sync-shared **PASS**。中途抓到一个真问题：**worker 的 kaas_common 镜像（gitignored 产物）过期**
>    ⇒ 16 条内核/parity 测试红，跑 `scripts/sync-shared.ps1` 后转绿 —— 教训：镜像产物不随仓库走，
>    **换设备/新检出后跑测试前必须先 sync-shared**（已在本文件留痕）。
> 7. **本地 MinIO 镜像源变更（2026-10-20）**：官方 `minio/minio` **已从 Docker Hub 下架**
>    （pull 报 repository does not exist，非网络问题）⇒ `docker-compose.yml` 改用第三方打包官方二进制的
>    `elestio/minio:latest`（实测 minio RELEASE.2025-09-07 + mc 均可用；备选 `cleanstart/minio`）。
>    开发默认存储口径不变（仍是本地 MinIO，桶 `kaas-dev`），仅镜像来源变。恢复官方源：Hub 上架后改回。
> 8. **pnpm 12 供应链冷却放宽（2026-10-20 用户裁决）**：pnpm 12.14.0 内置 `minimumReleaseAge`（默认拒装
>    发布未满 24h 的包），会把 lockfile 里的 `ignore@7.0.13`（10-20 升级引入）卡死**所有新设备的
>    pnpm install**（本机 npmrc / CLI 均无法覆盖，唯一生效位置 = `pnpm-workspace.yaml` 顶层键）。
>    用户裁决放宽 ⇒ `pnpm-workspace.yaml` 加 `minimumReleaseAge: 0`（含理由与代价注释）。
>    lockfile 指纹未变（298c4b4…）。代价留痕：未来 add/update 无 24h 冷却保护。
> 9. **前端门禁复跑全 PASS（2026-10-20，修复 install 后）**：install ✅（目标栈确认 Next 16.4.2 /
>    React 19.3.1 / ESLint 10.13 / TS 6.0.3）、typecheck 0 error ✅、lint **0 err / 91 warn**（与基线一致）✅、
>    test **455 passed** ✅、contracts:check R0–R5 全 PASS ✅、e2e **23 passed + 4 skipped** ✅
>    （前置探针已按 Turbopack 口径更正进 AGENTS.md）、NEXT_EXPORT 构建 **out/ 267 文件**（与基线一致）✅。
>    **本地环境全量验收结论：后端 + 前端门禁全部与 2026-10-20 基线对齐，本地开发环境可用。**
> 10. **用户出手事项大收口（2026-10-20 第二轮，详见 USER_ACTIONS 第二轮裁决表）**：
>    repo secrets 已配 3 个（`PROD_DATABASE_URL`/`NEON_API_KEY`/`NEON_PROJECT_ID`，gh 代写）；R2 新密钥
>    实测有效但 `secret put` 被版本管理拦截 ⇒ **与 RESEND_API_KEY 同批挂到发布窗口**；仓库已**临时转
>    public**（解决 Actions billing，U-B4 ✅）⇒ git 历史 Notion 令牌随之公开（U-S1 维持不轮换，
>    **用完尽快转回 private**）；Neon production 已设 Protected（U-S5 ✅）；Rate Limiting 用户自配中（U-S4）；
>    **U-B2 税率数据暂缓**（生产实测 0 条产品，随上架配置）；S5 预览凭据基本就绪（CF token 权限验证
>    排到 S5 首个 workflow）。
> 11. **S5 预览环境全量落地（2026-10-20，`18ae386`，已评审合并进 main）**：
>    共享预览资源已建（R2 `kaas-preview-storage` + KV `KAAS_PREVIEW` id `c77ab8c9…974`）；
>    `scripts/preview/` 五脚本（preflight/ensure/render/assert/teardown，纯标准库、幂等、dry-run、
>    全链路本机实测：ensure 建分支+Hyperdrive → teardown 全回收，生产双保险拒删校验阳性对照过）；
>    `kaas_common.preview` 前缀规则（R2 `pr-<num>/`、KV `pr-<num>:`，PR_SLUG 空=生产零影响）+
>    worker 三处 key 生成点接线 + /health 预览探针；`.github/workflows/preview.yml` 全链路
>    （preflight→ensure→migrate→build→deploy→评论；closed→teardown）；S5-d 防污染断言落地
>    （preview 部署前后 + deploy.yml 生产侧，**对照线上真实绑定**，生产模式已对现网 `kaas` 阳性对照通过）。
>    **lead 评审留痕**：diff 泄密扫描无命中；teardown 只按严格名匹配动预览资源；合并后本地复跑
>    orchestrator 247 / worker 960+5 / 静态断言全 PASS（镜像过期按既定教训 sync-shared 修复）。
>    **已配**：repo **variables** ×4（`KAAS_PREVIEW_KV_NAMESPACE_ID` / `KAAS_PREVIEW_R2_BUCKET` /
>    `PROD_R2_BUCKET=kaas-files` / `PROD_HYPERDRIVE_ID=f53fed49…`，gh 代配）；五权限 CF token 已换
>    （`CLOUDFLARE_API_TOKEN` 2026-10-20 更新，preflight 四项 Account 权限断言兜着）；
>    **预览 secrets 独立方案已落地（用户裁决 A）**：`JWT_SECRET`/`ADMIN_SETUP_TOKEN` 为预览专用的
>    随机独立值（2026-10-20 入 repo secrets，生产值不受影响）⇒ **预览站登录可用**；
>    预览桶专用 S3 token 无 API（实测 404 No route），要开预览文件功能需 Dashboard 手动建
>    （R2 → Manage R2 API Tokens → 限 `kaas-preview-storage`，可选）；RESEND 预览按方案跳过。
>    **✅ 已补（2026-10-20）**：用户建 `kaas-preview-storage-rw` token，双向验签通过
>    （预览桶可读、生产桶 AccessDenied）⇒ 入 repo secrets（`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_ENDPOINT`，
>    只被 preview.yml 注入预览 worker + teardown 清理用，生产 worker 不碰）。**预览环境功能全集齐**
>    （登录/文件/清理全自动；仅发邮件按方案跳过）。repo secrets 共 11 个。
>    **待首次真实 PR 验证**：preview.yml 端到端（CF token preflight 是首道关）；预览 worker secrets
>    （JWT_SECRET 等）repo secrets 有则注入、无则告警不阻塞——预览登录体验取决于此（要不要补进
>    repo secrets 待用户拍板）。生产桶仍 `kaas-files`，改名 `kaas-prod-storage` 另立项（不动 S5）。
>    详见 `scripts/preview/README.md` 与 `docs/ENV_VERIFICATION_2026-10-19.md` §2。
> 12. **同日收口杂项（2026-10-20）**：① **Rate Limiting ✅（U-S4）**：免费套餐仅支持 10s 窗口，
>    落地为登录/注册 **2 req/10s/IP**（≈12/min，非原建议 5/min），实测 401→401→429×4 生效；
>    ② CI 静态门禁脚本路径修复（`../scripts` → `../../scripts`，billing 冻结期 CI 从未真跑才暴露，
>    `555cc15`）；③ Neon Protected = **付费功能**，Free 套餐不可用 ⇒ 用户裁决**不升级**，预览脚本
>    删分支双保险兜底（README §2.2 已标注）；④ 仓库仍**临时 public**，CI 稳定后尽快转回 private。
> 13. **main 的 CI 自 billing 冻结以来首次全绿（2026-10-20，run `39364936582`）**：修了两枚
>    "从未真跑过"的 CI 欠账（门禁脚本路径 `555cc15` + `psql -vc` 拆词 `91b010c`）后，
>    **backend:test 三 job 全绿**（迁移/模型+静态门禁 17s / worker:integration 真 PG 54s /
>    worker:tests 63s），`contracts:check` 绿（S5 合并推送自动触发）。这是 S4 之后 33+ 个提交
>    首次完整过 CI。遗留观察项：actions/checkout@v4、setup-uv@v5 有 Node 20 弃用告警
>    （被强制跑在 Node 24， cosmetic），后续随依赖升级顺手处理。
>
> **（2026-10-19 晚场 · 四项决策全部已确认 —— 以下为当前口径，压过本摘要内所有旧条目）**
>
> 1. **决策 1 · 生产库回 Neon、放弃 PPg**：PPg 10 连接上限 + 不支持扩展 = 结构性阻塞；
>    Neon 免费层 1 GB / 100 CU-hours / 10 分支。生产 Hyperdrive 指向 Neon 生产分支，
>    **本摘要中所有"P1 迁库 / PPG / Hyperdrive 1733fcd8"条目全部作废**（含
>    `feat/convergence-aprime` 分支的 PPG 改动，不得合并）。
> 2. **决策 2 · 路线 A 已否决不得复活**（greenlet 无 wasm + 冷启动 +1854ms，证据 POC 文档）。
> 3. **决策 3 · 双后端优化采用方案 B**（B-可行 + 三项已确认修正：冷启动 ≤2,950ms /
>    uvicorn 日常 + wrangler dev 冒烟双入口 / 测试 27% 重写 + 87 归位 + ~1,085 保留）。
> 4. **决策 4 · 三环境资源隔离矩阵 + 10 条硬规则**（原样见 README §2；开发默认 =
>    本地 Docker PG + 本地 MinIO，不触云）。早场"恢复三层环境模型"条目（见本摘要下方 10-19 晚场前
>    条目）由本矩阵**细化取代**：预览改为每 PR 独立 Neon 子分支，另有"开发远程冒烟"第四列。
>
> **最新交接文档：`README.md`（主交接，唯一权威）**；执行入口 `docs/MASTER_EXEC_PLAN_2026-10-19.md`。
> 2026-10-19 当日交接：`docs/archive/2026-10-20-closeout/HANDOVER_2026-10-19_CI_AND_PROD_FIXES.md`（✅ 已完成：注册 500 / 定价页白屏已修并部署；
> CI `backend:test` db-tests 已修绿 `6c08900`；含「本机无 Postgres ⇒ 本地 db 测试全 skip」等环境坑与「不要重做」清单）；
> `docs/archive/2026-10-20-closeout/HANDOVER_2026-10-19_P1_PPG_MIGRATION.md`（❌ 已废弃，决策 1 回 Neon）。
> 上一份：`docs/archive/2026-10-20-closeout/HANDOVER_2026-10-18.md`（历史，顶部已加更正横幅）；更早 `docs/archive/2026-10-20-closeout/HANDOVER_2026-10-17.md`。
>
> **（2026-10-20 · 前端技术栈升级完成 + 全量回归 + 交接文档）**
> 1. **技术栈全量升级完成**（`9e13ef5`，独立 worktree 后 ff 合并）：Next **16.4.2** / React **19.3** /
>    ESLint **10.13（flat config，`next lint` 已删）** / TS **6.0.3** / eslint-config-next 16.4 /
>    @typescript-eslint 8.71 / @types/react 19 / @types/node 22；根 lint-staged 同步 ESLint 10。
>    迁移：`middleware.ts`→`proxy.ts`、`typedRoutes` 顶层化、Sentry `onRouterTransitionStart`、
>    `typecheck` 内置 `next typegen`（干净 checkout 必需；旧 tsbuildinfo 会误报 `Viewport`）。
> 2. **安全复扫**：`pnpm audit`（官方 registry）80 → **39 条，critical 2→0**；3 high 全为 dev-only
>    （wrangler→sharp / shadcn→MCP SDK / micromatch→braces 无补丁），已更新 workspace overrides。
> 3. **全量回归（2026-10-20 main 实测）**：worker **954 passed+5 skipped**（真 PG 集成 **5**）；
>    orchestrator **222**；前端 typecheck ✅ / lint **0 error（91 warning）** / **455 passed** /
>    e2e **23 passed+4 skipped** / `NEXT_EXPORT` 构建 **out 267 文件**；contracts:check PASS；
>    sync-shared/schema 双门禁/依赖断言 全 PASS；生产只读冒烟 **200**。
> 4. **交接文档**：新增 `docs/HANDOVER_2026-10-20.md`（本轮改动/证据/待用户事项/发布检查单/已知限制）；
>    `USER_ACTIONS_2026-10-19.md` 增加 S5 前置凭据清单与冷启动测量项（U-E4）；
>    `TECH_STACK_UPGRADE_2026-10-17.md` 追加批次 B 执行记录；README/AGENTS 同步新版本与新命令。
> 5. **待用户**：S5 凭据/资源、冷启动测量、R2 密钥、税率数据、仓库 billing、发布窗口
>    （详见交接文档 §6）。代码侧可自主项已全部完成。
>    **已裁决关闭（无需操作）**：Notion 令牌（U-S1，不清理）、智能表格 21 行缺失输入（U-B3，不用补，
>    2026-10-20）。
>
> **（2026-10-20 · 用户裁决四项 · 下一轮范围确定）**
> 1. **S5 预览 = 全量做（A）**：每 PR Neon 子分支 + 独立 Hyperdrive + `kaas-preview-storage` +
>    KV 前缀 + CI 防污染断言。前置：用户提供 Neon API key / Cloudflare API token（或代建资源）。
> 2. **技术栈 = 下一轮全量升级（A）**：Next 15.5+/16（2 critical RCE）+ ESLint 10 + TS 6，
>    配 typecheck/lint/test/e2e/build 全量回归；CI Node 22 已完成。
> 3. **发布 = 先不发布（A）**：等 S5 + 升级完成后再定窗口；部署保持冻结。
> 4. **`internal` 权限 = 维持平台运营专属（A）**：6 个 `/admin/*` 端点鉴权 + `test_admin_authz.py` 为最终口径。
> 留痕：`docs/USER_ACTIONS_2026-10-19.md` 顶部裁决表。
>
> **（2026-10-19 夜场 · S6-c 门禁 + 降级链实测 + 生产只读冒烟 + 三环境/用户动作成文）**
> 1. **S6-c 包体积/冷启动门禁落地**：`scripts/check-worker-bundle.py`（pywrangler dry-run 统计
>    bundle，64 MiB 硬限 / 15 MiB 目标；冷启动读 `coldstart-baseline.json` 校验 ≤2,950ms，缺失
>    PENDING），已接入 CI worker job。本机 uv 0.11 的 pyodide 探针损坏 ⇒ 本地 SKIP；CI 最新 uv 可跑。
> 2. **降级链实测（审计之外）**：一次性空库上跑 downgrade，抓到并修复 **2 个真 bug**：
>    ① `202610180004.downgrade` 原为 `pass` ⇒ 降到 002 时 `idx_product_cost_history_spec` 不存在；
>    已改为按 002 形态重建表+索引；② `202610180002.downgrade` 改 IF EXISTS（容忍历史手工漂移）。
>    实测 `downgrade 002` → 索引齐全 → `upgrade head` 成功；`downgrade -1` 往返成功。
>    全链 `downgrade base` 仍在 `202610170004`（cust_customers 历史断点）失败 → **定稿策略：
>    回滚用 Neon PITR/分支，不用 downgrade base**；CI 加「最新迁移可逆」门禁。证据已补进
>    `docs/MIGRATION_DOWNGRADE_AUDIT_2026-10-19.md` 实测节。
> 3. **生产只读冒烟**：`GET https://api.kaas.powervoy.com/health` → 200（core loaded=true）；
>    `https://kaas.powervoy.com/` → 200。生产 Neon 只读连接此前已验证；迁移 head 仍 `202610180010`
>    （020 幂等待应用）。
> 4. **三环境核对成文**：新增 `docs/ENV_VERIFICATION_2026-10-19.md`（开发 ✅ / 预览 ❌ S5 待决策 /
>    生产 ⚠️ 只读通过、密钥与迁移待用户）+ 发布前检查单与回滚预案。
> 5. **用户动作清单成文**：新增 `docs/USER_ACTIONS_2026-10-19.md`（安全 8 项 + 业务 4 项 + 环境决策
>    3 项，逐项含步骤/验证/状态），覆盖 SECURITY_AUDIT §6.4 全部事项与批次 U 的 U-1..U-4。
> 6. **CI Node 22** 已落地（frontend-ci / deploy / contracts-check 的 setup-node 20→22）。
> 7. 待用户决策：**S5 预览范围（U-E1）**、**Next/ESLint/TS 升级排期（U-E2）**、**发布窗口（U-E3）**。
>
> **（2026-10-19 夜场 · S4 单应用收口完成：删壳 + 真源归位 + CI 改造）**
> 1. **删除 orchestrator 业务壳**：`app/{api,core,deps,domain,jobs,middleware,repositories,schemas,services}`
>    + `main.py` + `config` + `db/session.py` + `scripts/` + `Dockerfile`；目录只剩 `app/db`（模型）+
>    `alembic/`（迁移链）+ 222 条测试。本地/生产都跑 `backend/worker/src/main.py`
>    （本地入口 `local_run.py`，已真实冒烟）。
> 2. **真源迁入共享内核**：报价引擎 → `backend/kaas_common/export_quote/`；
>    `enums/workstations/schema_registry` → `backend/kaas_common/domain/`；
>    `sync-shared.ps1` 改为 kaas_common 三段镜像（37+20+1），worker 镜像重建一致。
> 3. **契约/门禁改造**：冻结快照 `backend/contracts_frozen/`（R1/R5 继续校验）；
>    contracts **R6 openapi 新鲜度退役**（HEAD 无 app 即 INFO 跳过，artifact 冻结）；
>    route-parity 与 export_openapi 移入 `scripts/archive/`（含退役说明）；前端 Tenant 统一
>    `display_name`，R5 已知偏差 0 侧。
> 4. **测试处置**（[docs/S4_TEST_MIGRATION_2026-10-19.md](./S4_TEST_MIGRATION_2026-10-19.md)）：
>    1,220 → **222 保留**；**15 个报价引擎测试文件迁 worker**（+364 条，断言零改动）；
>    worker 全量 **954 passed + 5 skipped**；真 PG 集成 5 passed；orchestrator 222 passed。
> 5. **CI/deploy**：orchestrator 主依赖清空 + `[project.optional-dependencies].migrations`；
>    `backend:test` 重整（迁移测试 + schema 双门禁 + 依赖断言，删 route-parity/DB 旧 job）；
>    `deploy.yml` migrate 用 `uv run --extra migrations alembic …`；本地 Docker 改用
>    `backend/worker/Dockerfile.local`（compose backend 跑 `local_run.py`，端口 8000 不变）。
> 6. 验证：runtime 依赖 / 表级 + 列级 schema / sync-shared / contracts 全 PASS；前端
>    typecheck + **455 passed**；`docker build` 本地镜像构建成功（smoke 见构建记录）。
> 7. **未做（下一轮）**：S5 preview 环境（需用户决策 Neon 分支/Hyperdrive 预览）、S6-c
>    包体积/冷启动断言、批次 6 技术栈债、最终全量回归（e2e/prod 冒烟/三环境核对）。
>
> **（2026-10-19 夜场 · S3 行为对等三域清零：auth / CRM / 报价订单）**
> 1. teammate crm-diffs 收尾 11 条 CRM 差异：page_size≤200、列表按 `updated_at` 排序、
>    `stage:null`→active、新建客户写「新建客户」阶段日志、联系人 7 键 / 阶段日志 5 键（LIMIT 50）/
>    询盘 11 键投影、`?country=` 参数删除（前端无消费方）、PATCH 联系人响应同族投影。
> 2. **CRM-23 `inquiry_no_editable` 保留**为「有意差异」：前端 `customers/page.tsx:90,1060`
>    用它控制编号可编辑/锁号，不能为 parity 删前端依赖；测试改为普通「有意差异」用例。
> 3. **三域 parity 棘轮全部归零**：worker 全量 **590 passed + 5 skipped + 0 failed + 0 xfailed**
>    （collect 595 = 590+5 自洽）；真 PG 集成 5 passed；orchestrator 1220 passed；前端 typecheck/lint 绿、
>    **455 passed**（首轮 1 条 OSS 上传网络用例 flaky，复跑全绿）。
> 4. 遗留（不阻塞）：`row_to_contact`/`row_to_stage_log` 尚未收敛进 `kaas_common`（现为 worker 本地投影，
>    键集注释指向 orchestrator 行号）。
>
> **（2026-10-19 夜场 · S6-e 列级漂移门禁：又抓出 3 处真实缺列）**
> 1. 新增 `scripts/check-schema-drift.py`：拿**生产列快照**（`scripts/prod-schema-columns.json`，
>    由 `dump-prod-schema-columns.py` 只读导出，109 张表）比对 ORM metadata，缺列/缺表即 FAIL；
>    生产独有历史表登记在 `scripts/schema-drift-allowlist.txt`（13 张，逐条写原因）；已接入 `backend-test.yml`。
> 2. 门禁落地即抓出 **3 处真实缺列**（此前表级门禁查不出）：
>    · `tenant_workstation_products.team_id`（已在 dd21eba 修）
>    · `trade_docs.owner_id` / `owner_scope`、`market_ports.created_at` / `updated_at`
>      ⇒ 全新库的 worker 单证/港口查询必 500。
> 3. 补幂等迁移 `202610190020_backfill_prod_columns`（`DO $$ IF NOT EXISTS` 加列）：
>    生产**已有**这些列（`alembic_version=202610180010` 未变，已验证未被误升级），
>    迁移在 deploy 的 migrate 作业里会安全跳过；本地 `kaas_local` 升级后 `alembic check` 绿。
> 4. 对比结论：生产 109 表 / 模型 101 表；生产独有 13 张已全部登记；列漂移 **0**；
>    模型多出 5 张 `order_quote_refs`/`trade_doc_*_refs`（生产已改名 `_legacy` 留档，代码不读写）
>    —— 只警告，S4 清理时一并删模型。
>
> **（2026-10-19 夜场 · 报价订单域 26 项对等清零 + 门禁误报修复）**
> 1. teammate quote-diffs 把报价/订单域 **26 条差异全部清零**（`test_parity_quote.py` 120 passed / 0 xfail）：
>    401 结构化体、`closed` 枚举、分页/天数 `Query` 边界、建报价错误优先级、行项 6 个覆盖字段、
>    订单 PATCH 6 条款/换客户、付款计划 type/ratio/amount/status、订单详情三关联块、
>    共享序列化投影（订单行项/付款计划/应收）、算价鉴权依赖、`is_tenant_admin`、`SpecUpstreamChanged` 409。
> 2. worker 全量 **580 passed + 5 skipped + 11 xfailed**（剩余 11 条全在 CRM，task-7 crm-diffs 收尾中）；
>    真 PG 集成 5 passed；orchestrator **1220 passed**。
> 3. `scripts/check-schema-coverage.py` 修掉「注释里的 SQL 片段被当表名」误报（`UPDATE due_date/notes` 文案）。
> 4. 明确 defer：`dbjson.py` 补 `quote_order_items` 的 `policy_override`/`cost_breakdown` jsonb 映射；
>    订单 PATCH「同时标记 paid」时 due_date/notes 与 orchestrator 的细微差异（不在 26 条清单内）。
>
> **（2026-10-19 夜场 · S4 本地入口落地 + 冒烟抓出列级 schema 漂移）**
> 1. 新增 `backend/worker/src/local_run.py`：uvicorn 起**生产同一份** `main.py`（workers stub +
>    `request.scope["env"]`/HYPERDRIVE 指向本地 Docker PG）；踩掉的坑：脚本目录会自动进 `sys.path[0]`，
>    而 `src/platform/` 是 worker 连接封装、会遮蔽标准库 `platform` ⇒ asyncpg 导入即 AttributeError，
>    已在入口里先移出再导入标准库。
> 2. 全新空库 `kaas_local`（`alembic upgrade head`，102 张表）冒烟全绿：health / bootstrap-admin /
>    login / 建客户 201 / 报价·订单·应收列表 / `export-quote/products` 200。
> 3. **抓出真实列级漂移**：`tenant_workstation_products` 生产有 `team_id`（迁移 202610110019，带 FK + 索引 +
>    `COALESCE(team_id,0)` 函数唯一键），但 ORM 模型没写 ⇒ 空库快径缺列 ⇒ `export-quote/products` 500。
>    已补模型（列/FK/索引 + 函数唯一键），新增 `tests/test_team_scope_schema_parity.py` 3 条回归；
>    重放空库后 `alembic check` = no new operations，`ON CONFLICT (tenant_id,(COALESCE(team_id,0)),…)` 实测可用。
> 4. 门禁：orchestrator **1220 passed**。教训：S6-a 的表级门禁查不出**列/索引**漂移，S6 待补列级断言。
>
> **（2026-10-19 夜场 · S3 高危修复：CRM 写权限/联系人清空 + 报价 2 个 P0）**
> 1. **CRM 写权限（高）**：`DELETE /customers/{id}`、`PATCH .../stage`、`POST .../inquiries`、联系人增删改
>    统一走 `_check_write_access`（共享内核 `scope.can_write`）⇒ 同团队非属主 **403 NOT_OWNER**。
> 2. **联系人**：PATCH 改为「仅更新显式给出的字段」⇒ **显式 null 可清空**（旧 COALESCE 静默失败）；
>    新增/更新 `is_primary` 时先清其它主联系人；联系人不存在 → **404 CONTACT_NOT_FOUND**（不再恒 204/字符串 body）。
> 3. **询盘**：channel / owner_scope 走共享枚举校验；status **恒写 unquoted**（忽略伪造值）；
>    落 `lead_id`（线索池→询盘转化链恢复）；body **不再要求 customer_id**（orchestrator 同契约）。
> 4. **报价 2 个 P0**：应收列表补归属过滤（越权读全部应收已堵）；签发入账 `customer_id` 显式 `str`
>    （TEXT 列，修 draft→sent 的 DataError 隐患）。
> 5. parity 棘轮：CRM **23 → 11**、报价 **28 → 26**（其余按档排期）；worker 全量
>    **554 passed + 5 skipped + 37 xfailed**；真 PG 集成 5 passed；依赖/schema/route-parity/sync-shared 全 PASS。
>
> **（2026-10-19 夜场 · S3 域级 parity 扩展：CRM / 报价订单）**
> 1. 新增 `test_parity_crm.py`（61 例：38 passed + 23 xfail）与 `test_parity_quote.py`（120 例：92 passed + 28 xfail）；
>    worker 全量 **545 passed + 51 xfailed + 0 failed**（本机含真 PG 集成 5 条）。
> 2. **CRM 高危待修**（下一轮首要）：
>    · 写权限缺口：`DELETE /customers/{id}`、`PATCH /customers/{id}/stage`、`POST /customers/{id}/inquiries`
>      在 worker 侧缺 `_check_write_access` ⇒ **同团队非属主可删/改同事客户、替同事客户建询盘**（orchestrator 有校验）
>    · `PATCH contacts` 用 COALESCE ⇒ 显式 `null` 清空字段无效（前端 ContactModal 正是这样清空联系方式，静默失败）
>    · 询盘：不校验 channel 枚举、接受任意 `status` 入库、丢 `lead_id`（线索池→询盘转化链路断）、硬编码 owner_scope
> 3. **报价/订单差异（28 条 xfail）**：401 体形状、`closed` 状态枚举、`customer_id` 类型、错误码优先级、
>    行项覆盖字段缺失、`days` 越界钳位等；按严重度分档修复并摘棘轮。
> 4. **auth 域 parity 已清零**：D1–D3/D7–D13 全修（含扁平响应 D4/D6），集成测试已适配扁平契约。
>
> **（2026-10-19 夜场 · P0 回归修复：手动改编号必 500）**
> 1. 根因：`7b21e1d` 重写共享内核 `kaas_common/workstation/number_rules.py` 时丢了
>    `_NUMBER_RE` / `MAX_LEN` 两个常量，而 `normalize_number()` 仍在引用 ⇒ 任何「手动改编号」
>    请求（询盘 orchestrator:customers.py:757 / worker:ws_crm_ext.py:325；报价 quote_orders.py:814 /
>    quote_api.py:1973；单证 trade_docs.py:632 / main.py:3985）在**两端同时 NameError → 500**。
> 2. 由 CRM parity 审计实测发现（不是推断）；已补回常量 + 新增 `tests/test_number_rules.py` 8 条回归用例；
>    `sync-shared.ps1` 已同步到 worker 镜像（37/20/1 一致）。
> 3. 直接验证：`normalize_number('INQ-1')` / `normalize_number('报价-张工')` 正常返回。
>
> **（2026-10-19 夜场 · 认证/账号域行为对等：8 处 worker 差异已修）**
> 1. 新增 `backend/worker/tests/test_parity_auth.py`（66 条，55 通过 + 差异棘轮）；本轮修复 **8 处**：
>    · bootstrap-admin：缺 Bearer → **401**（原并档 403）；密码 <8 → **422**；邮箱重复 → **409**（预检，原来撞唯一约束 500）
>    · login：邮箱 **strip+lower**；账号禁用改为**密码正确后 403**（原来统一 401）
>    · GET /me：补 **plan / effective_role / tenant_id**（前端 use-role 直接消费；历史 admin→system_admin 映射恢复）
>    · register：`workstations: []` = **零开通**（原当"没传"开全部 9 个）；无 team_name 也校验未知工位 → 422
> 2. 追加修复（同一轮）：D12 邀请码校验先于邮箱查重（坏邀请码 404 优先）、D13 分页越界 → 422
>    （不再静默钳位）。剩余 **2 处**用 `xfail(strict=True)` 棘轮钉住：D4/D6 登录与 bootstrap 响应扁平化
>    （需同步前端与集成断言，留待专门提交）。修好后 XPASS 会强制摘标记。
> 3. 门禁：worker **410 passed + 5 skipped + 4 xfailed**；真 PG 集成 **5 passed**；
>    依赖断言 / schema 完备性 / route-parity / sync-shared 全 PASS。
>
> **（2026-10-19 夜场 · 安全审查完成 + 两个真实安全缺陷修复）**
> 1. 安全审查报告：`docs/SECURITY_AUDIT_2026-10-19.md`（危 2 / 高 4 / 中 7 / 低 8，共 21 条）。
>    结论摘要：**SQL 注入 0 真注入点**（35 个 SQL 插值表达式逐条判定，均为占位符序号/白名单常量）；
>    tenant/team 隔离抽样未发现跨团队读写；Worker 运行时 6 依赖为最小集 ✓。
> 2. **修复 高-1（越权）**：`main.py` 6 个 `/api/v1/admin/*`（feature_flag 读写、tenants 读/reload、
>    audit-log、archive-logs）此前只校验"已登录" ⇒ 任意 customer 可写 feature flag / 读审计日志；
>    现统一 `_require_platform_ops`（internal + 管理员角色）返回 403；新增 `test_admin_authz.py` 5 条用例。
> 3. **处理 危-1（令牌）**：`.codex/config.toml`（含明文 Notion 集成令牌）**已从 git 跟踪移除**
>    （`.gitignore` 本有 `.codex/`，但"先跟踪后忽略"无效）。⚠️ **历史提交仍可读到令牌**；
>    **2026-10-20 用户裁决：不清理**（不吊销、不重写 git 历史）⇒ 危-1 按**风险接受关闭**
>    （留痕见 `SECURITY_AUDIT_2026-10-19.md` 危-1 裁决注记；`USER_ACTIONS` U-S1 已关闭）。
> 4. **需用户操作/未修**（详见报告 §6.4）：生产零限流（建议 Cloudflare Rate Limiting Rules）、
>    仓库可见性确认、生产 Worker secrets 核对、Neon 生产分支 Protected、预览环境与 R2 桶命名决策、
>    Next 升级排期、`internal` 普通业务员的 admin 权限口径。
> 5. 门禁：worker **405 passed + 5 skipped + 11 xfailed**；依赖/schema/route-parity 仍 PASS。
>
> **（2026-10-19 夜场 · CF Cron 重建 2 个定时任务完成）**
> 1. 新增 `backend/worker/src/ws_cron.py`：纯 asyncpg 重建 orchestrator 两个 APScheduler 任务
>    （① 每 15 分钟 replied→询盘扫描；② 每日 events 归档 → R2 `events-archive/YYYY/MM/DD/v{N}.jsonl.gz`，
>    写 `events_archive_log`）；scheduled 无 request 上下文，按 `env.HYPERDRIVE` 同参直连；
>    异常 catch 不抛穿（归档重试 3 次）。
> 2. `main.py` 只加 `Default.scheduled(self, controller, env, ctx)` 钩子 + 末尾 import；`wrangler.jsonc`
>    只加 `triggers.crons`（UTC：`*/15 * * * *`、`30 16 * * *` = 上海 00:30），与代码常量双向锁死。
> 3. 可见性口径决策：转化出的询盘 `owner_scope='private'` + team（与 worker 手动入口
>    `chain.lead_scan_replied` 一致），**不**照抄 orchestrator job 的 `'tenant'`
>    （后者会让同租户其它公司看到别家线索询盘）；已在该文件注释留痕。
> 4. 30 条单测；全量 worker **400 passed + 5 skipped + 11 xfailed**（11 xfail 来自 auth parity 测试，
>    见下条）；schema/依赖门禁 PASS。**crons 要下次部署后才生效**（当前部署冻结）。
>
> **（2026-10-19 夜场 · 独立项：迁移链 downgrade 审计 + allowlist 审计完成）**
> 1. 新增 `scripts/audit-migrations.py`（AST 静态分析）：70 个迁移版本 / head `202610180010`；
>    `upgrade()` 内含破坏性操作的 10 个，其中 `drop_table` **仅 3 个**
>    （drop_conversation_tables / drop_wechat_tables / merge_customers），且 downgrade 均未重建表
>    ⇒ 灾难回滚会丢数据，发布前需冷备。旧口径「70 个里 35 个含 drop_table」失真，已更正。
>    报告：`docs/MIGRATION_DOWNGRADE_AUDIT_2026-10-19.md`。
> 2. route-parity allowlist 8 条逐条复核：补实现位置、更正 comtrade 原因（实为长任务采集器、
>    前端 0 调用，非"本地定时器"）、pointer 改到归档原文；route-parity 仍 PASS（缺失 8 全登记、过期 0）。
>
> **（2026-10-19 夜场 · 部署冻结 · 用户指令）**
> 1. **中途不部署**：`deploy.yml` 已改为仅 `workflow_dispatch`（不再监听 push）；
>    必须等用户明确下达部署指令后才发布。README §16 / DEPLOY.md 顶部已留痕。
> 2. **GitHub Actions 额度已达限额**（用户确认）⇒ CI/部署工作流可能无法启动；
>    最终发布改走**本机 `pywrangler deploy`**（或额度恢复后手动 dispatch）。
> 3. 因此后续 S3/S4 的提交只做「代码 + 文档 + 推送」，**不产生生产部署**；
>    收尾时先做全量回归与安全审查，再由用户确认后发布。
>
> **（2026-10-19 夜场 · 方案 B 阶段二 S3 首项：attribute-proposals 补进 worker）**
> 1. 新增 `backend/worker/src/ws_admin_proposals.py`：与 orchestrator `app/api/admin_proposals.py`
>    同路径 / 同方法 / 同响应键 —— `GET 列表`（可选 `?status=`）、`GET /recommended`、
>    `PATCH /{proposal_id}`（approve 晋升公库属性 / reject / merge）；写操作单事务。
> 2. 鉴权与 orchestrator `require_platform_ops` 对齐：**internal + 管理员角色**，其余 403。
> 3. 12 条 worker 无库单测（鉴权 / 列表过滤与形状 / 推荐 / approve 插属性+回写 / reject /
>    merge / invalid_action / not_found / 事务）；并登记到 `tests/_bootstrap._SIBLING_MODULES`
>    （否则多文件收集时路由注册到旧 app —— 该类问题已在 bootstrap 注释里记录）。
> 4. `route-parity`：缺失 **11 → 8**（allowlist 删 3 行；过期登记 0，仍 PASS）。
> 5. 生产库只读核对：`attribute_proposals`（23 列）/ `spec_attributes`（20 列）所需列全部存在，
>    两表当前 0 行。
> 6. 门禁：worker **315 passed + 5 skipped**；依赖断言 / schema 完备性 / sync-shared 全 PASS。
>
> **（2026-10-19 夜场 · 方案 B 阶段二 S2 完成 —— 迁移归位与 schema 完备性）**
> 1. **部署链迁移**：`deploy.yml` 新增 `migrate` job（`alembic upgrade head` 成功后才部署 Worker）；
>    连接串走 secret `PROD_DATABASE_URL`，未配置时该 job 告警跳过（保持手动迁移现状，配好即自动接管）。
> 2. **schema 完备性门禁**：`scripts/check-schema-coverage.py`（worker SQL 引用的表 ⊆ 空库快径 metadata），
>    已接入 `backend:test`；当前 72 张引用表 / 101 张 metadata / 缺失 0。
> 3. **补齐 8 张 worker 独有/遗留表模型**：`app/db/legacy_models.py`，按生产库真实 DDL 建模
>    （2026-10-19 只读 dump：82 列 / 65 约束 / 23 索引；entity_links 3 行、file_objects 5 行，其余 0）。
>    其中 `product_profiles` 生产库**无主键** → 用 Core Table 表达，DDL 与生产一致。
> 4. **真库验证（本地 Docker PG16 + 生产只读对照）**：
>    · 空库 `alembic upgrade head` → **102 表**（101 metadata + alembic_version）、head `202610180010`；
>    · 8 张遗留表与生产库**逐列/逐索引一致**（类型 / nullable / 默认值全一致）；
>    · `alembic check` = **No new upgrade operations detected**（零漂移）；
>    · worker 真 PG 集成测试 **5 passed**（注册 / bootstrap-admin / 建客户 / 报价写库路径）。
> 5. 已知偏差（留 S4 清理）：生产有 12 张历史表未被 worker / 当前代码引用（conversations、wechat_*、
>    cust_customers、market_product_usage_mappings、`*_refs_legacy` 等）；metadata 有 5 张旧命名表
>    （`order_quote_refs` 等）生产已改名 `_legacy`。
> 6. 门禁：orchestrator **1208 passed / 1 skipped**；worker **303 passed + 5 skipped**（无 PG 时）；
>    依赖断言 PASS；schema 完备性 PASS。
>
> **（2026-10-19 夜场 · 方案 B 阶段二 S1 完成 —— 依赖拆分）**
> 1. **`kaas_common/db.py`**：运行时 asyncpg 事务适配层 —— `Session` + `transaction()`（嵌套自动降级
>    SAVEPOINT，复刻 orchestrator 测试 `create_savepoint` 的回滚隔离语义）+ `execute/fetch/fetchrow/fetchval`
>    + Record→dict；用 Protocol 描述连接、**不 import asyncpg**，共享内核仍只依赖标准库 + pydantic。
>    单测 `tests/test_kaas_common_db.py` 5 条（成功提交 / 异常回滚 / 嵌套 savepoint / 参数委托 / dict 转换）。
> 2. **`scripts/check-runtime-deps.py`**：静态断言运行时不得出现 sqlalchemy / alembic / greenlet / psycopg2
>    （扫描 `kaas_common` + `worker/src` + worker `pyproject.toml`）；已接入 `backend:test` 与 `deploy` 两道 CI。
> 3. 边界固化：`kaas_common/__init__.py` 铁律补充 `db.py` 为例外说明；worker 运行时依赖仍为 6 个。
> 4. 门禁：orchestrator **1205 passed / 1 skipped**；worker **303 passed + 5 skipped**；依赖断言 **PASS**；
>    `sync-shared -Check` **一致（37 文件）**。
> 5. 未完成项（并入后续 S）：S1-d 依赖清单正式拆分（ORM 移除）→ S4；S2 迁移归位 → 下一步。清单见
>    `MASTER_EXEC_PLAN §3「阶段二 S1–S6 执行清单」`。
>
> **（2026-10-19 晚场 · 分支收编 + 文档收尾，已完成）**
> 1. 从废弃的 `feat/convergence-aprime` 收编 **3 项与 PPG 无关**的改动（提交 `88132af`）：
>    `alembic/env.py` 补 5 个模型模块 import（空库快径避免缺表）、`session.py` SSL 判定去 neon 硬编码、
>    worker 真 PG 写入路径测试 5 条 + CI job `worker-db-tests`。PPG 相关的 `wrangler.jsonc` 切换与
>    `scripts/migrate-ppg/` **未收编**（决策 1）。
> 2. 文档收口：README §2.2/§2.3 标注为**目标态**、本文指向改回 README、MASTER_EXEC_PLAN §3 正文改为方案 B、
>    PLAN_B §8 附注去 PPG、docs/README 修断链+补 10-19 索引、AGENTS.md 本机工具链路径更新。
> 3. 清理 4 个无价值远程分支（`feat/plan-b-single-worker` / `docs/plan-b-handoff` /
>    `feat/trade-doc-templates` / `prisma-cloud/setup`），保留 `feat/convergence-aprime` 备查。
> 4. 门禁复跑：orchestrator `-m unit` **1200 passed / 1 skipped**；worker **303 passed + 5 skipped**（本地无 PG）；
>    `route-parity` PASS；`sync-shared -Check` PASS（先跑了一次同步修复本地镜像漂移）。

> **（2026-10-19 峰值时段检查点 · P1 迁库暂停在 70% —— 交接见
> `docs/archive/2026-10-20-closeout/HANDOVER_2026-10-19_P1_PPG_MIGRATION.md`）**
>
> **生产仍跑 Neon，未切换、未部署。** PPG 库已建（`kaas-prod`，PG17.2/us-east-1）、
> schema 已建 114 表、**数据已全量复制且行数 0 不一致**、Hyperdrive 新配置
> `1733fcd…` 已建、分支 `feat/convergence-aprime` 的 `wrangler.jsonc` 已切 id；
> **阻塞项 = schema 漂移未清零**：约束 190/1015（缺 852）、索引 281/313（缺 50）、
> 列属性差 33 处（create_all 快径产物少于生产历史 DDL 累积）。
> 下一步顺序、逐条验收标准、**PPG/Prisma/Cloudflare/Neon 权限获取方式（换设备必看）**、
> 回滚预案全部写在交接文档 §3–§7；迁移脚本在 `scripts/migrate-ppg/`。
> 峰值时段结束、晚间恢复时：从交接文档 §3 第 1 步继续。
>
> **（2026-10-19 · P0 已执行：PPG 库创建 + 空库 schema 根因修复 + 数据迁移）**
>
> 1. **PPG 已创建**（Prisma CLI 非交互：`prisma project create kaas-platform` +
>    `prisma postgres create kaas-prod`）：id `db_xe7ypplcbxq3ysghz93k3n8u`，
>    **PG 17.2 / us-east-1 / ready**。DSN 存于 `.env.local` 的 `DATABASE_URL_PPG`。
>    ⚠️ **Accelerate 停用提示**：`pooled.db.prisma.io`（Accelerate）即将停用 ⇒
>    迁移与运行时一律用**直连 `db.prisma.io`**；Hyperdrive 负责池化。
> 2. **空库建表根因已修**：`alembic/env.py` 只 import `models`+`tax_models`，漏
>    `workstation_models/market_models/actual_cost/external_docs/workstation_links`
>    ⇒ 空库快径只建 61 表（生产 109），**预览环境会缺 `cust_contacts` 等表导致创建客户 500**。
>    已补 import（metadata 93 表）；**历史迁移链无法从 base 重放**（`f82ac951b473` 与
>    `202605030002` 重复建表，实测炸 `customer_capabilities`）⇒ 新环境一律走快径 + 补建表。
> 3. **PPG schema 构建**：快径建 93 模型表 + 从生产目录补建 20 张 worker 独有/legacy 表
>    （conversations/wechat_*/feature_flags/file_objects/subscriptions/entity_links 等），
>    数据用二进制 `COPY` 逐表迁移（109 表），完成后校验行数与结构。
> 4. **Hyperdrive**：新建 `kaas-ppg` config `1733fcd80736482e8ec6e7648ed52286`（直连 db.prisma.io），
>    `wrangler.jsonc` 已切换；待数据校验通过后部署 Worker + 生产冒烟。
>
> **（2026-10-19 · POC 清理 + 迁库推进状态 / 卡点）**
>
> 1. **POC Worker 已清理**：`kaas-poc-sqlalchemy` / `kaas-poc-baseline` 已 `wrangler delete`；
>    生产 `kaas` 未受影响。
> 2. **迁库前置测量完成**（读生产库只读查询）：Neon 实测 **PG 18.6**、库 **16.23 MB**、
>    **109 表**、`alembic_version=202610180010`（详见 `PROD_DB_OPTIMIZATION_PLAN` §2.0）。
>    原计划"PG17 三对齐"假设已修正为"以 PPG 实际大版本为准 + 用 PG18 客户端"。
> 3. **迁库代码准备**：`session.py` SSL 判定去 `neon.tech` 硬编码、改通用判定（显式 ssl/sslmode
>    参数或非本地/docker host ⇒ SSL）；orchestrator 1200 测试全绿。改动在独立分支
>    **`feat/convergence-aprime`**（worktree 隔离，避免与并发会话抢分支）。
> 4. **卡点（用户侧）**：PPG 库需用户 Prisma 账号创建；Console GitHub 安装曾因仓库残留
>    `prisma-cloud/setup` 分支失败（**已删除该分支**），待用户重试安装并把 direct connection
>    串写入 `.env.local` 的 `DATABASE_URL_PPG`。
> 5. **并行推进（不依赖云账号）**：已启动 **C 子集——worker 真 PG 写入路径测试**（task-8，
>    pgserver 本地 PG + alembic 建 schema + register/bootstrap-admin 等写入路径真库验证）。
>
> **（2026-10-19 · 收敛 P0 POC 结论：路线 A 不可行 → 转 A′）**
>
> POC 文档：`docs/POC_WORKER_SQLALCHEMY_2026-10-19.md`（POC 源码
> `backend/worker/poc-sqlalchemy/` + 对照组 `poc-baseline/`；**生产 Worker `kaas` 全程未动**，
> 仅建了两个独立 POC Worker 做边缘验证）。
> 1. **兼容性硬阻塞**：`greenlet` 在 Workers Python runtime **无可安装 wheel**（Pyodide 314.0.7
>    索引 404；PyPI greenlet 3.5.6 的 79 个发行文件 0 个 wasm/emscripten）⇒
>    `sqlalchemy.ext.asyncio` 直接 ImportError ⇒ **异步查询 100% 不可用**。
>    （裸 asyncpg 对照正常 ✅；SQLAlchemy **同步 Core 仅编译 SQL** 可用 ✅）
> 2. **冷启动超门槛**：Worker Startup Time 中位 `2059ms → 3913ms（+1854ms）`，超出 "<1s" 验收线；
>    包体积 10.8→19.3 MiB（免费档 64 MiB 上限内，不阻塞）。
> 3. **结论**：路线 A（worker 跑统一 SQLAlchemy async app）**不可行 as-is**。转 **路线 A′**：
>    数据访问层同源——SQL/DDL 语句从 `kaas_common` 统一生成/存放，worker 继续裸 asyncpg 执行，
>    orchestrator 保留 SQLAlchemy ORM 作迁移工具；**同时做路线 C 子集**（worker 写入路径接真 PG
>    测试，消灭注册类 500 的土壤）。`greenlet` 自建 wasm 构建属独立立项（远超 0.5–1 天）。
> 4. **待拍板**：A′ 的具体范围（是否采用"SQLAlchemy 同步 Core 编译 SQL + asyncpg 执行"作为
>    共享 SQL 生成器——实测可用但 +8.2 MiB/+1.8s 冷启动）；两个 POC Worker 是否删除清理。
>
> **（2026-10-19 · 批次 0 后端小修 B0-5/B0-6 完成 —— 含印花税口径变更）**
>
> 1. **B0-5 印花税定义删除，并入杂税**（用户裁决："印花税这个定义就不存在了，直接归类到
>    这个杂税 3% 中"）：`pricing.py` 删除 stamp 计税分支与基数校验（`stamp_rate`/`stamp_base`
>    仅保留只读兼容字段，传入即忽略并给迁移提示）；fixed/ratio 改为按基础报价 × `misc_fee_rate`
>    附加综合税费（此前 misc 在 fixed/ratio 下是**静默空旋钮**，从未生效）；margin 模式不变
>    （系数在售价公式分母内）。`field_fence` 验证公式改为杂税口径。
>    **⚠️ 算价行为变更**：fixed/ratio 旧链路报价约 +3%（前端新工作台/批量报价走 margin
>    `margin_on_price`，不受影响）。手工核对基准值随之更新：engine `4.6028→4.7475` /
>    `5.8294→6.0141`；formulas `314.84→324.74`、`301.03→310.50`；import `301.03→310.5`。
> 2. **B0-6 诊断端点收敛**：`_r2_debug` / `fx-rates/_debug` 选择**加保护而非删除**
>    （HANDOVER 排障 runbook 仍引用它们），仅平台管理员可访问，普通用户 / 团队负责人 /
>    未登录一律 403 `ADMIN_ONLY`；新增 `tests/test_debug_endpoints_admin_guard.py` 锁定三种角色。
> 3. **门禁**：orchestrator `pytest -m unit` 1200 passed / 1 skipped；worker `pytest`
>    303 passed；`route-parity.py` PASS（缺失 11 全登记、过期 0）。
>
> **（2026-10-19 · 批次 0 前端小修 B0-1~B0-4 完成）**
>
> 1. **B0-1**（原 P2-⑪）：`use-products.ts` `crypto.subtle.digest` 裸调加特性检测兜底 ——
>    非安全上下文 / jsdom 没有 `crypto.subtle` 时不再炸（Frontend CI 红），跳过直传、
>    直接走服务端代传（multipart 由服务端自算哈希），返回体如实标记 `fellBackToProxy` +
>    回退原因；补单测钉死"不发 presign、不发 PUT、只发一次 multipart"。
> 2. **B0-2**（原 P2-⑫）：`freight-panel.tsx` 货代询价文案补 DAP/DDP 口径（DAP=到门价、
>    DDP=完税到门）：原五项费用保留，另请货代报目的港费用（拆箱、港杂及送货到门）与
>    进口关税及税费（DDP 完税到门口径）。
> 3. **B0-3**（用户裁决 #10）：`/quotes`「定价数据」tab 改名「成本历史」，页面副标题同步；
>    `?tab=pricing` 深链键不变；quotes-tabs 单测 + quotations e2e 文案同步更新。
> 4. **B0-4**：报价产品下拉唯一数据源 `useExportProducts` 加前端兜底过滤 ——
>    `is_active=false` / `disabled=true` 的行不进下拉（后端需求 16 已过滤，此为旧后端 /
>    MSW 种子的第二道防线，覆盖报价 / 批量报价 / 产品行三个下拉）；补单测。
> 5. **门禁**：前端 typecheck / lint / test 全绿（46 文件 455 用例）；未动 Pydantic 模型与路由，
>    无需 contracts:check。
>
> **（2026-10-19 晚场 · 方向已拍板：合并 + 三层模型 —— 当前口径以此为准）**
>
> 用户裁决：① **双后端按路线 A 合并**（CF 免费托管不可放弃 ⇒ 排除换 VPS；先 POC 再全量）；
> ② **恢复三层环境模型**（推翻当日上午"降级两层"裁决，DB 方案 §0 已同步）——理由链：
> 双后端时代 orchestrator 充当准预览，单后端时代 push 即上生产、预览环境是唯一安全网，
> 两者是同一决策。**执行计划：`docs/archive/2026-10-20-closeout/DUAL_BACKEND_CONVERGENCE_EXEC_PLAN_2026-10-19.md`**
> （P0 POC 0.5–1 天 → P1 迁库 → P2 预览环境（先于收敛，作安全网）→ P3 全量收敛 3–5 天
> → P4 观察期；硬性分批、不可跨 Phase 混合提交）。**状态：批次 0 已开工。**
> 工作区全面盘点（双审计：状态类 36 处 ⏳ + 全部计划文档）已汇总为总执行清单：
> **`docs/MASTER_EXEC_PLAN_2026-10-19.md`**——所有待办分为：批次 0 小修 ×6 / 文档收口 ×4 /
> 用户操作包 ×4 / 收敛 P0–P4 / 技术栈安全债 / 独立排期 ×7；过时项与已收口方案已列总账（§7）。
> 评估文档 §8 决策记录已收口。

> **（2026-10-19 · 双后端收敛评估重激活 —— 新口径）**
>
> 新评估文档：`docs/archive/2026-10-20-closeout/DUAL_BACKEND_CONVERGENCE_2026-10-19.md`（取代 2026-09 归档版；核心变化：
> `asyncpg`/`bcrypt` 已在生产 Worker 实际运行 ⇒ 旧版"Pyodide 不能跑 C 扩展"前提失效，
> **"Worker 跑统一代码"从不可能降级为未验证的工程风险**，路线 A（单应用源码 + Worker 装载）
> 开放评估）。**硬约束：CF 免费托管不可放弃**（用户 2026-10-19 裁决，排除"弃 worker 换 VPS"）。
> 双后端 ≠ dev/prod 两库（库分层是常态）；问题在**同一套 API 两份代码实现**，
> 注册 500（10-19）即行为面漂移的活标本——现有门禁查"有没有"查不了"一不一样"。
> 当前路线面对等（route-parity PASS：231/225，缺失 11 全登记），漂移集中在行为面。
> ⏳ 待拍板：① 路线 A POC（§5 清单，0.5–1 天）；② 先做"worker 写入路径接真 PG 测试"
> （与 POC 不冲突的疫苗项）；③ 排期顺序建议 POC → 迁库 → 收敛，三个大变更不同批。
> 本轮只写文档，未动代码。
>
> **（2026-10-19 · 优化方案盘点与待办总账清理 —— 待办口径以此为准；
> 双后端收敛评估已重激活，见上一条）**
>
> ~~新方案文档：`docs/archive/2026-10-20-closeout/PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md`（Neon→PPG 迁移 + Hyperdrive 双 binding
> 缓存 + Worker 启动第二刀；已定稿**待执行**，用户裁决本轮只写文档不动手）。~~
> ❌ 该方案已随**决策 1 废弃**（放弃 PPg 回 Neon），权威 = README §2/§9。
> 另已更正三处过时口径：10-18 部署**已完成**（10-18 22:00，生产迁移至 `202610180010`；
> 注册修复 10-19 已随 push 自动上线）——HANDOVER-10-18 §7、QUOTE 优化计划 §0.2 已同步。
>
> **✅ 已完成/过时（不再跟进）**：双后端收敛主体（共享内核 + 双门禁在跑）；entity_links
> 关系建模（迁移 012–014）；DB 层优化方案 1/2（已退役）/3/4（无必要）；PLATFORM_UPGRADE
> P0–P4 主体（细节散见各专项）；10-18 各专项（报价 22 项 / 税务档案 / 批量报价 / 客户 5 项）；
> PLAN_CUSTOMER_RECORDS 主体（worker `/records` 已上线）；30/90 天自动推导（整套已删，
> 用户裁决"先手动"）；Ghost 方案（从未存在于本项目，已否决）。
>
> **⏳ 当前有效待办（按优先级）**
> - **P0 欠账**：① ~~Hyperdrive 缓存关闭~~ → ⏳ 发布窗口（2026-10-20 终局裁决，已并入 `HANDOVER_2026-10-20.md` §7 检查单第 2 步；原挂账备注：`--caching-disabled` 大概率未执行；验证=生产新建客户
>   立即刷新可见）② R2 `S3_ACCESS_KEY` 重建 32 位（待用户 dashboard 操作，见
>   PRODUCT_MEDIA_STORAGE_PLAN §5.3）③ 生产 `product_tax_rates` 配置数据（0 条则批量报价不放行）
> - **P1**：④ 仓库改回 private + 确认 Actions billing ⑤ Cloudflare agent 接入（未执行）
>   ⑥ ~~Neon→PPG 生产迁移（方案已定稿；生产为空黄金窗口，越晚代价越大）~~
>   ❌ **已废弃（决策 1，见本摘要顶部 2026-10-19 晚场条目）**：放弃 PPg 回 Neon，本项永久取消
> - **P2**：⑦「流失」拒绝文件链路迁订单阶段（等订单阶段新增 lost）⑧ Excel xlsx 上传闭环
>   （上传侧现只收 CSV）⑨ ~~生产测试数据 / 流失拒绝文件历史数据清理~~ → ⏳ 发布窗口（数据删除，**执行当次仍需用户确认**；2026-10-20 终局裁决）
>   ⑩ 诊断端点收敛（`_r2_debug` / `fx-rates/_debug`）⑪ ~~Frontend CI `crypto.subtle.digest`
>   类型红~~ ✅ 10-19 已修（B0-1，见上一条）⑫ ~~货代询价文案补 DAP/DDP 费用项~~
>   ✅ 10-19 已补（B0-2，见上一条）
> - **P3 暂缓**：技术栈升级（触发条件制，见 TECH_STACK_UPGRADE §0）、30/90 天自动沉寂、
>   本地 mock 刷新丢数据（MSW 限制）、e2e 数据层不稳根治、租户级产品定义配置化
>   （PRODUCT_CONFIG_TENANT_UNFINISHED）
>
> **未来评估项**：~~换运行时/单运行时收敛~~ **已重激活为在评方案**（见上一条与
> `docs/archive/2026-10-20-closeout/DUAL_BACKEND_CONVERGENCE_2026-10-19.md`；路线 A POC ⏳ 待拍板；排期建议 POC → 迁库 → 收敛，
> 三个大变更不同批）、preview/staging 环境（触发=多团队真实使用）、Neon 读副本
> （触发=生产撞免费档限制）。

> **（2026-10-19 · 生产注册 500 修复 + 注册页去重）**
>
> 1. **生产无法注册（用户报告）→ 根因锁定**：生产 `users.is_tenant_admin` 为
>    NOT NULL **且无库默认值**（`f82ac951b473` 建表即如此），而 worker 注册/初始化管理员的
>    `INSERT INTO users` 都漏了该列 ⇒ `null value in column` → **500**。orchestrator 不炸是因为
>    SQLAlchemy 模型带客户端 `default=False` 会在 INSERT 时补上；worker 测试全用假 DB 从未发现。
>    浏览器侧 500 又被外层 ServerErrorMiddleware 剥掉 CORS 头，控制台只能看到
>    "CORS 拦截 + ERR_FAILED"，极具迷惑性。**修复**：worker 两处 INSERT 显式补
>    `is_tenant_admin=false`（`main.py` register + bootstrap-admin）；CORS 中间件加
>    未捕获异常兜底（带 CORS 头的 500，前端可读错误）；两端补回归测试锁死。
> 2. **注册页去重（用户要求）**：删掉「公司名称」输入框，只留「团队名称」（两者本就重复；
>    后端 company_name 只进日志不落库）。**后端 `company_name` 改可选**（orchestrator
>    `auth.py` + `schemas/auth.py`、worker `RegisterRequest`），openapi 产物已重生成；
>    mock 同步。顺带修掉 worker 独有的「company_name 兜底建团队」口径漂移
>    （与 orchestrator 及 docstring 对齐：只有显式 `team_name` 才建团队）。
> 3. **部署**：push `main` 即自动部署（CI deploy.yml）。生产库**无需迁移**（无表结构变更）。
> 4. **注册后报价页白屏（`/quotes?tab=pricing` 控制台 TypeError `matrix.rows.length`）→
>    根因**：worker 的 `/api/v1/pricing-data` 还是**老算价流程**的遗留实现（返回
>    `{items,total,page,pages}` 分页列表），而 orchestrator 现行语义是**产品定价键完整矩阵**
>    （`{dims,rows,...}`）——前端按矩阵渲染 → 读到 `rows` undefined 即崩。该页此前从未有
>    真实客户账号用到，注册打通后第一个用户就踩中。**修复**：worker 四个端点
>    （GET/POST/PATCH/DELETE）按 orchestrator `app/api/pricing_data.py` 重写，
>    矩阵/档位逻辑复用 quote_api 既有移植（与算价同一身份口径 `quote_api._customer_of`，
>    保证「配的价 = 算价用的价」；POST 用单语句 CTE 保证「停用旧版本 + 插新版本」原子性）。
>    旧遗留实现按 `product_specs` 自由规格成本，前端早已不用，随之移除。
>    新增 `tests/test_pricing_data_api.py` 6 条行为测试锁死矩阵形状回归。
> 5. **CI `backend:test` · db-tests 恒红（自 2026-10-18 起）→ 根因三处旧口径**（提交 `6c08900`）：
>    - `tests/conftest.py` 的 TRUNCATE 种子清单还含 `customer_quote_profiles`，该表已被迁移
>      `202610180009/010` 删除 ⇒ 初始化 fixture 抛 `UndefinedTableError`，10 条 admin 用例 ERROR；
>      改为 `to_regclass` 判存在后再 TRUNCATE（以后删表不必再改清单）。
>    - `tests/test_company_seals.py` 仍是旧「仅 internal 可管公章」口径；按用户 2026-10-18 裁决
>      （公章/企业抬头写入 = **团队管理员或平台管理员**）更新：写操作用平台管理员身份，
>      客户账号断言 `TEAM_ADMIN_REQUIRED`（原 `INTERNAL_ONLY`）。
>    - `tests/test_trade_docs_api.py` 单证号断言 `QUO-2026…` 过期：编号自 2026-10-18 起统一为
>      「类型-国家-客户-时间戳」（`kaas_common.number_rules.build_number`）⇒ 断言改 `QUO-` 前缀。
>    **为什么长期没人发现**：本机没有 PostgreSQL，db 测试在本地全部 **skip**（不是跑过），
>    CI 只显示 job 红、日志需登录才能看。本次用**临时调试分支**（backend:test 监听所有分支的
>    backend 路径 push，deploy 只听 main）把失败明细写进 check-run annotations 才拿到真因；
>    修复后该分支 `backend:test` 三个 job（unit / worker / **db**）全绿，再以 `6c08900` 落 main。
>    调试分支已删除，未触发多余生产部署。

> **（2026-10-18 · 客户管理 5 项修复 + 阶段模型重构 + 本地 Docker）**
>
> ~~用户报告的 5 项缺陷与结论（全部已在本地验证，**尚未部署**——按用户指示
> 「本地没问题以后再连同后续改动一同部署」，且当前 GitHub Actions 额度/账单仍可能挡住任务启动）：~~
> ✅ **2026-10-19 更正：本节全部条目已于 10-18 22:00 部署生产（迁移至 `202610180010`）**；
> 下文保留原文备查。
> 1. **客户创建后不能删除** → 前端从来没有删除入口；后端软删除接口两端都有。
>    本轮补 UI（二次确认）并加规则：**名下有开启中的订单时 409 `OPEN_ORDERS_EXIST`**。
> 2. **新建客户刷新后消失** → 根因是 **Cloudflare Hyperdrive 查询缓存**（默认 max_age 60s、
>    stale_while_revalidate 15s，写后不失效）；`docs/archive/2026-10-20-closeout/HANDOVER_2026-10-17.md` §3.3 已记录该现象。
>    代码侧无法关闭；部署时执行
>    `npx wrangler hyperdrive update f53fed49705043008737032e4bfa2b8e --caching-disabled`
>    （或改为按读一致性拆分两个 Hyperdrive 配置）。**未执行**（部署延期）。
>    本地 Docker/Postgres 无此缓存，刷新后立即可见（已实测）。
> 3. **客户信息创建后不能编辑** → Worker 侧本来有 `PATCH /customers/{id}`（`ws_crm_ext.py`），
>    但前端客户页没有编辑入口。本轮补「编辑档案」表单 + 联系人编辑/删除。
> 4. **手动改阶段不生效** → Worker 的 `_recompute_customer_stage` + 30/90 天兜底在**读列表时**
>    按询盘/报价/订单重算并覆盖手动值。**已删除整套自动推导/时间兜底**，客户阶段改为
>    读时按「开启中的订单」推导，手动值不再被覆盖。
> 5. **阶段改为 活跃 / 沉寂 / 已下单 三种** → 已实现；订单阶段（pending→…→completed/cancelled）
>    与客户阶段严格分离；「流失」属于订单阶段，客户阶段删除 `lost`（旧数据迁移为「沉寂」）。
>    「已下单」由开启中的订单（pending/confirmed/producing/shipped）推导，不允许手写。
>
> 数据迁移：`202610180001_customer_stage_active_inactive`（旧六值 → active/inactive；
> 本地库已执行；~~生产库未执行~~ ✅ 2026-10-19 更正：10-18 22:00 部署时已执行）。
> 本地开发环境：`docker-compose.yml` 已修（backend 构建上下文改为 `backend/`，
> 共享内核 `kaas_common` 进镜像/挂载，venv 放 `/opt/venv`）；`docker compose up -d` 即起
> Postgres/Redis/MinIO/backend，前端 `pnpm dev` 直连 `localhost:8000`。
> 术语：对外报价新增 **DAP（到门）** 与 **DDP（完税到门）**，选项显示 `代码 · 中文（English）`。
> **侧边栏入口摘除（2026-10-18 用户要求）**：「产品定义管理」不再占侧边栏
> （内容已在「产品」工位「定义」区块），契约 `workstations.ts` 与后端镜像
> `domain/workstations.py` 同步改为 `status: 'hidden'`；条目保留以支撑旧路由
> `/settings/tenant-products` 的深链跳转与面包屑。`contracts:check` R2 通过（26 工位）。

> **（交接 · 2026-10-17 晚 · 会话收尾 → 下一位继续）**
>
> **✅ 生产已更新到最新（2026-10-17 14:33 北京时间）**
> - 线上 Worker 版本 `b6c2d701`（`2026-10-17T06:33:07Z`），部署提交 `2a355c4`（= `origin/main`）。
>   部署走的是**既有 CI**：`.github/workflows/deploy.yml`（构建前端 → `sync-shared.ps1` →
>   `pywrangler deploy` → 生产冒烟），本次以 `workflow_dispatch` 触发，run `39010179425` 两个 job 全绿。
> - **更正上一条交接的两个错误结论**：
>   ① 「push 不触发部署」**不成立** —— `deploy.yml` 自 2026-09-28 起就监听 `main`；
>   ② 「自动部署尚未搭建」**不成立** —— 早已存在，只是 10-12 起被 **GitHub Actions 私有仓库
>   分钟额度/账单**挡在任务启动前（annotation 原文：
>   `The job was not started because recent account payments have failed or your spending limit needs to be increased`）。
>   2026-10-17 把仓库改为 **public** ⇒ Actions 免费，部署恢复。**以后改完 push `main` 即自动发**；
>   纯文档/`docs/**`/`.tools/**` 提交不触发（`paths-ignore`），要强制发就 `workflow_dispatch`。
> - 部署后实测：`/health` 返回 JSON 且 `shared.loaded=true`；`/api/v1/leads`、`/quotes`、
>   `/export-quote/products`、`/research/categories`、`/admin/accounts` 匿名均 **401**；
>   `/research`、`/customers`、`/quotes`、`/login`、`/forgot-password`、`/leadgen`、`/intel`、
>   `/outreach`、`/products`、`/settings/ai-providers` 均 **200**；错误口令登录 **401**；
>   `forgot-password` 对未知邮箱仍返回统一 **200**。
> - **登录跳转修复（422dadc）已上线**：线上 `(app)/layout` chunk 已是三态判定
>   （`useState(null)` + 「正在验证登录状态…」空壳 + 无 cookie 直接 replace `/login`）。
> - 手动部署的坑（`PYTHONUTF8=1` / `uv` 报 `No module named 'python'` / pywrangler 读 GBK）
>   **仅作排障参考**，正常路径是 CI；应急可用 `npx wrangler deploy`（本机实测 wrangler 4.151.1
>   已登录、有 workers 写权限）。
>
> **CI 现状（2026-10-17 16:1x 实测）**：
> - `deploy` **绿**；生产代码已随本轮修复重新部署（`272a683`，见下「本轮追加修复」）。
> - **`backend:test` 首次全绿**（run `39016277997`，`sha 272a683`，`workflow_dispatch`）：
>   `unit-tests` **1222 passed / 1 skipped**（选中 1223；总收集 1548）；
>   `db-tests` **307 passed / 7 skipped**（选中 314 = `-m db --collect-only`；1234 deselected）；
>   `worker-tests` **275 passed**。此前「约 400 个 run 无一次成功」的长期红已收口。
> - **7 条 skip 的边界（如实标注）**：空库快径（E1 `create_all+stamp`）**不含**迁移里的
>   品类树/属性绑定种子 ⇒ 依赖 seed 的 quote-wizard/规格用例显式 skip（缺数据才 skip，非假绿）。
>   要真跑需把迁移 `202605170001` 的品类/属性绑定种子补进 `_seed_reference_data`。
> - **本次主要修复**：conftest 注入 `state.tenant_id`（events 400 / Missing tenant context 总根因）/
>   db-tests 补 `DATABASE_URL` / 逐用例重建 `middleware_stack` / 空库快径补 btree_gist+EXCLUDE、
>   price_units、entity_links+triggers / 测试预期对齐当前口径（events 200、`{"detail":"code: ..."}`、
>   tenant 恒 default）/ **两处产品缺陷**（见下）。
> - `Frontend CI` 尚未重跑（最近一次仍是被账单挡住的 `422dadc`）。
>
> **用户原话要求（2026-10-17）**：
> 1.「为什么是手动部署, 设置好自动部署」→ **自动部署本来就有**（见上），此前是账单问题；现已验证可用。
> 2.「将生产项目部署为最新」→ **已完成**（2026-10-17 14:33，`2a355c4`）。
> 3. Cloudflare agent 接入（`https://developers.cloudflare.com/agent-setup/prompt.md`）——**未执行**（仍待做）。
> 4.「确保没有信息泄露的安全隐患」→ 已完成首轮审计：删除了唯一的"当前可读"泄露入口（远端分支
>   `feat/trade-doc-templates`），其余见文末「公开仓库安全审计」；**用户裁决：Neon 口令暂不轮换，
>   部署完成后把仓库改回 private**（注意：改回 private 后私有仓库 Actions 额度问题会回归）。
>
> **本会话已完成并入库**（全部推送 main，基线：orchestrator 1218 / worker 275 /
> 前端 437 / typecheck 0 / lint 0 / contracts R0–R6 178 paths / route-parity PASS）：
> - 账号治理 6 项审查修复 + 账号管理 UI + 登录落点角色化 + **登录跳转 bug 修复**（422dadc）
> - P16 可视化产品编辑器三小步（数值参数/变体/公式 → 列/校验/扣减 → 参数/说明/常量+试算）
> - P17 收官（全门禁含 NEXT_EXPORT build + 逐字段 round-trip 验收）
> - 阶段 3 UI：4 套 tab 收编 ui/tabs、11 处响应式 grid 修复、巨石拆 5 刀
>   （product-quote-view 1327→1008、quote-workbench-view 998→661）、e2e 选择器治理
> - E1 空库快径（app/db/migration_bootstrap.py + env.py）+ P0 引用完整性 DOC_REF_BROKEN
>   + P1 收款容差/单证清单（两表迁移 + receipt_rules 判定）
> - **真数据验证**（企微表格 45 行）：装柜 0.96 精确维持、重量/售价公式 0% 误差
>   （docs/archive/fit_report.md）；**真库 CRUD 9/9**（Neon 验证分支）
> - **抓到并修复 2 个真 bug**：① cust_inquiries/contacts/stage_log 外键指遗留表
>   cust_customers（真库写询盘必炸）⇒ 迁移 202610170004；② E1 inspect 开事务导致
>   迁移静默回滚 ⇒ env.py 事务收尾。
> - **生产库迁移已执行（2026-10-17 14:30）**：`202610110018 → 202610110019 →
>   202610120001 → 202610170001 → 202610170002 → 202610170003 → 202610170004`，
>   现 `alembic_version = 202610170004`；`password_reset_tokens` 等新表已建，
>   三张改外键的表生产库均 **0 行**（无数据风险）。本次用 `.env` 的 pooler DSN 执行成功（实测），
>   但官方口径仍建议迁移用**直连端点**。**CI 不做迁移**：以后新增迁移仍需人工
>   `alembic upgrade head`。
>
> **本轮追加修复（2026-10-17 16:1x，QA 账号验收发现）**：
> - **`/api/v1/export-quote/rate-sets` 500 → 200**：根因是 Worker 只保证打包 `.py`，
>   `rate_sets/*.json` 数据文件未进 bundle（Pyodide 也无目录列举）⇒ `sync-shared.ps1` 现在
>   额外生成 **`rate_sets_data.py`（Python 内嵌常量）** + `_manifest.json` 兜底；
>   `rates.py` 三级回退（目录 → manifest → 内嵌），补 4 条单测（`TestRateSetFileDiscovery`）。
> - **`/api/v1/admin/feature_flag` 500 → 200**：生产库**运行时缺** `feature_flags` /
>   `feature_flag_audit` 两表（迁移 `202609230005` 在存量库被历史 stamp 跳过，属 schema 漂移）
>   ⇒ 已按迁移同款 DDL 在生产补建两表。
> - **两处产品缺陷随 CI 全绿上线**：① `trade_docs._insert_links` 的 JSONB `meta` 先
>   `json.dumps`（派生建单原生产 500）；② `trade_doc/payload.apply_scheme` 物化前 `pop` 旧
>   `line_amount`（多方案一键应用原生产 422）。
> - **部署后浏览器实测（QA 账号，2026-10-17 16:2x）**：真实登录落到 `/customers`；
>   `/customers`、`/quotes`、`/orders`、`/products`、`/research`、`/settings`、`/trade-docs`
>   全部**无 Network Error、无 4xx/5xx 请求、无 console error**（修复前 `/quotes`、`/settings`
>   会因 rate-sets 500 无 CORS 而报跨域/Network Error）。
>
> **生产 404/501 的真实性质（2026-10-17 复核；别误判成"缺功能"）**：
> - `/api/v1/fx-rates/latest` 的 404 = **`fx_rates` 表 0 行（没录汇率）**，Worker **有实现**
>   （`ws_extras.py:59`）；同组 `/api/v1/fx-rates` 返回 200 + 空列表。修复是补数据，不是补代码。
> - `/api/v1/admin/metrics/summary`、`/api/v1/admin/deployment_audit`、
>   `/api/v1/admin/spec/attribute-proposals(+ /recommended)` = **有意不在生产暴露**
>   （route-parity allowlist 原注：本地 Prometheus / 运维部署专用 / 开发期治理），生产 404 属设计。
>   影响面仅内部运维页：`/admin/gray-release` 的部署审计列表、`/admin/spec-proposals` 页面。
> - `/api/v1/export-quote/import/template` **按设计只支持 CSV**：`format=xlsx` 返回 501
>   （openpyxl 是 C 扩展，进不了 Python Worker）。前端已把「下载 CSV 模板」设为主按钮、
>   Excel 降为次按钮（`bulk-import-panel.tsx:239-264`）⇒ 导入链路可用，只是 Excel 模板不可用。
> - **订阅门禁两套口径（产品欠账，未改）**：worker `_require_sub` 固定查
>   `tenant_subscriptions WHERE tenant_id='default'`；生产该表只有 1 行 `full_chain` ⇒
>   **所有团队/用户都被放行**（订阅治理实际失效、按团队售卖不生效）；一旦删/停用该行，
>   全部团队会立刻 404。orchestrator 侧用 `auth.tenant_id` 查，与 worker 行为不一致。
>   门禁覆盖：leadgen（地图源获客/线索）、outreach（客户触达）、research（市场调研）、
>   quote（报价产品）。建议单独立项：门禁统一读 `team_subscriptions` / `user_subscriptions`。
>
> **剩余队列**：P1 收款/回执 API 层（表与容差已就绪）→ P0 导出自检①②（需 PDF 解析层）
> → P0 公章规范化 → P1 事实层+一致性引擎 → P15 契约收口 → 文档继续清理。
> **待用户**：装柜混合模型 β 项数据（跨柜数对比，如后续有）；单证加固 P1 各项按需排期。

> **（交接 · 2026-10-17 · 大盘点 + 阶段 0 快赢 + 六项决策落盘）**
>
> **背景**：用户要求全系统遗留盘点 + 业务链生产化（录询盘归客户→报价→订单→单证）+
> 新增/自定义产品 + UI 整体重构。四路探查结论已固化在 UNCERTAIN #17–#20 与本文档，裁决：
>
> - **决策落盘（UNCERTAIN）**：#17 单证加固五项按设计默认值拍板；#18 **Neon 口令不轮换**（David 裁决，接受历史泄露风险）；
>   #19 报价口径（① 体积扣减只用 ratio=每柜等效；② 装柜系数以实测 **0.96** 为准，3.7% 降级备注；
>   ③ **实时报价+历史参考价**——原料每日波动，每单实时手填，历史参考价从台账聚合；
>   历史报价要全（客户/时间/报价人/产品/规格/数量/价格），**价格拆成本+利润、对内/对外双视图**，
>   成本字段接口层鉴权绝不透出）+ 装柜升级为**混合物理模型**（V×(1−α)−β×柜数，21 行实测拟合，
>   残差优于 ×0.96 才切换）；#20 alembic **空库快径**（env.py 空库 ⇒ create_all+stamp head，老链冻结）。
> - **阶段 0 已交付（本次提交）**：前端 typecheck 2 条既有红修复（onboarding typed-route `as Route`，
>   main 门禁转绿）；登录落点角色化（`/` 按账号类型 → internal `/customers` / customer `/products`，
>   替代废页 /dashboard；登录后默认落点同步改 `/`）；**平台账号管理 UI**（settings 第三个 tab，
>   仅 system_admin 可见：白名单列表 + 停用二次确认 + SELF_PROTECT/LAST_ADMIN 明确文案 + MSW 可变 store）。
> - **门禁实测（2026-10-17）**：前端 typecheck **0 错**（首次全绿）/ lint 0 / test **396 passed（34 files）**；
>   NEXT_EXPORT build 见提交说明；后端未动。
> - **已确认的实施顺序**：阶段 0（✓ 本次）→ **组件层打底**（ui/tabs、form 套件、detail-drawer、
>   data-table，统一 4 套手写 tab）→ 阶段 1 业务主链路（/customers 权限改 internal 全员、CustomerPicker
>   内联新建客户、询盘→报价发链、报价台账成本分解+双视图+参考价、MSW 补 quotes/orders/trade-docs）→
>   **阶段 2 进行中（2026-10-17）**：✅ 产品发现层合并 —— `TenantProductLoader.list_available`
>   （Python 注册表 ∪ tenant_products 按团队可见性，同 key 本团队行 > 历史 NULL(仅管理员) > Python），
>   `/export-quote/products` 与 `/products`（媒体）两端同改；worker `dbjson` 补登记
>   `tenant_products.spec`。**运行时新增/自定义产品从此在报价下拉可见可选可算价**。
>   ✅ P13 最后一跳落盘：迁移 `202610170002`（tenant_products 加 override +
>   base_spec_hash 两列），读路径两端接 `resolve_effective_product`（差异 hash 与基线
>   不符抛 SPEC_UPSTREAM_CHANGED 409/不静默套用；worker _effective_product 同时从
>   「只认注册表」对齐为同口径）；写路径 PUT/POST 接受 override 并留档基线指纹。
>   ✅ P16-S6.1 开始：**前置** `TenantProductOut`/`_product_out` 加 spec 字段（编辑器
>   数据源 —— 不带则打开即丢数据）+ `product-spec-editor.tsx`（数值参数/变体档位/
>   派生公式三段表单 + 高级 JSON 双向同步）。**JSON 保留为高级模式且实时写 specJson**
>   （不引入未应用草稿 —— 草稿会让用户改完忘点应用、保存丢改动）；JSON 语法错时
>   表单锁定并提示（防表单编辑覆盖坏 JSON）。⚠️ P14 等价测试的 textarea 路径
>   已随 S6.1 UI 调整（JSON 进编辑器的「高级 JSON」tab），P14 原文「留给 P16」的授权范围。
>   ✅ S6.2 落地（columns/invariants/space_deduction）；S6.3 落地（params/notes/constants
>   + 公式试算：product-spec-tryout.tsx 调 /explain 的 spec_override，草稿定义逐步代入
>   自证，公式写错当场暴露，不新建接口）。**P16 三小步收官**。
>   ✅ **P17 收官**：全门禁实测（2026-10-17）—— orchestrator **1205 passed** /
>   worker **275 passed**（顺修 _product_out 的 spec.get 容忍最小 fixture）/ 前端
>   **426 passed**（含 P16 逐字段 round-trip 验收测试）/ typecheck 0 / lint 0 /
>   contracts **R0–R6 PASS（178 paths）** / route-parity PASS / sync-shared 一致 /
>   **NEXT_EXPORT build 成功**（P17 必含项）。
>   📌 P13–P17 全部收官；「产品定义可视化编辑器」从 PRODUCT_CONFIG_TENANT_UNFINISHED
>   的未完成清单移除。
>   📌 **阶段 3 UI 页面层**：4 套 tab 全收编 ui/tabs（含 P14 状态保留语义）/
>   11 处非响应式 grid 修复 / 巨石拆分 4 刀（product-quote-view 1327→1008、
>   quote-workbench-view 998→661）/ e2e 选择器治理（类名 → data-testid 契约）。
>   📌 **E1 空库快径**落地（app/db/migration_bootstrap.py + env.py 接线 + 3 测）。
>   📌 **P1 单证加固 P0 引用完整性**（DOC_REF_BROKEN）：作废前必扫引用方，
>   有 issued 下游引用 → 409 带清单（两端同口径，orchestrator + worker）。
>   📌 **真数据验证 + 真库 CRUD（2026-10-17）**：企微智能表格 45 行明细回代引擎 ——
>   装柜 0.96 精确（3 行恒 0.960000）、重量公式 0% 误差（9 行）、售价公式
>   `成本/(1−利润率−0.03)` 0% 误差（23 行）⇒ **报价引擎数据准确，装柜维持 0.96**（fit_report.md）；
>   Neon 验证分支真库 CRUD 9/9（客户/询盘/报价+cost_breakdown/订单/收款/单证清单增删改查）。
>   🔧 **抓到并修复 2 个真 bug**：① schema 漂移 —— cust_inquiries/cust_contacts/cust_stage_log
>   三表外键指向遗留表 cust_customers（真库写询盘必炸，mock 测试从未暴露）⇒ 迁移
>   `202610170004` 改指主表 customers；② E1 空库快径的 inspect 开事务导致
>   **迁移静默回滚**（exit 0 但没落库）⇒ env.py 事务收尾（commit/rollback）修复。
>   阶段 3 页面层重构。
> - **客户管理权限口径**：~~internal 员工全员~~ → **全部登录用户**（UNCERTAIN #21 修正：
>  internal=平台员工、customer=用户按团队隔离，用户录自己的业务客户；后端
>  `_scope_filter` 本就支持，前端撤掉 RouteGuard 即通）。
> - **阶段 1 进行中（2026-10-17）**：✅ 权限倒挂修复 + CustomerPicker 内联新建 +
>  询盘报价发链（`24015db`）；✅ 报价台账增强后端切片——`quote_order_items` 加
>  `cost_breakdown`（迁移 `202610170001`，成本/利润内部分解快照，签发时从算价引擎
>  internal 视图带来，**接口层按账号类型剥除：customer 绝不透出**）+
>  `GET /quotes/reference-price` 历史参考价（同客户同产品近 N 天单价聚合，
>  可选规格精确匹配，可见范围同报价单列表；两端同契约，178 paths）。
>  ✅ 已接：报价记录页对内/对外双视图（`b7a377a`）+ 报价行历史参考价展示
>  （`0568415`）+ MSW 补洞 orders/trade-docs/enums（`本次`）——阶段 1 收官。
>  ⏳ 阶段 1 遗留：单证 mock 只覆盖列表/新建/详情（render-data/pdf/指纹对账等
>  深功能未 mock）；e2e 主链用例待写。

> **（交接 · 2026-10-17 · 账号治理 API 代码审查 6 项发现全部修复）**
>
> 对 `ff9aa73`（账号治理）/`fbced67`（DSN 清理）的审查发现，按弹窗确认的方案全部修完：
> - **LAST_ADMIN 并发竞态（两端）**：计数改自 `SELECT ... FOR UPDATE` 行锁查询（锁定全部
>   active 管理员行），并发禁用最后两名管理员时在锁上串行化、后到事务重读行集必然已减 →
>   正确 409，不再出现「双双通过、平台零管理员」窗口。
> - **角色映射彻底单源**：全仓库唯一一份映射收敛在 `kaas_common.workstation.scope`
>   （`ADMIN_ROLES` / `effective_role`）；orchestrator `User.effective_role` /
>   `AuthContext.effective_role` 改为委托；`admin_accounts.py` 的第三份 `_ROLE_MAP` 删除。
> - **列表分页（两端同契约）**：`GET /accounts` 加 `?limit=`（默认 500，上限 1000）+
>   `?offset=`，响应新增 `total`（全量计数）——**契约形状有变化，openapi.json 已重生成**。
> - **杂项**：worker `_account_out` 函数内 import 上提模块顶；`.tools` 四个脚本
>   `KAAS_DSN` 缺失时给可读报错（原裸 `KeyError`）。
> - **门禁实测（2026-10-17）**：orchestrator `pytest -m unit` **1197 passed / 1 skipped**
>   （较上次 +1）；worker **275 passed**（较上次 +3）；route-parity **PASS**；
>   sync-shared 同步后 **Check 一致（31/22/1）**；`contracts:check` 按 R6 顺序
>   （重生成产物 → 提交 `64d3472` → 复跑）**PASS R0–R6（177 paths）**；
>   前端未改动（lint 0 / test 390；其 `typecheck` 2 条既有红 `onboarding/page.tsx`
>   与本线无关，待前端线修）。

> **（交接 · 2026-10-12 17:3x · 平台账号治理）→ 详细交接见
> [`ACCOUNT_GOVERNANCE_HANDOVER_2026-10-12.md`](./archive/2026-10-20-closeout/ACCOUNT_GOVERNANCE_HANDOVER_2026-10-12.md)**
>
> - **生产数据（已完成 · 用户弹窗确认）**：清空**全部团队（1 个）+ 账号（3 个）**，
>   只留一个系统管理员 `david@powervoy.com`（`internal` / `system_admin` / `active`，
>   口令 bcrypt 落库）；落库后复核 `remaining_users=1 / remaining_teams=0`。
> - **新增能力（提交 `ff9aa73`，已推送 `main`）**：`GET /api/v1/admin/accounts` +
>   `PATCH /api/v1/admin/accounts/{user_id}`（**停用 / 恢复**）**两端同契约**；
>   鉴权 = `internal` + `effective_role='system_admin'`（含历史 `admin` 映射）；
>   保护 **409 `SELF_PROTECT`**（禁停自己）/ **409 `LAST_ADMIN`**（禁停最后一名 active 管理员）；
>   响应白名单**不含** `password_hash` / token。
>   **不提供任何物理删除账号 / 团队的 API**（用户已确认口径：删除不可逆且关联面广，改停用）。
> - **门禁实测（2026-10-12 17:1x–17:2x）**：orchestrator `pytest -m unit`
>   **1196 passed / 1 skipped / 324 deselected**（= 上一条交接的 **1183** + 本次新增 **13** 条，数字对得上）；
>   worker **272 passed**；`route-parity` **PASS**；`contracts:check` **EXIT 0 · PASS R0–R6**（177 paths）；
>   `sync-shared -Check` **EXIT 0**；前端 `lint` **0**、`test` **390 passed / 33 files**；
>   ⚠️ **前端 `typecheck` 现在是红的**（2 条**既有**错误：`onboarding/page.tsx` 的 typed-route 链接
>   `"/quotes?tab=pricing"` / `"/quotes?tab=product"`，**非本条线引入**，待前端线修）。
> - **待办**：前端「平台账号管理」UI（设计稿见交接文档 §④；AgentTeams t2 已派发）、
>   端到端验收（t3：三类账号权限 + 自停/最后管理员保护 + 停用后登录被拒）。

> **（交接 · 2026-10-12 傍晚 · 产品模块合并线 + 忘记密码）→ 详细交接见
> [`SESSION_HANDOFF_2026-10-12_PM.md`](./archive/2026-10-20-closeout/SESSION_HANDOFF_2026-10-12_PM.md)**
>
> **本场次交付 10 个提交（全部已推送 `main`）**，按线分组：
> - **后端主线（P13 账本接回 + P7/P8 残余清零）**：`c217bc5` Loader 团队谓词 →
>   `c11d426` `_effective_product` 走 Loader（**账本进算价**）→ `988247a` 三处同构团队谓词
>   （`trade_docs._product_info_of` + worker `main` + `resolve_photo_refs`）→ `74c0b58` 文档。
> - **前端主线（P14 工位合并）**：`9acc79b` 两页搬进一个工位两 tab（行为等价，JSON 文本框原样保留）
>   → `c1bf07c` 回归网（tab 状态 / 旧路由 redirect / 读写契约，9 条新测试）。
> - **后端辅线**：`198ea89` §8.5 标量列表缺口（`notes`/`hs_codes` 仅支持整体替换）；
>   `f3ee3c5` 产品合并前置取证（三表 `team_id` 回填可行性离线核对）。
> - **🆕 忘记密码（用户新需求）**：`5092d50` 全链路 —— 迁移 `202610120001` + `PasswordResetToken`
>   模型 + orchestrator/worker **同契约两路由**（`forgot-password` / `reset-password`）+
>   前端 `forgot-password` 改造与 `reset-password` 新页 + **18 条测试**；
>   token 只存 **SHA-256 哈希**、30 分钟过期、用后即废、不泄露邮箱存在性；Resend 真实发信已验证 **200**。
> - **产品合并**：`2a16e9d` **P13 纯逻辑层** `effective_spec.py`（基线 + 差异，**不冻住**）+ 10 条测试。
>
> **门禁实测（2026-10-12 17:1x，工作区静止）**：orchestrator **1183 passed / 1 skipped**；
> worker **261 passed**；前端 **390 passed（33 files）**；`lint` exit 0；
> `contracts:check` **PASS R0–R6（175 paths）**；`route-parity` **PASS**；
> `sync-shared -Check` **exit 0**（31 / **22** / 1）。
> ⚠️ **`NEXT_EXPORT=1 build` 本场次未跑**（避 `.next` 硬冲突）；前端 `typecheck` 仍有
> **2 个 `onboarding/page.tsx` 历史遗留 error**（非本场次引入，如实标注未修）。
>
> **⏳ 下一步**：P15（契约收口）→ P16（可视化编辑器）→ P17（全门禁含 build）；
> **P13 还差最后一跳**（等 `tenant_products` 加 `override` 列）；忘记密码需部署时跑迁移 + 确认 `RESEND_API_KEY`。

> **（交接 · 2026-10-12 上午 · 文件域 / 产品媒体特性全量收口，跨设备续作）**
>
> **✅ 已完成（本会话；全部已推送 `main == origin/main`）**
> - **数据层**：迁移 016 / 017 / 018 **已在生产执行**（`file_objects` **23 列**；版本化 / 主图 / 排序；生产库逐项复核）。
> - **存储三段**：S3 预签名（SigV4 与 minio-py **逐字符一致**）→ R2 binding → inline；
>   **直传失败自动回退代理且如实告知**；R2 桶 + CORS + 密钥位已就绪。
> - **API（两端齐平）**：文件域 **11+3** 条、`POST /trade-docs/{id}/pdf` 自动出 PDF
>   （Browser Rendering；**未配如实 503**）、单张 + **批量**指纹对账
>   （`/render-fingerprint-checks/batch`，**上限 50**）。
> - **前端**：`/products` 全功能（上传 / 命名 / 分类 / 排序 / 主图 / 下线 / 直链 / 直传）；
>   单证页（图库选图、盖章回传版本化、**人工 + 自动** PDF 归档、**核对指纹**按钮）。
> - **公章**：上传界面（此前**零入口**）+ **默认章自动带入渲染**（内核单一真源）。
> - **C 方案**：签发时冻结渲染指纹 + 对账消费者（**数据被改 / 模板改过分报**）。
> - **迁移链**：空库 **2 处断点已修**（均实测穿过 + 真库 A/B 证明**存量库不变**）。
> - **最终门禁**：orchestrator **1115** / worker **257** / 前端 **373（29 files）** /
>   typecheck 0 / lint 0 / route-parity PASS / contracts **R0–R6 PASS（173 paths）** / sync **31 文件**
>   （均为 lead 与队友实测；文档线未复跑）。
>
> **⏳ 下一台设备续作**
> 1. **用户操作**：重建 R2 S3 密钥（**Access Key ID 必须 32 位**，当前 13 位 ⇒ 生产直传 `400`）
>    → 更新 Worker 两个 secret；确认一次 `wrangler deploy`（`browser` binding 才生效）。
> 2. **验收**：`node scripts/verify-file-storage-e2e.mjs --api https://kaas.powervoy.com --token <jwt>
>    --product chain_link --file <图> --name 验收 --media-kind size`
>    （期望 `storage=s3` + 直链取回字节一致；**验收入口怎么拿见 §5.2 临时换哈希法**）；
>    生产 binding 真实调用；**视觉核对**（盖章版式 / HS 列）。
> 3. **决策**：空库整链边界 `f82ac951b473` 的 **bootstrap 方案**（见本文 §⑨）；
>    要不要**定时调度**（CF Cron Trigger 打批量端点）。
> 4. **测试补充**：db 级用例、页面级测试（其余"未覆盖"见各节 ⏳）。
>
> **🔑 环境提示（换设备必读）**：生产 DSN **不在仓库**；`NEON_API_KEY` 在
> `~/.dsh/neon-api-key.txt`（+ 用户级环境变量），用 `pnpm dlx neon env pull --file <tmp>` 重取；
> **本机临时凭据 / DSN 已清零**。规则 6（克服困难不绕道）已入 `AGENTS.md`。

> **（R82）alembic「双 head」是假警报（已取证；未加任何 merge 迁移）** —— task-16：
> `alembic heads` 实测**只有一个** `202610110018`；55 个 revision 是**单链**，
> `20260922_research_workstation` 是链中**祖先**（`20260921_leadgen_outreach → 20260922_research_workstation
> → 202609230001 → … → 202610110018`），不是 head。双 head 的说法可由 `artifacts/alembic_head.py`
> **复现**：该脚本只认 `revision: str = "…"` 写法，漏掉 3 个 `revision = "…"` 的文件
> （含把情报链接回主链的 `202609230001`），于是把祖先误报成 head（52/55）⇒ **不要加 merge**
> （临时副本实测：加了会凭空造出 `branchpoint`）。
> 同时实测到一个**真问题**：**真·空白库跑 `alembic upgrade head` 会失败**
> （`feb821f0b9c0` 原来无兜底的 `ALTER TABLE quotations ADD COLUMN tenant_id`，而 `quotations`
> 要到更晚的 `f82ac951b473` 才 create，真实库靠 `create_all` 先建）。
> **生产无需任何动作**（时点 2026-10-12；**2026-10-17 生产已升到 `202610170004`**，见顶部交接）：
> `alembic_version` = 单行 `202610110018` = 当时 head，018 已生效
> （`file_objects.sort_order integer NOT NULL DEFAULT 0` 在库里）。详见文末
> 「alembic『双 head』取证 —— 假警报 + 一个真问题」一节。
> **（t18 更新）** 上面那个真问题：**第一个断点已修**（该文件补 `has_table` 兜底）⇒ 实测已穿过
> `feb821f0b9c0`；但**整链仍跑不到 head** —— 下一个 repo 级断点是 `202605170001:279`
> （同类根因），且链还要求 `pg_trgm` / `btree_gist` 两件 contrib 扩展。见文末 §⑧。
> **（t21 更新）** 第二个同类断点（`202605170001:279`）**也已修并实测穿过**；链现在的**边界**是
> `f82ac951b473_intel_workstation_v1`（无条件 `create_table` 36 张、其中 30 张链上早建过 ⇒
> `DuplicateTable`）—— 属**结构性冲突**，按规则**停止硬修**。另：本线期间仓库多了
> `202610110019`（另一条线）⇒ 当时 `alembic heads` 是单 head **`202610110019`**（本线未改任何
> revision/依赖；生产版本行以 §⑤ 实测 `202610110018` 为准，本线未复测）。见文末 §⑨。
> **（2026-10-17 更新）** 现在 head 是 **`202610170004`**，生产 `alembic_version` 也已是 `202610170004`。

> **（R81）收口决定：e2e 停手，主线交付** —— 用户 2026-10-11 追问
> 「还有多少任务未完成、怎么做不完了」，逐项核对后的结论：
>
> | | 项数 | 说明 |
> |---|---|---|
> | ✅ 已完成 | **12** | A1/A2/B1/B2/C1/C2/E、#2b 档位、均价、旧表、反向漂移、
> 前端认证残留、规格库退役、爬取移植（含**修掉生产 SSRF 绕过**）、**团队转让全链路** |
> | 🔶 部分 | **2** | 依赖漏洞（用户已定**单独排期**）、**e2e**（见下，**不阻塞业务**） |
> | ⏸ 待外部 | **3** | 产品定义可视化编辑器（**等用户一句话**）、单证投产联调（需生产环境） |
>
> **e2e 的处置（已停手，不再投入）**：它**不是应用缺陷**。已确认的事实：
> ① 第一批确定性失败已修 —— `quotations.spec.ts` 访问的路由**没有 `page.tsx`**
> （必 404），按现役 `/quotes` 重写后 **4 failed → 0**；
> ② 其余失败**跨运行不稳定**（同代码连续三次：6 / 3 / 5 条，成员每次不同），
> 单条用例 `--repeat-each=5` 自身只有 **60%** 通过率；
> ③ 失败根因是「`/api/v1/*` 请求偶发绕过 MSW → 自代理 → 500/挂起」，
> **已排除 7 个假设**，未收口。
> 详细证据与**已排除的假设清单**见 `docs/E2E_STATUS_2026-10-11.md`。
>
> **为什么花了这么久（如实记录）**：我在 e2e 上投了约 35 轮，而它**不阻塞业务**；
> 其中相当一部分是在纠正**我自己的测量错误** —— 一次用**过滤后的输出**得出
> “0 failed”并误判为“根因找到”（已用整轮撤回）、一次用**关键字 grep** 给失败
> 分类而错判 `events`/`kb`（已更正）。**教训：没有完成定义的线，要在早期降级搁置。**

> **（R71）**：团队管理员转让 **全链路完成**（详细见本文末尾「追加」一节）——
> 后端两端（`9d42f44` / `13389b6`）+ **前端成员面板「转让」入口**（`99f783c`）。
> 另：全套门禁复核全绿（orchestrator 598 / worker 142 / route-parity 缺失 11 /
> contracts R0–R4 / 前端 typecheck 0）。
>
> **e2e 这条线已暂缓**（不阻塞业务），结论独立成文：
> `docs/E2E_STATUS_2026-10-11.md`。要点：**修掉 2 个真实应用缺陷**
> （`customers/page.tsx` 的 `.length` 8 处 + `.map` 4 处，都是"保护了外层对象、
> 忘了数组本身"），**排除 7 个假设**，根因收窄为"`/api/v1/*` 请求不被 MSW 拦截
> 而页面请求被拦"，但**未收口**。
>
> ⚠️ **与上一条并发提示直接相关**：那份 e2e 文档里的"通过数"与"请求超时"
> **很可能被本线的 `next build` / dev 重编译污染**（见上面 R56 那条提示）。
> **所以 e2e 的数字必须在工作区静止时重测才可信** —— 这也许能解释
> 为何几个环境类修复后现象仍在。**在双方都收工前，不要再据 e2e 数字下结论。**
>
> **（R72）取证核对**：上面「已完成」表里的 **24 个提交哈希逐个核验** ——
> `git cat-file -e` 全部存在，且 `git merge-base --is-ancestor … origin/main`
> 全部在远程上 ✓ 即"**全部已推送**"这一栏**经得起取证、没有虚报**。
> 同时把门禁表里的前端测试数**按实测更新为 302 passed / 22 files**
> （原写 291；随本线加测试而增长：280 → 291 → 302）。
> 其余门禁行同轮复核：orchestrator 598 / worker 142 /
> route-parity 缺失 11 / contracts R0–R4 / 前端 typecheck 0 / lint 无 error。

> **最新（R56）**：**单证工位 PI 支持公章与产品照片**（用户裁决「把能力做进平台」，
> 提交 `43be2f7`）。渲染器新增两个按字段名识别的能力字段：`company_stamp`
> （公章，叠印在签章区）与 `product_photos`（产品照片两列网格，排在「金额大写」之后）。
> 值只接受 `data:image/*;base64` 与 `http(s)` 绝对地址，`<img>` 由渲染器拼装并转义
> （不给原始 HTML 开新口子）。模板 / `manifest.json` / 渲染器测试 /
> `TRADE_DOC_TEMPLATES.md` §七 同步更新。**不带图时输出与改动前逐字节一致** ⇒
> 18 份迁移基线不必重生成（`verify-trade-doc-fixtures.py` 仍 18/18 一致）。
> ~~未做：工位页面的「上传公章 / 上传产品图」控件~~ ✅ **已补**（见下条「填写单据内容」，
> `image` 字段就是选文件转 data URI）；仍未做的是**图片走对象存储**与独立素材库。
>
> 另按用户追问补了第三个字段 + 一条版面硬约束（提交 `06a0ba7`）：
> `buyer_confirmation`（**买方回签栏，默认不印** —— PI 是卖方单方出具的要约单据，
> 银行/信用证审单只看 PI 内容与卖方签章；买方回签后 PI 兼任「订单确认书」），
> 以及**两侧签章模块强制等高**：图章位共用常量 `STAMP_SLOT_MM=18mm`，
> 卖方有章时买方留同高空位、无章则两侧都不留，买方 Date 并入说明行 ——
> 实测两个 `.sign-box` **同高（113px）同顶边（1327px）**。
>
> 又补了「**填得进内容**」这条缺口（用户要求把一次性 PI 脚本并入系统）：
> 单证详情页新增**填写单据内容**面板 —— 字段来自模板 manifest、控件按类型生成、
> 图片选文件转 data URI，保存走 `PATCH /trade-docs/{id}` 的 `raw_payload.custom`
> 且**带上 `sources`**（否则抹掉上游快照）；纯逻辑抽成 `lib/trade-doc/custom-fields.ts`
> 并有 8 条测试。另新增通用离线渲染 CLI `scripts/render-trade-doc.ts`
> （读 payload JSON → 复用同一渲染器出 HTML），其产物与本任务最初那份
> 一次性脚本产物 **SHA256 完全一致**。备注 `remarks`/`notes` 改为**逐点换行**。
>
> 又把两处「静静出错」改成了可回归的门禁（同一批）：
> ① **占位符一致性**：新增 `scripts/check-trade-doc-placeholders.ts`
> （`pnpm -C frontend trade-doc:check`，支持 `--fix [--write] [--dump]`）——
> 首轮就抓出 **9 类单证 / 18 个字段**「模板用了但 manifest 没声明 ⇒ 界面填不到、
> 单据静静空白」（PI 的 `remarks` / `shipping_marks` / `country_of_origin` 正在其中），
> 已全部补齐、复检 0 ERROR。`--fix --write` 带「写前 `JSON.parse` 校验、不过拒绝写盘」
> 的安全网（开发中它两次拦住我自己写错的结构：多一个空行、多一个尾逗号）。
> ② **签章区不可被分页切开**：共享样式加
> `table.sign, table.sign tr, table.sign td, .certify, .foot { break-inside: avoid }`
> —— 原先只保护内层 `.sign-box`，签章表**左右两格可能被分到两页**。
> 实测发现 **Chromium 忽略 `break-before/after: avoid`**（给 `table.sign` 加与不加，
> 产物 SHA256 完全相同），所以"签章绝不孤零零落在新页"**纯 CSS 保证不了**，
> 已写进 `TRADE_DOC_TEMPLATES.md` §九（真要做得动 18 个模板加包裹层）。
> 归档镜像 `_shared.css` 同步改（否则「TS == 归档 Python」的逐字节证明会断），
> 基线重生成后仍 **18/18**。
>
> 用户随后裁决的三条业务边界也已落地（同一批）：
> ① **custom 不得覆盖金额与行项**：共享内核
> `PROTECTED_CUSTOM_FIELDS = ("items", "total_amount")`，**两层防护** ——
> 写路径（orchestrator / worker 的 POST、PATCH）返回 422 `CUSTOM_FIELD_PROTECTED`；
> `build_render_data` 再跳过一次，**即便库里已有历史脏数据，渲染出的单据也骗不了**；
> 界面把这两项渲染成只读（并说明「改了上游再重新带入」）。
> ② **改动留痕**：PATCH `raw_payload` 时把逐字段 diff（长值只留摘要，避免 1.4MB 的
> 图片 data URI 撑爆审计）追加到 `raw_payload._audit`（最多 20 条）；
> **客户端自带的 `_audit` 一律丢弃**，否则调用方能伪造/清空自己的审计。
> ③ **离线件标识**：`scripts/render-trade-doc.ts` 默认在页脚打
> `OFFLINE COPY — not a ledger record`（`--no-watermark` 可关）—— 离线出的单**不进台账**
> （不取号、无签发状态、无客户归属与团队隔离校验），标识避免它被当成正式件发出。
> 门禁同轮复核：orchestrator **598 passed / 1 skipped**、worker **142 passed**、
> 前端 trade-doc **75 passed**、contracts R0–R4 PASS、route-parity PASS、
> sync-shared 23 / 19 / 1 一致。
>
> ⚠️ 本轮实测发现**工作区正被另一条线并发使用**：同一仓库另一条 DSH 会话在跑 e2e，
> 它已提交 `f286fc4` / `ca43ddc`，并在提交说明里声明不碰本线文件。双方都只 `git add`
> 自己的文件。凡"通过数"层面的对比都要打折（对方的 Next dev 与我的 `next build`
> 都会造成对方 e2e 的重编译/中断）。

> **（R55）**：按用户裁决新增**团队管理员转让**端点
> `POST /teams/{team_id}/transfer` —— **现任团队管理员或平台管理员**都能发起
> （复用 `_require_team_admin` → 共享内核 `is_team_admin`，**不新增授权规则**），
> 策略无关校验复用共享内核 `validate_transfer_target`（已测 9 条）。
> ✅ **worker 侧已补齐**，allowlist 登记已删除 —— 两端齐平（`route-parity`
> 缺失回到 **11**），**线上不再 404**。
>
> 用户另已裁决：**e2e 以现役 UI 重新基线化**（尚未开工）；
> 可视化编辑器要干什么、单证投产联调仍需环境/输入。

> **新开对话 / 上下文压缩后，先读这一节**，再往下看细目。
> 下面「方法」一节的数字是**写本文时**的，已过期；以本节为准。

### 已完成（全部已推送 `origin/main`）

| # | 事项 | 提交 / 动作 |
|---|---|---|
| A1 | worker 补「单证合计 = 行项合计」金额勾稽 | `c2ee256` |
| C1 | 删除 `kaas_common/db` 共享 Repository 死代码 | `e6b54e5` |
| C2 | worker 客户可见性判定与共享内核 `customer_rules` 对齐 | `7688b77` |
| B1 | 生产库 schema 对齐（当时落后 **14 个迁移**）+ 租户统一 | `2a46e63` + 生产库迁移 |
| B2 | 新团队试用工位 —— 用户裁决**维持现状**，无需改动 | — |
| A2 | 规格体系改自由数值 + 三产品（牛栏网/勾花网/鹿网）+ 前端退役枚举轴 | `f6b4b62`…`6d27b39` |
| — | 体积扣减由固定 m³ 改**比例**（修掉小单负体积） | `b337251`、`8eead90` |
| — | **用智能表格真实数据核算引擎**（公式级不一致 0） | `c7d096e` |
| #2b | 团队级档位**改显示名 / 软停用**（双侧 + 生产库迁移 `202610110015`） | `f3a8196`…`f61a41d` |
| — | 原料价**历史参考均价**（未新建历史表，见下） | `043c72d` |
| — | **反向漂移 8 条**结项（6 修 + 2 有意保留） | `65db192`、`2a158cb` |
| — | **爬取移植**：补 worker 侧 + orchestrator 侧，dev 的「批量爬取」404 修好 | `e578941`…`2a158cb` |
| — | 顺带**修掉生产 SSRF 绕过**（重定向 → 云元数据） | `eb3c100` |
| — | **前端认证契约残留**收口（不再发 `X-Tenant-Id`） | `35a89a8` |
| — | **规格库 11 条退役**（用户裁决：写死的设计没用了） | `8225bbf` |
| — | 立 `AGENTS.md` 收录全局规则（更新须带文档 + 推送） | `9250376` |
| — | 单证工位 PI **公章 + 产品照片 + 买方回签栏（两侧等高）**字段（渲染器 / 模板 / manifest / 测试 / 文档） | `43be2f7`、`06a0ba7` |

### 当前门禁（**工作区静止**时实测；并发写期间构建会假红）

| 门禁 | 结果 |
|---|---|
| orchestrator `pytest -m unit` | **946 passed** / 1 skipped（**lead/队友实测**；文档线未实跑，其此前实测为 711） |
| worker `pytest` | **217 passed**（**lead/队友实测**；文档线未实跑，其此前实测为 176） |
| 前端 `test` | **363 passed / 29 files / 0 failed**（**lead 实测**；**本轮未改前端**；增长链：280 → 291 → 302 → 304 → 325 → 354 → 363） |
| 前端 `typecheck` / `lint` | exit 0（lint **0 error / 9 warning**，warning 均为既有） |
| `contracts:check` | R0–R4 PASS（**R2 = 26 工位** ts↔py 一致） |
| `route-parity.py` | PASS（缺失 **11** 已登记 / 未登记 0 / **过期 0** / worker 独有 **2**） |
| `sync-shared.ps1 -Check` | exit 0（共享内核 **30** / 报价引擎 **20** / 枚举字典 1；**lead/队友实测**） |
| `verify-trade-doc-fixtures.py` | 18/18 逐字节一致（TS == 归档 Python；图片字段改动后仍成立） |
| `pnpm -C frontend trade-doc:check` | exit 0（模板占位符 ↔ manifest 一致；首轮抓出 9 类 / 18 字段并已补齐） |
>
> 本轮（2026-10-12 凌晨）更新：orchestrator **946** / worker **217** / 共享内核 **30** / 报价引擎 **20** /
> 前端 `test` **363 / 29 files**（**本轮未改前端**）/ `route-parity` PASS —— 均为 **lead 与队友实测**
> （**文档线本轮按规定未跑门禁**；文档线此前的实测值为 711 / 176 / 27·19 / 354·28，可与上表对照）。
> `contracts:check` 行沿用前次结果；`NEXT_EXPORT` 构建见下行。
> 其余行仍为 `d4b4cdc` 实测（2026-10-11）。
| `NEXT_EXPORT=1 pnpm build` | **lead 实测 exit 0**（`NEXT_DIST_DIR=.next-build`）。⚠️ 但**文档线本轮在并发写期间复跑失败**：`PageNotFoundError`/ENOENT（`load-components`），当时另一条线正在改 `frontend/src/mocks/*`（22:49–22:54）⇒ 该隔离**只隔离产物目录、不覆盖源码并发写**，**取数前必须确认工作区静止**（见「追加」§构建门禁） |
| `scripts/verify/verify_against_sheet.py` | exit 0（公式级不一致 0） |

### 关键环境事实（踩过的坑，别再踩）

- **租户 ≠ 团队**：`tenant_id` 恒为 `"default"`（**已不是隔离边界**）；
  **`team_id` 才是**。定价/成本那条路**完全不按 team 过滤**，
  但通过 `customers.team_id` 事实上已隔离。
- **node/npm 实际可用**（2026-10-17 实测：`node` v24.20.0 在 PATH、`npm.cmd` 可用；
  `npm.ps1` / `npx.ps1` 只是被执行策略拦，用 `npm.cmd` 或先
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`）；**只有 `pnpm` 不在 PATH**，用
  `C:\Users\河北慷逊公司\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
  + `...\pnpm\bin\pnpm.mjs`。
- 跑 `.ps1` 前必须 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`。
- **本地产物不进仓库**：PI 导出、QA 快照、一次性生成脚本一律放 `artifacts/`
  （已在 `.gitignore`）；仓库根目录不留快照。成果要归档走数据库或正式文档。
- **出 PDF 不要用 ego 浏览器打印**：它会把光标/「DeepSeek」浮标（`position:fixed`
  的注入元素）印进 PDF 并在**每页重复**，而 PDF 内容流是压缩的 ——
  拿"字节里搜不到 DeepSeek"当证据是**伪证**。正确做法：系统 Chrome 无头打印
  （`--headless=new --no-pdf-header-footer --print-to-pdf`），再用
  `libreoffice-kit render`（pdfium 后端）渲图**逐页肉眼看**复核。
- `wecom-cli`：旧记录的 `C:\Users\HJ\wecom-cli-tool\node_modules\.bin` 在本机**不存在**；
  用 `where wecom-cli` 定位。前置检查 `--version` ≥ 1.2.1 + `auth show --status`。
- 生产库 = Neon `KaaS` / `production` 分支。DSN 取
  `neon connection-string production --database-name neondb`，
  **要 `-replace '^postgresql://','postgresql+asyncpg://'`** 才能喂 alembic。
- 智能表格：「客户询盘跟进表 → 明细表」21 行 / 55 字段。
  **没有鹿网的数据行**（所以鹿网只能用公式逐点比对，不能拿数据核）。
- 报价引擎与共享内核**都要镜像到 worker**：改完跑 `pwsh scripts/sync-shared.ps1`，
  否则 worker 端是旧的（本人踩过，差点漏）。

### 还没做的（建议顺序）

1. ~~**反向漂移 8 条**~~ ✅ **已结**：6 条修掉（webhook 收敛 4 + 爬取端点 2），
   余 2 条 `subscriptions` 有既有裁决「有意保留」。详见下「反向漂移：逐条取证与处置」。
2. ~~**前端认证契约残留**~~ ✅ **已收口**（`35a89a8`）：前端不再发 `X-Tenant-Id`，
   `Session` 不再带 `tenant` 字段。原因见下。
3. **接口级测试**（#2b 与均价都只有纯函数单测）、**前端档位管理界面**。
4. ~~规格库 11 条接口~~ ✅ **已退役**（`8225bbf`）/ e2e 归真 🔶 **进行中**
   （"26 条"里大部分是环境问题，已修到 18 条真实失败，见下）/
   产品定义可视化编辑器 / 团队管理员转让 / 单证投产联调。
5. ~~依赖漏洞 98 个~~ 🔶 **部分**：已降到 **78**，critical 3 → 2；
   余下 2 个 critical **全是 `next`**，只能在 Next ≥ 15.5.24 修
   （即 14→15 跳大版本，而 Next 15 又要求 React 19）——用户已定**单独排期**。
6. **技术栈升级盘点（2026-10-17）**：Next 14.2.35 / Node 20（CI）/ ESLint 8 / TypeScript 5.9
   已落后当前稳定线两代；audit 复扫 **80 条**（2 critical / 19 high / 48 moderate / 11 low，
   npmjs registry 口径）——2 个 critical 仍是 Next image optimizer 的 RCE，生产走静态导出 +
   `images.unoptimized`，实际暴露面有限，但 14.x 已不再有新补丁公布。
   完整依赖矩阵与 A/B/C/D 批次路线见 `docs/TECH_STACK_UPGRADE_2026-10-17.md`；
   **2026-10-17 用户裁决：暂不执行升级，只落评估文档**。

### 依赖漏洞已降 98 → 78（`b5b6f4d`）

### 规格库 11 条：精确范围与两次更正（2026-10-11，**待用户定**）

用户追问「规格库是什么、怎么设计的、为什么弃用、被什么替代」，
核查过程中我**先说了两次不准确的话，在此一并更正**：

**更正 1**：我曾说「这 11 条正是产品定义可视化编辑器的后端」——
**没核实就下的判断**，收回。

**更正 2**（更重要）：我接着说「规格库是 INT-R3 死代码、可以退役」——
**范围下宽了**。核查 `frontend/src/app/(app)/spec-config/` 后发现
**同一片区域里有活的页面**：

| `spec-config` 实际调用的 | 状态 |
|---|---|
| `/spec/categories`、`/spec/categories/{id}/bindings`、`/spec/categories/{id}` | **活的**（`app/api/categories.py`） |
| `/spec/wizard/propose-attribute`、`/spec/wizard/submit` | **活的**（`app/api/quote_wizard.py`） |
| `/product-specs`、`/spec/attributes/*`、`/spec/skus/*`、`/spec/templates/*`（**那 11 条**） | **它一条都没调** |

而且 `/spec/categories/{id}/bindings` **直接连到属性表**
（`category_attribute_bindings`）。所以「退役整个规格库」会**砸掉活的页面**。

#### 已核实的范围（这部分证据是硬的）

- 那 **11 条**接口：前端 **0 调用**；对应 7 张表在生产库 **全 0 行**（实测）
- 文档 `CURRENT_IMPLEMENTATION_MAP.md:94` 明确：**规格体系（权威）**＝
  `app/services/export_quote/products/*.py` + `/export-quote/products/{key}/formulas`；
  「旧扁平模型」列在 **⛔ 遗留 / 不要改** 一侧

#### 它的设计（业务实现）

一条表驱动 PIM 流水线：

```
类目 ─> 属性库 ─> 规格组合 ─> spec_hash ─> SKU ─> 价格
        spec_attributes          SHA-256前16   product_skus  product_sku_prices
        spec_attribute_values
             ↑ category_attribute_bindings（哪些属性属哪个类目）
```

`spec_hash` = 规格组合做 **Canonical JSON**（sorted keys + `ensure_ascii=False` +
固定分隔符）→ SHA-256 前 16 hex，即 **SKU 的身份证**。
另有属性**沉淀**（`attribute_proposals`）与**相似搜索**（`find_similar_attributes`，
防重复建）。设计本身不粗糙，只是**每加一个产品/属性/取值都要动数据库行**。

#### 被什么替代

`ProductSpec` —— **产品定义即代码**：
属性库 → `axes`/`variants`/`numeric_inputs`（**自由数值不枚举**，组合数不爆）；
SKU 表 → **运行时展开**（`expand_specs`/`spec_from_partial`/`combo_count`）；
行业模板 → 每个产品一个 Python 模块（`derived(FormulaSpec)` 把公式声明成数据结构）；
SKU 价格表 → 定价键 + 定价数据（按买家）+ 团队级档位覆盖（#2b）。

#### 用户裁决：**退役**（`8225bbf`）

用户先确认了理解方向，并给出条件：

> 「以前规格是写死的，变一个参数就是新增一个规格，现在规格参数是自定义的
> 自由数值了 —— 那这套写死的设计确实就没用了，**在确保安全的前提下可以移除**。」

（措辞上补一处细节：新模型**并非"一切皆自由数值"**——它仍支持
`axes`（枚举轴）与 `variants`（关联属性包），变的只是牛栏网那 8 个参数
改成了自由数值。准确说法是：**哪些是枚举、哪些是自由值，由产品定义自己声明**，
不再由一张全局属性表规定。）

**实际移除范围**（只到"无人调用的 11 条接口"这一层）：

- 删除 4 个路由文件：`attributes.py`(5) / `skus.py`(3) / `templates.py`(2) /
  `product_specs.py`(1) = **11 条路由，−407 行**
- `main.py` 去掉 4 个 import + 4 个 `include_router`
  （同一次调用里**立刻 import 验证**，不留"删了还在引用"的中间态）
- allowlist 撤掉那 11 条登记 → `route-parity` 缺失 **22 → 11**

**没有动的**（安全边界，逐项核实）：

- `skus_repo`（**`app/api/prices.py` 还在用**）
- `attributes_repo` 与表模型（**活的** `/spec/categories/{id}/bindings` 在用）
- 同一片区域的 `/spec/categories` 与 `/spec/wizard/*`（前端 `spec-config` 页面**在用**）

allowlist 里已写注释提醒后来者：**这片区域不是整片死的，不要顺手清**。

### e2e「26 条失败」：大部分是**环境问题**，不是产品缺陷（2026-10-11 实测）

逐层查下去的结果 —— **不要因为门禁里写着"26 条失败"就去改应用代码**：

| 层 | 发现 |
|---|---|
| ① | `frontend/playwright.config.ts` 的 `webServer.command` 是 **`npm run dev`**，而**本环境没有 `npm`** → 服务起不来 → 全部 `ERR_CONNECTION_REFUSED` |
| ② | 手工起 dev server 后，报错变成明确的 **`pnpm exec playwright install`** → **Playwright 浏览器压根没装** |
| ③ | 装上 Chromium（`playwright install chromium`，111.5 MiB）后重跑 |

**结果：25 失败 → 18 失败 / 6 通过 / 1 跳过。**

也就是说：**7 条纯粹是"浏览器没装"，约 10 条是"服务没起来"**，
真正需要查的是剩下 **18 条**（可能是应用问题，也可能是 mock/fixture 没跟上）。

复现方式（本环境）：

```powershell
# 1) 手工起 dev server（配置里的 npm 在本环境不可用）
#    NEXT_PUBLIC_API_MODE=mock，mock 模式不需要数据库
# 2) 不设 CI，让 Playwright 复用已在跑的服务（reuseExistingServer）
# 3) 跑：playwright test --reporter=line
```

**待修（不该拖）**：`webServer.command` 硬编码 `npm run dev`，
导致**任何没有 `npm` 的环境都跑不了 e2e**。建议改成可覆盖
（`process.env.E2E_WEB_SERVER ?? 'npm run dev'`）——保留原默认，
又不把整个套件锁死在 `npm` 上。

#### ✅ 已修：`E2E_WEB_SERVER` 可覆盖（已验证）

`frontend/playwright.config.ts` 的 `command` 改为
`process.env.E2E_WEB_SERVER ?? 'npm run dev'`。
已实测：设 `E2E_WEB_SERVER` 后 **Playwright 自己起服务并把整套跑完** ✓
（不再需要手工起 server）。

#### 🎯 18 条失败的**根因已定位**：e2e 的 mock 夹具缺 auth（**不是应用缺陷**）

追查链条：

1. 页面快照里主区域只有一句 **「您没有访问此页面的权限」**（不是白屏、不是报错）
2. 该文案出自 `components/route-guard.tsx`，触发条件是
   `adminOnly && user?.account_type !== "internal"`
3. `lib/auth/auth-context.tsx:60`：
   `account_type: (data.account_type as ...) ?? "customer"` ——
   **缺失时默认成 `"customer"`**（非管理员）
4. 而 `mocks/handlers.ts` 里**根本没有 auth 处理器**（`auth/login`、`auth/me` 都没 mock）
   → mock 模式下会话里没有用户 → `account_type` 缺失 → 一律按 `"customer"` 处理

**交叉验证**：失败清单 `/events`、`/customers`、`/kb`、`/settings`、
`/audit-log`、`/admin/gray-release` **正好等于**用 `<RouteGuard adminOnly>` 的页面
（全仓共 7 处），而 6 条通过的用例都是**不需要**该守卫的页面。

**结论：应用没问题，是 e2e 的假数据层缺了 auth。**

**下一步（已明确）**：在 `mocks/handlers.ts` 补 `POST /auth/login` 与
`GET /auth/me` 两个 handler，返回一个 `account_type: "internal"` 的管理员用户。
补完应大幅减少失败数；剩下若仍有失败，才是真正需要查的应用问题
（`/quotations` 那几条不在这 7 个 adminOnly 页面里，可能另有原因）。

#### 🎯🎯 更底层的真因（**解释力最强**）：客户端打的是 `:8000`，MSW 只匹配 `:3000`

上一步的假设**不完整**（补了 mock handler + 种了 token 后**仍是 18 failed**）。
继续查才找到真正的原因链：

| 来源 | 值 |
|---|---|
| `frontend/.env.development` | `NEXT_PUBLIC_API_MODE=real`、**`NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`** |
| playwright `webServer.env` | 只覆盖了 `API_MODE=mock`，**没有覆盖 BASE_URL** |

于是：

1. `lib/api/config.ts` 的 `API_BASE_URL` 取到 **`http://localhost:8000`**
   （`.env.development` 在 dev 模式下会被 Next 加载）
2. 客户端请求变成 **`http://localhost:8000/api/v1/...`**
3. 而 MSW 的 handler 写的是**相对路径**（`http.get("/api/v1/events")`），
   浏览器里只匹配**页面源** = `http://localhost:3000` → **跨源不匹配**
4. `components/msw-provider.tsx` 用的是 `onUnhandledRequest: "bypass"`
   → 未匹配的请求**放行到真实网络** → `:8000` 无人在听 → **全部失败**
5. 连 `/auth/me` 也失败 → `AuthProvider` 的 catch 清掉会话 →
   页面只剩外壳 +「您没有访问此页面的权限」

**这也解释了为什么失败清单"正好等于 adminOnly 的页面"** ——
不是权限逻辑的问题，而是**所有数据请求都失败**，而 adminOnly 页面
额外把"没有用户"直接渲染成"无权限"，于是看起来像权限缺陷。

#### 已验证的进展与**新暴露的问题**（`BASE_URL` 指向页面源）

在 `playwright.config.ts` 的 webServer env 里补
`NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3000'` 后实测：

| | 之前 | 之后 |
|---|---|---|
| 通过 | 6 | **10** |
| 失败 | 18 | **14** |

**但同时暴露**：Next 有 rewrite 把 `/api/v1/*` 代理到 `API_BASE_URL`，
于是**未被 MSW 匹配的路径会"自我代理"**：

```
[WebServer] Failed to proxy http://localhost:3000/api/v1/teams/me
            AggregateError [EADDRINUSE]
```

`/api/v1/teams/me`、`/api/v1/me/workstations` 这些**mock 里没有 handler**，
bypass 后落到 rewrite，自己代理自己 → 报错。

**所以还剩 14 条不是单一原因**，至少两件事：

1. **mock 覆盖不全**：补 `/teams/me`、`/me/workstations` 等缺失 handler
2. **rewrite 与 mock 的相互作用**：需要让未匹配请求**明确失败**（便于发现缺口），
   而不是自我代理绕一圈

⚠️ 本轮**未**声称"e2e 已归真"——14 条失败仍在，只是根因比"26 条产品缺陷"清楚得多。

#### 再进一步：把"静默放行"改成"打印缺口"，失败模式随之**换了一种**

`components/msw-provider.tsx` 把 `onUnhandledRequest` 由 `bypass` 改成 `warn`：
**放行行为不变**，但未匹配的请求会在浏览器控制台**被点名**。
（原先 `bypass` 是**静默**的，这正是这个坑拖了很久的原因。）

实测：14 failed / 10 passed → **13 failed / 11 passed**。

**更关键的是失败模式变了**——events 页面的快照现在渲染出真实内容：
「事件审计」标题 + 过滤条 + 租户 ID 输入框，**"您没有访问此页面的权限"彻底消失** ✓

新的失败原因（看 events 的快照）：

```
Test timeout of 30000ms exceeded.
Error: page.waitForLoadState: Test timeout of 30000ms exceeded.
```

即 `await page.waitForLoadState('networkidle')` **永远不满足**。结合前面的
`EADDRINUSE` 就有完整解释：

> **未被 mock 的端点** → `bypass` → 命中 Next 的 `/api/v1/*` rewrite →
> **代理到自己**（`EADDRINUSE`）→ **请求永远不结束** →
> `networkidle`（要求 500ms 无网络活动）**永远不触发** → 所有用它的用例超时。

**所以修法是明确的**：把 mock 缺的 handler 补齐，让**没有任何请求 bypass**，
自代理自然消失。缺口清单（从 `EADDRINUSE` 日志与调用点推断，待逐个确认）：

`/api/v1/teams/me`、`/api/v1/me/workstations`、`/api/v1/admin/deployment_audit`、
`/api/v1/admin/feature_flag`、`/api/v1/admin/tenants`、`/api/v1/admin/audit-log`

**剩余 13 条**：admin-gray-release ×3、events ×4、quotations ×4、customers ×1、dashboard ×1。

#### 关键反转：不是 handler 缺失，是**请求发得太早**

用 dev server 的 self-proxy 报错抓"地面真相"（**被 rewrite 代理 = 没被 MSW 匹配**）：

```
/api/v1/auth/me          ← 有 handler
/api/v1/events           ← 有 handler
/api/v1/customers        ← 有 handler
/api/v1/dashboard/summary ← 有 handler
/api/v1/admin/audit-log、/admin/deployment_audit、/admin/feature_flag、
/admin/tenants、/me/workstations、/teams/me   ← 这些确实没 handler
```

**前四个明明有 handler 却仍然 bypass** —— 说明主因不是"缺 handler"，而是：

> `MswProvider` 原先「立刻渲染 children + 在 effect 里异步 `worker.start()`」，
> 而 React Query **在挂载时立刻发 fetch**。等 `worker.start()` resolve，
> 请求早已发出去了 → **首屏那一批全部绕过 mock**。

**它伪装得很好**：被绕过的偏偏是 `/auth/me`、`/events`、`/customers`、
`/dashboard/summary` 这些**本来就有 handler** 的端点，于是看起来像
"handler 缺失"或"权限不足"。

#### 修法：MSW 就绪门（`8a…` 本轮）

`components/msw-provider.tsx` 改成 **mock 模式下先 `return null`，等
`worker.start()` resolve 再渲染 children**；并且**起不来也要放行**
（一个 mock 故障不能把整个应用卡成白屏）。

实测：13 failed / 11 passed → **10 failed / 14 passed**（再 +3）。

#### 收敛轨迹

| 轮次 | 失败 / 通过 | 认识 |
|---|---|---|
| 起点 | "26 条" | 以为是一批产品缺陷 |
| R34 | 25 / 6 | 环境缺 `npm` + 缺浏览器 |
| R36 | 18 / 6 → 14 / 10 | 客户端打 `:8000`，MSW 只匹配 `:3000` |
| R37 | 13 / 11 | 失败模式变为自代理挂死 → `networkidle` 超时 |
| R38 | **10 / 14** | **不是 handler 缺失，是 MSW 启动晚于首屏请求** |

**仍未归真**（10 条）。仍需补的 handler（这部分确实是缺口）：
`/admin/audit-log`、`/admin/deployment_audit`、`/admin/feature_flag`、
`/admin/tenants`、`/me/workstations`、`/teams/me`。

#### ⚠️ 更正：上面那份"缺口清单"**大部分是错的**；并记一次**我自己造成的回归**

逐个核对 handler 清单后发现：`/admin/feature_flag`、`/admin/deployment_audit`、
`/admin/audit-log`、`/admin/tenants`、`/auth/me`、`/events`、`/customers`、
`/dashboard/summary` **全都有 handler**。真正缺的只有 **2 个**：
`/me/workstations`、`/teams/me`。

（它们"出现在 self-proxy 日志里"只说明**被绕过了**，不等于**没有 handler**。
把日志当成"缺口清单"是我的误读。）

##### 🔴 回归：我给 fail-open 契约返回了"成功的空结果"，把成绩从 10/14 打成 22/2

查文档字符串得知这两个端点的契约是 **fail-open**：

> `/me/workstations` 失败 → `snapshot.ok = false` → 前端**一律放行**

我据此给了"良构的空结果"：`{ ok: true, workstations: [] }` 与 `{ team: null }`。
**结果实测 10 failed / 14 passed → 22 failed / 2 passed**，几近全灭。

原因是语义被**反转**了：

| 响应 | 前端读到 | 结果 |
|---|---|---|
| 请求失败 | **未知** → 放行 | 能用 |
| `{ok:true, workstations:[]}` | **确定没有工位** → 拒绝 | **全部路由被挡** |

**教训：对 fail-open 契约，"成功的空结果"比"失败"更糟。**
契约写的是"失败就放行"，就**不能**用一个断言式的空结果去替它回答 ——
那等于把一个"我不知道"改写成"我确定没有"，而且方向恰好相反。

已**回退**该改动（回到 10 failed / 14 passed 的状态）。
正确做法是让 mock 返回 e2e **真正需要的那份数据**（团队 + 已开通的工位），
而不是"空"或"失败"——留待下一轮。

#### ✅ 按正确形状补上后：**9 failed / 15 passed**（比回退前更好）

找到确切契约 —— `lib/workstation/visibility.ts` 的 `parseMyWorkstationsPayload()`：

```ts
if (!body || !Array.isArray(body["workstations"])) return null;   // 形状不认识 = 当没读到 → 放行
isPlatformAdmin: body["is_admin"] === true,
hasTeam: typeof body["has_team"] === "boolean" ? body["has_team"] : null,
```

**这解释了我上次的回归**：我返回的 `{ok:true, workstations:[]}` **形状是被认识的**，
于是走进 parse 分支、而 `has_team` 缺失 → `null` → 被当成**没有团队** →
`no-team` → **锁死所有工位路由**。
（讽刺的是：若形状**完全不认识**，反而会返回 null 走放行路径。）

正确响应是**如实回答**（mock 登录用户本就是平台管理员 `role=system_admin`）：

```ts
{ workstations: [...SUBSCRIBABLE_WORKSTATIONS], codes: ["full_chain"],
  is_admin: true, has_team: true }
```

外加 `/teams/me` 返回一个团队（形状照后端 `_team_out`）。
工位清单**直接 import** 前端唯一真源 `SUBSCRIBABLE_WORKSTATIONS`，不抄第二份。

实测：10 failed / 14 passed → **9 failed / 15 passed**。

**剩余 9 条**：admin-gray-release ×2、audit-log ×1、customers ×1、dashboard ×1、quotations ×4。
另有 8 个**已有 handler 的路径仍在被绕过**（`/auth/me`、`/events`、`/customers`、
`/dashboard/summary`、`/admin/*`）—— 说明还有一层时序原因没查（不再是缺 handler），
但影响已显著减小。

#### 开放问题：为什么**已有 handler 的路径仍被绕过**（已排除两个假设）

**已排除 ①：挂载层级不对。** 查 `frontend/src/app/layout.tsx`：

```
34: <MswProvider>
36:   <AuthProvider>
43:   </AuthProvider>
45: </MswProvider>
```

`MswProvider` **在 AuthProvider 外层** ✓ —— 就绪门理应拦住 `AuthProvider`
发出的 `/auth/me`。所以"gate 包错层"这个假设不成立。

**已排除 ②：handler 缺失。** 这些路径的 handler 逐个核对过，都在。

**剩下的方向**（下一轮用证据查，不猜）：

- MSW 的 `warn` 消息打在**浏览器控制台**，而 Playwright 默认**不转发**到
  stdout（所以我在 server 日志里只看到 rewrite 的 `EADDRINUSE`，
  看不到"哪个请求没匹配"）。**下一步应该先加
  `page.on('console')`** 把控制台转出来 —— 那样"未匹配请求"会被**逐个点名**，
  比现在从 rewrite 报错反推可靠得多。
- 也要看是否为**首次导航**特有（service worker 激活竞态），
  还是每次导航都发生。

#### ⚠️ 更正：上面这段优先级判断**写反了**

我当时写「被绕过与那 9 条失败不是一一对应，所以优先级更低」——
**这是错的**，下一轮的取证直接推翻了它。

看 `customers` 用例的页面快照（`table tbody tr` 找不到）：

```yaml
- heading "页面加载异常" [level=2]
- paragraph "后端繁忙，请稍后重试"
- button "重试"
```

**页面进的是错误边界，不是"数据为空"**。也就是说那些请求**是失败(error)**，
而不是"少一次数据" —— 失败 → 错误态 → 没有表格。

`quotations` 的同款失败也是一样（`table tbody tr` 找不到、主区域无内容）。

**所以"被绕过"就是剩余 9 条失败的原因**，而且那条线索的优先级应当**最高**。
我上一轮把"多数用例仍通过"当成了"影响不大"的证据 ——
其实是那 9 条恰好依赖首屏数据，其余的运气好而已。

#### 试过 `onUnhandledRequest: "error"` 来自证缺口 —— **失败，已回退**

想法：让未匹配的请求**直接抛错**，这样它会出现在 Playwright 的失败信息里
（自带请求路径），不必再去转发浏览器控制台。

**实测不行**：9 failed / 15 passed → **19 failed / 5 passed**（明显更差），
且 MSW 的点名**仍然没进 stdout**。

从日志里能确认这一点 —— 那些错误**不是** MSW 的，而是 dev server 在
**自己代理自己**：

```
28 × [WebServer] Error: connect EADDRINUSE ::1:3000
28 × [WebServer] Error: connect EADDRINUSE 127.0.0.1:3000
14 × [WebServer] Error: connect ENOBUFS ::1:3000
14 × [WebServer] Error: connect ENOBUFS 127.0.0.1:3000
 4 × Error: expect(locator).toBeVisible() failed
```

（`ENOBUFS` = no buffer space，出现 14 次，值得留意是资源症状。）

**结论**：`error` 只让套件更差、没换来可见性，**已 `git checkout` 回退 `warn`**（9/15）。

#### 剩下唯一可行的取证路径

MSW 的 `warn` 走 `console.warn`，而 **Playwright 默认不转发页面 console 到
stdout**。要拿到"是哪个请求没匹配"，只有一条路：

**加一个 fixture 转发 `page.on('console')`** —— 而这需要把 8 个 spec 文件的
`import { test } from '@playwright/test'` 改成从 fixture 导入（每个文件一行，
机械且有风险低）。这是下一步的**唯一**选项，不要再试 `error` 模式。

#### fixture 已就位；但**批量改 spec 时我又踩了一个坑（已回退）**

`frontend/e2e/fixtures.ts` 已写好（把 MSW 的「未匹配请求」警告从页面 console
转发到 stdout，且**只转这一条**，避免日志被淹）。

改 8 个 spec 的 import 时，我图省事用了 PowerShell 批量文本替换：

```powershell
Set-Content -Path $p -Value $n -NoNewline -Encoding UTF8
```

**结果把文件写坏了**，`typecheck` 直接报：

```
e2e/kb.spec.ts(21,1): error TS1005: '}' expected.
```

（PS 5 的 `-Encoding UTF8` 会写 BOM，配合 `-NoNewline` 与中文内容，
文件被破坏或截断。）已 `git checkout -- frontend/e2e/` 全量回退，
复验 `typecheck exit 0` ✓。

> **教训：不要用 PowerShell `Set-Content` 重写源码文件做机械替换。**
> 这个仓库的源文件是 UTF-8 + LF，PS 的编码/换行处理会破坏它们。
> 要么逐文件用 `apply_patch`，要么用保留字节的工具。

**下一步**：把这 8 个 spec 的 import 用 `apply_patch` **逐个**改成
`from './fixtures'`（每个文件一行），然后跑 e2e 拿到"未匹配请求"的清单。

#### ✅ 做完了，而且 fixture 立刻抓出**一个真实的应用缺陷**

改了 8 个 spec 的 import（用 `[System.IO.File]::WriteAllText` + 无 BOM 编码，
**行数不变 + `typecheck` exit 0** 双重验证；对比 R44 的 `Set-Content` 事故）。
fixture 一转出 console，**当场**就看到了真正的原因：

```
GET /__nextjs_original-stack-frame?...errorMessage=
    TypeError%3A+Cannot+read+properties+of+undefined+(reading+'length')
    ...file=...%2Fcustomers%2Fpage.tsx&methodName=CustomersPage
```

**`CustomersPage` 抛 `TypeError: Cannot read properties of undefined
(reading 'length')`** —— 页面是**崩进错误边界**（「页面加载异常 /
后端繁忙，请稍后重试」），不是"没有数据"。**这是整轮 e2e 排查里
第一个真实的应用缺陷**，前面几轮全是环境/夹具/时序。

**根因**（`app/(app)/customers/page.tsx`，8 处）：

```ts
detail?.contacts.length ?? 0     // 保护了 detail，**没保护 contacts**
detail.contacts.length           // 连 detail 都没保护
listData?.items.length === 0     // 同样：保护了 listData，没保护 items
```

接口响应里缺 `contacts` / `inquiries` / `stage_log` / `items` 时**直接抛错**。
（对照：`lib/workstation/visibility.ts` 的注释早就写明"形状不认识就返回 null，
**别把字段缺失当成 0**"——同一类问题在别处已经防住了，这里漏了。）

**已修**：8 处全部改成 `detail?.contacts?.length ?? 0` 这种正确写法。
复跑后 `reading 'length'` 的命中数 **0** ✓，`typecheck` exit 0 ✓。

#### ⚠️ 但复跑暴露了更该记的一件事：**这套 e2e 是 flaky 的**

同一份代码（含上面的修复），**连续两次运行**：

| 运行 | 结果 |
|---|---|
| 修复前一次 | **16 passed** |
| 修复后一次 | **9 passed** |

TypeError 已归零，修复本身不可能让结果变差（把可能 undefined 的 `.length`
加可选链，不会破坏任何用例）。**所以这个 16→9 的落差是抖动**：
该套件用 `waitForLoadState('networkidle')` + 2 workers + dev 编译，
对时序非常敏感，**单次运行的通过数波动至少 7 条**。

**这反过来削弱了我前几轮的结论**：`25 → 18 → 14 → 13 → 10 → 9` 这条
"稳步收敛"的轨迹，**每一步都是单次采样**。其中那些幅度大且机理明确的
（缺 `npm` / 缺浏览器 / `BASE_URL` 指错 / MSW 启动晚）有**独立证据**支撑，
可以信；但**"失败数从 13 降到 10 再降到 9"这种小幅变化，可能只是抖动**。

**以后取数**：要么固定 `workers: 1` 跑，要么同一状态跑 2–3 次取中位数，
否则不要把单次数字当成"修好了/变差了"的依据。

#### ✅ 可信基线（`--workers=1`）：**13 failed / 12 passed**

用单 worker 跑了一次（7.7 分钟，25 条全跑）：

| 配置 | 结果 | 可信度 |
|---|---|---|
| 2 workers（默认） | 16 / 9 / 14 …**每次都不一样** | ❌ 抖动大 |
| **1 worker** | **12 passed / 13 failed** | ✅ **作为基线** |

**所以必须更正我之前引用的数字**：我说过"25 → **9** failed / 15 passed"——
那是 2 workers 下的**幸运单次采样**。**可信的当前状态是 13 条失败。**

（环境类修复带来的改善是**真实的**——缺 `npm`、缺浏览器、`BASE_URL` 指错、
MSW 启动晚，这四条各有独立证据，不依赖通过数。但"从 25 一路降到 9"
这个**数字**是被抖动美化过的。）

**基线失败清单**（比数字更有意义 —— 它跨运行**基本稳定**）：

| 文件 | 条数 |
|---|---|
| `quotations` | 4 |
| `dashboard` | 3 |
| `admin-gray-release` | 2 |
| `customers` | 2 |
| `events` | 2 |

**后续取数规矩**：改动前后都用 `--workers=1`，否则无从比较。

#### ✅ 用同一个技术又抓到**第二个同类真实缺陷**（`.map`），已修

把 fixture 的 console 输出按 `errorMessage=` 解出来，又看到一条：

```
TypeError: Cannot read properties of undefined (reading 'map')
  src/app/(app)/customers/page.tsx  ::  CustomersPage
```

**与 `.length` 是同一类、同一个文件**：`detail.contacts.map(...)`、
`detail.inquiries.map(...)`、`detail.stage_log.map(...)`、
`listData?.items.map(...)` —— 又是"保护了外层对象、忘了数组本身"。

（这也解释了我修 `.length` 后页面**仍然**崩：空态分支被 `?.length === 0`
挡住了不渲染，但紧邻的 `.map` 照旧执行并抛错。）

**已修 4 处**（`detail?.contacts?.map(...)` 这种）。验证：

- `typecheck` exit 0
- 单 worker 复跑后 **`errorMessage=` 归零** —— 应用级 TypeError **清零** ✓

**注意取数方式**：这次通过数是 12，与修前基线 12 **相同**（在抖动范围内）。
**确定性信号是"错误清零"，不是通过数** —— 单看计数会误判成"没效果"。

`customers/page.tsx` 一共 6 个数据位点，每个都同时需要 `.length` 与 `.map`
两处保护；两轮（`.length` 8 处 + `.map` 4 处）才补全。

#### ✅ 收口信号：全套件**已无应用级错误**（`errorMessage=` 归零）

修完上面两处后再单 worker 跑一次，把 console 里的 `errorMessage=` 全解出来：

**一条都没有。** 也就是**没有任何页面再抛应用级异常**（此前两轮各有一条
`CustomersPage` 的 TypeError）。

| 指标 | 状态 |
|---|---|
| 应用级错误（`errorMessage=`） | **0** ✅ 确定性信号 |
| 通过数（`--workers=1`） | 11（基线 12、修后 12、本次 11）—— **在抖动范围内，不具信息量** |

**结论**：剩下的 e2e 失败**不是页面崩溃**，而是 flaky / 时序 / 断言层面。
这一条**不依赖计数**、可复现，是这条线目前最有价值的结论。

**所以 e2e 这条线的状态可以定为**：

- ✅ **已修掉 2 个真实应用缺陷**（`CustomersPage` 的 `.length` 与 `.map`，
  均由 console fixture 抓出，非猜测）
- ✅ **已确认套件 flaky**，并立了取数规矩（`--workers=1`，看错误证据而非计数）
- ⏸ **剩余失败留待专门排查**：需要反复跑几十次定位时序，不是短预算能收的

#### 🎯 又一类原因：**4 条失败是"陈旧的测试指向不存在的路由"**

静态扫描（用阳性对照验证过扫描器有效）确认其余页面**没有**同类未保护访问，
于是转去查 `quotations` 那 4 条。结果：

| 检查 | 结果 |
|---|---|
| `(app)/quotes/page.tsx` | **存在** ✅（现役报价页） |
| `(app)/quotations/` 下任何层级的 `page.tsx` | **不存在** ✗（只有 `components/`、`hooks/`、`v2-quote/`） |
| 导航里指向 `/quotations` 的链接 | **没有**（唯一命中是 `use-quotations.ts` 里的 query key） |

**App Router 里没有 `page.tsx` 就没有路由** → `/quotations` = **404** →
`quotations.spec.ts` 的 4 条用例必然失败。

**所以这 4 条既不是应用 bug，也不是 flakiness，而是测试指向了一个已消失的路由**
（页面看来搬到了 `/quotes`）。

**处置（未做，需判断）**：

- 把 `quotations.spec.ts` **重新指向 `/quotes`** 并按其结构改写选择器 —— 是正解，
  但新页面结构不同，**不是一行能改完的**
- 直接**删掉这 4 条**则等于放弃这部分覆盖，且"删测试"不宜擅自决定

> 这条发现改变了 e2e 的失败构成：**13 条里至少 4 条是"测试陈旧"，
> 与"应用质量"和"套件 flaky"都无关。**

#### 🎯🎯 更普遍的问题：**测试断言的选择器与现在的 UI 不匹配**

顺着同一思路（对照"测试断言什么" vs "页面渲染什么"）继续查，
统计各失败页面的 `<table>` 标签数：

| 页面 | `<table>` 标签数 | e2e 断言 |
|---|---|---|
| `customers/page.tsx` | **0** | `locator('table tbody tr')` ✗ |
| `events/page.tsx` | **0** | `locator('table')`、`table tbody tr` ✗ |
| `dashboard/page.tsx` | **0** | （其他断言） |
| `admin/gray-release/page.tsx` | **0** | （其他断言） |
| `audit-log/page.tsx` | **22** | `table tbody tr` ✓ |

**`customers` 与 `events` 的测试断言页面里有 `<table>`，而那两个页面
根本没渲染表格** —— 与 `quotations` 是同一类问题：**测试陈旧**。

**所以 13 条失败的构成大致是**：

| 类别 | 条数 | 性质 |
|---|---|---|
| 路由已不存在（`/quotations`） | 4 | 测试陈旧 |
| 选择器与 UI 不匹配（`table`，`customers`/`events`） | 4 | 测试陈旧 |
| 应用级崩溃 | **0** | ✅ 已修清 |
| 其余（dashboard / gray-release / audit-log） | ~5 | 待逐条对照 |

**结论：这套 e2e 大面积落后于现在的 UI** —— 不是应用质量下降，
也不是单纯 flaky，而是**测试没跟着界面改**。

**这意味着"归真"的正确做法可能是"以现役 UI 重新基线化这套 e2e"
（改写或退役其中过时的部分），而这是一个需要用户拍板的项目决策**，
不宜由我擅自删测试。

#### ⚠️ 先记一次**我自己差点被骗**：工具失败伪装成"证据"

做这批对照时，我第一次的 `cd` 因路径含括号而失败，于是所有
`Select-String` 跑在**错误目录**下、**全部返回 0 命中**。
输出看上去像"所有期望文案都不存在"——那会直接得出
「全部都是陈旧测试」的结论，而且**看起来很硬**。

真实数据（正确路径重跑）**正好相反**：

| 页面 | 期望值 | 实际 |
|---|---|---|
| `audit-log` | 操作日志 / 日志筛选 / 暂无操作记录 | **1 / 1 / 1** ✓ 都在 |
| `dashboard` | grid / **7天** / 采样 | 1 / **0** / 5 |
| `admin/gray-release` | **切换** / **联佳** / 变更历史 / **确认** | **0 / 0** / 1 / **0** |

> **教训：`0 命中` 与 `命令根本没跑成功` 在输出上长得一样。**
> 下结论前要确认"工具确实跑在了预期对象上"（打印 cwd / 用阳性对照）。
> 这与我用阳性对照验证扫描器是同一纪律 —— 那次做到了，这次差点漏掉。

#### 修正后的构成：约 **10 / 13 条是陈旧测试**

| 页面 | 陈旧证据 | 条数 |
|---|---|---|
| `quotations` | 路由 `/quotations` 不存在（无 `page.tsx`） | 4 |
| `events` | 页面无 `<table>`，测试却断言 `table` | 2 |
| `admin/gray-release` | 页面无「切换」「联佳」「确认」，测试断言这三个 | 2 |
| `customers` | 页面无 `<table>`，测试断言 `table tbody tr` | 1 |
| `dashboard` | 页面无「7天」按钮，测试点击它 | 1 |
| `audit-log` | **期望文案全都在** → 不是陈旧，另有原因 | 1–2 |
| `dashboard` 其余 | `.grid > *`、`采样` 都在 → 另有原因 | 2 |

**所以"e2e 归真"的实质是"这套测试大面积过期"**，不是应用质量、也不只是 flaky。
正确做法需要用户拍板：**以现役 UI 重新基线化**（改写或退役过时用例）。

#### 那 ~3 条"非陈旧"的：报错是 `networkidle` / 点击**超时**

查 `dashboard` 两条失败的实际报错：

```
Test timeout of 30000ms exceeded.
Error: page.waitForLoadState: Test timeout of 30000ms exceeded.
Error: locator.click: Test timeout of 30000ms exceeded.
```

**即 `networkidle` 永不满足 / 点击等不到** —— 这属于我早先定位的
「**未匹配请求 → 自代理挂死 → `networkidle` 永不触发**」那一类，
与"陈旧选择器"是**两回事**。

（且它们的期望文案 `.grid`、`采样` 实测**都在**页面上，所以确实不是陈旧。）

**仍开放的问题**：早先我用 console fixture 点名缺口时，
`[MSW缺口]` 只报出 **Next 自己的请求**（`/__nextjs_original-stack-frame`、
`?_rsc=` prefetch），**没有** `/api/v1/*` —— 也就是说那些 `/api/v1/*`
**是被 MSW 匹配到的**。但 dev server 日志里又确实出现
`Failed to proxy .../api/v1/auth/me`。

> 两者看起来矛盾（匹配了就不该到服务器）。可能的解释是**服务端侧发起的请求**
> （RSC prefetch / SSR）—— 那是浏览器里的 MSW **拦不到**的。
> 这条未验证，留作下一步：需要区分"浏览器请求"与"服务端请求"。

#### ⏸ 重新基线化：第一次尝试**失败并已回退**，但换来一条统一解释

按用户裁决开工「以现役 UI 重新基线化」。先按 `customers/page.tsx` 的真实结构
重写 `customers.spec.ts`：

- 断言从 `locator('table tbody tr')` 改成实卡片列表 `.space-y-2 > div`，
  并容错空态「暂无客户」
- 详情改成"同页展开"（`onClick` → `setSelectedCustomer`），不再期待 URL 跳转
- **去掉 `waitForLoadState('networkidle')`**，改用显式 `toBeVisible({timeout})`

结果：**1 failed / 2 skipped** —— 卡片与空态**都没出现**。
页面快照显示主区域只有一句：

```
您没有访问此页面的权限
```

**该断言已回退**（不把红的用例提交上去，守"变差即退"的纪律）。

**但这次失败换来一条统一解释**：

> `route-guard.tsx` 在 `adminOnly && !isAdmin` 时渲染该文案，而
> `user === null`（会话还没恢复）时它们**同时成立** ——
> 也就是说：**只要 `/auth/me` 没及时返回，页面立刻显示"无权限"，
> 而且不会自行恢复。**

这恰好把前面几类现象串成一条：

| 现象 | 解释 |
|---|---|
| 早前 `customers` 显示「页面加载异常」 | 请求失败 → 错误边界 |
| 现在显示「您没有访问此页面的权限」 | `user` 仍为 null → 守卫拦截 |
| `networkidle` 永不满足 | 同一批请求**挂起** |

**夹具本身是对的**（已核对：`MOCK_ADMIN_USER.account_type = "internal"`；
`global-setup` 也把 `kaas_token` 种进了 localStorage）。所以问题不在夹具，
而在**那些请求有时不返回**。

**结论：e2e 重新基线化当前被"早期请求偶发不返回"卡住**，不是选择器问题。
先把这一层解决，否则改写多少条选择器都仍然会红。

#### 部分改善：给 MSW 加"Service Worker 控制权门"

**假设**：`worker.start()` resolve **不等于** SW 已接管本页 ——
MSW 的 `mockServiceWorker.js` 在 `activate` 里 `clients.claim()`，
而那是 `event.waitUntil`（异步）。这段窗口里发出的请求会**绕过 mock**：
打到 Next dev server 的 `/api/v1/*` rewrite → rewrite 指向页面源 →
**自己代理自己**（EADDRINUSE）→ **请求永久挂起**。

而且它**不留痕迹**：MSW 不记录这段窗口的请求（那时还没接管），
所以缺口日志里看不到 `/api/v1/*` —— 这正是之前那个"看起来自相矛盾"的点。
Playwright **每个用例新建 context**，于是**每次首屏都踩**这个竞态，
与"每轮通过数都不一样"吻合。

**做法**：`msw-provider.tsx` 在 `worker.start()` 之后**再等
`navigator.serviceWorker.controller` 出现**（`controllerchange` 事件，
3 秒兜底放行——不能因竞态把应用卡成白屏）。

**实测**：`customers.spec` 由 **2 条失败 → 1 passed / 1 failed / 1 skipped** ✓

**但绕过仍在**：日志里依然出现
`Failed to proxy .../api/v1/customers`、`.../api/v1/auth/me`。

> 所以这道门**减轻了竞态、没有消除它**。假设方向对，但**还有别的路径**
> 让请求绕过 mock（尚未查清）。**不能因为"数字变好一点"就宣布修好了。**

#### 🎯 决定性仪器：`response.fromServiceWorker()` 直接点名绕过者

换了个**能直接回答**的仪器 —— Playwright 的 `response.fromServiceWorker()`：
它明确告诉你"这个响应**是不是 MSW（Service Worker）给的**"。
比从 dev server 的反向报错去猜准得多（那个既看不到是**哪个**请求，
也分不清"没匹配"与"没被接管"）。

加进 `e2e/fixtures.ts` 后，`/api/v1/*` 里绕过 MSW 的请求**逐个被点名**：

```
[绕过MSW] GET  /api/v1/auth/me     -> 500
[绕过MSW] GET  /api/v1/customers?  -> 500
[绕过MSW] POST /api/v1/events      -> 500
```

**正是页面最先发出的那几个请求，且返回 HTTP 500**（自代理失败的产物）。

##### 完整因果链（至此闭合）

```
① 首屏最先的几个请求绕过了 MSW（未走 Service Worker）
② 它们直连 Next dev server → 命中 /api/v1/* rewrite → rewrite 指向页面源
   → 自己代理自己（EADDRINUSE）→ 返回 500
③ /auth/me 拿到 500 → AuthProvider catch → 清会话 → user === null
④ route-guard 在 adminOnly && !isAdmin 时渲染「您没有访问此页面的权限」
⑤ 其他请求拿 500 → 页面进错误边界「页面加载异常 / 后端繁忙」
⑥ 挂起的连接让 waitForLoadState('networkidle') 永不满足 → 用例超时
```

**同一条链解释了此前所有看起来互不相关的现象**：权限文案、错误边界、
`networkidle` 超时、以及"每次通过数都不一样"（竞态）。

**仍未查清**：为什么这几个**首屏**请求能绕过 SW 控制（已排除
"MSW 未启动"与"SW 未 claim"）。下一步可用同一仪器继续定位 ——
例如在 fixture 里同时记录 `request.timing()` / 发起时刻，
或把它们与 `page.goto` 的时间线对齐。

### ⚠️⚠️ 重大环境发现：**这个工作区正被另一条线并发修改**（2026-10-11 20:02）

跑 e2e 时 `git status` 暴露出一批**不是我改的**文件：

```
 M frontend/src/lib/trade-doc/render.ts
 M frontend/src/lib/trade-doc/assets.json
 M frontend/src/lib/trade-doc/manifest.json
 M frontend/src/lib/trade-doc/__tests__/render.test.ts
?? PI-BABAN-KORI/
```

核对时间线后确认**并发且仍在进行**：

| 事实 | 值 |
|---|---|
| 上述 4 个文件被改 | **20:00:35 – 20:02:14** |
| 我最后一次提交 | 19:59:25 |
| 我那次 e2e 验证运行 | ≈19:59–20:02（**完全重叠**） |
| `PI-BABAN-KORI/` 内容 | `build_pi.py`、`edit_templates.py`、`generate-pi.ts`、生成的 `.html` 与 **`.pdf`**、`assets/chain-link.jpg`、以及 **`qa-pdf-p1/p2/p2b.png`**（逐页渲染 QA） |
| 复查时最新变动 | **20:02:54**（就在几秒前） |

即：**有另一条线正在这个工作区里生成形式发票（PI）PDF 并做逐页 QA**，
同时**修改 `frontend/src/lib/trade-doc/render.ts`**。

#### 后果一：我此前报出的 e2e 数字**被污染了**

Next dev **在文件变更时会重新编译**。我跑 e2e 的同时别人在改文件 →
dev server 重编译 → 请求中断/挂起 → **这很可能正是"首屏请求绕过 MSW"
与"每轮通过数都不一样"的一部分原因**。

> 所以 `13 failed / 12 passed` 这个基线、以及"部分改善为 1 passed"之类的结论，
> **建立在一个正被改动的代码库上**。环境类根因（缺 `npm`、缺浏览器、
> `BASE_URL` 指错、MSW 启动晚）各有独立证据、仍可采信；
> 但**凡是"通过数"层面的比较，都必须打折**。

#### 后果二：协作风险

- 我全程**只 `git add` 自己的文件**（未用 `-A`）—— 这次正好躲过一劫
- 反过来：**若对方用 `git add -A` 提交，会把我的改动一并带走**；反之亦然
- 我是**单人**在做这条线，从未创建 teammate，因此**不知道对方是谁**

#### 处置（本轮）

- **不再跑 e2e**：工作区在动，测什么都在晃
- **不提交任何不属于我的文件**（`PI-BABAN-KORI/` 与 `trade-doc/*` 原样留着）
- 待确认「那是谁/什么活儿」，再决定 e2e 什么时候跑

**取数前提（新增纪律）**：跑 e2e 前先确认工作区**静止**（最近若干分钟无他人写入），
否则通过数不可比。

#### 附：本轮另一次**证伪并回退**

为消除"首屏请求绕过 SW"，我试了标准做法：**必要时刷新一次**
（`sessionStorage` 标记防循环）。实测**更差**（`1 passed` → **0 passed / 2 failed**），
且 `[绕过MSW]` 依旧存在。**已 `git checkout` 回退**。

> 又一次"假设 → 实测 → 变差即退"。**不能因为手段标准就假定它对**。

**关键发现：那两个 critical/high 的来源不是"版本旧"，是依赖放错了位置。**

| 漏洞 | 来源链 | 真实问题 |
|---|---|---|
| `proxy-addr`（critical） | `express` ← MCP SDK ← **`shadcn`** | shadcn 是 **CLI 工具**却放在 `dependencies`，把整个 express 服务栈拖进依赖图 |
| `undici@5.29.0`（high） | `miniflare` ← **`@cloudflare/next-on-pages`** | **废弃的 devDependency**：部署走 `pywrangler deploy`，仓库里无任何配置引用它（只出现在过期的 npm lockfile 里） |

处置：删除 `@cloudflare/next-on-pages`（连带 miniflare 与 undici@5.29.0 消失）；
`shadcn` 移入 `devDependencies`；`proxy-addr` 用 override 固定 `2.0.8`。

**踩坑记录**：override 第一版写在 `package.json` 的 `pnpm` 字段里，**没生效** ——
**pnpm v11 不再读 package.json 里的 `pnpm.overrides`**（WARN 明说 keys were ignored），
正确位置是 `pnpm-workspace.yaml`。写错位置的坏处**不是报错，而是"看着有、其实不生效"**。

验证：typecheck exit 0；lint 无 error；前端 280 passed；contracts R0–R4 PASS；
`NEXT_EXPORT=1` build exit 0（34 静态页）；orchestrator 589 passed。

### 旧表 `customer_pricing_profiles` 活读取路径已收口（`51e26f9` 之后）

### 前端认证契约残留已收口（`35a89a8`）

**症状**：前端仍保留 `tenant.{tenant_id}`，并据此注入 `X-Tenant-Id`。

**为什么是隐患（两层）**：

1. `tenant_id` 已全量统一为 `default`（迁移 `202610110005` unify_tenant），
   **租户不再是隔离边界，团队（team_id）才是**；账号身上根本没有"租户"。
2. 更关键的是这个值**从哪来**：`updateSession` **从来不写** `tenant`，
   唯一来源是 `getCurrentSession` 里从 **localStorage 的过期 `kaas_user`** 反推。
   于是发出去的可能是**早已失效的旧值**，而后端还拿它做限流分桶与日志上下文 ——
   属于"**看着有用、实际误导**"。

**处置**：删掉注入与字段。后端本就不需要它
（`middleware/auth.py` 鉴权后自行设 `request.state.tenant_id = DEFAULT_TENANT`）。

**顺带更正一处与事实不符的注释**：`middleware/rate_limit.py` 写着
"每租户限流、不同租户独立限流"，而租户已统一 —— key 里的 tenant 部分
实际恒为同值，**真正起区分作用的是 IP**。读不到头时落 `"unknown"`，
与原先"所有人都发同一个 default"是**同一种分桶**，限流效果不变。
保留该前缀是因为限流要在**鉴权之前**判定，那时拿不到可靠的 team_id。

验证：前端 `typecheck` exit 0；`lint` 仅既有 `<img>` warning；
测试 **280 passed / 21 files**；后端仅改 docstring。

### 反向漂移：逐条取证与处置（2026-10-11）

`route-parity.py` 报「worker 独有 8 条」，它**不算 FAIL**，只提示
「建议在 orchestrator 侧补齐」。但逐条查过之后发现**性质完全不同**，
不能一概"补齐"，也不该一概放过。取证结果：

| 路由 | 取证 | 性质 |
|---|---|---|
| `POST /api/v1/leads/crawl-batch` | **前端在调它**（`leadgen/page.tsx:222` 的批量爬取按钮） | 🔴 **真 bug**：orchestrator 没有 ⇒ **dev 环境下该按钮 404** |
| `GET /api/v1/subscriptions`<br>`GET /api/v1/subscriptions/bundles` | 前端调的是 **`/teams/{id}/subscriptions`**（带 team id），**不是**这两条；全仓（前端/脚本/orchestrator）**零调用**；但有**既有裁决**：`docs/archive/2026-09-30-doc-cleanup/SYSTEM_AUDIT.md:90` 标为「需确认 → **留**」，理由"用量/订阅" | ✅ **有意保留**（平台/订阅目录，非残留） |
| `POST /api/v1/leads/{lead_id}/crawl` | 前端未直接调用 | 单条爬取，与上面的批量是同一功能的两个入口 |
| `GET/PUT/PATCH/DELETE /api/v1/outreach/webhook` | worker 是 `@app.api_route(methods=[GET,POST,PUT,PATCH,DELETE])`，函数体**只 raise 501**（`INBOUND_WEBHOOK_RESERVED`） | 预留桩，**任何方法都无副作用**；orchestrator 只有 `POST` |

两点结论：

1. **`crawl-batch` 不是"漂移"而是"dev 缺功能"** —— 前端按 worker 的接口写的，
   而 orchestrator 从未实现。worker 侧的实现是**自成体系**的
   （内联 SQL + `_crawl_one` + `_require_sub`），移植到 orchestrator
   （SQLAlchemy / 本地 asyncpg）不是小活，**不能顺手补**。
2. **`outreach/webhook` 那 4 条不该"补到 orchestrator"** ——
   把一个"只 raise 501 的预留桩"按 5 种方法暴露出去，是把线上攻击面
   无谓地放大（虽然目前无副作用）。更合理的方向是**把 worker 收敛到 POST**，
   与 orchestrator 一致、与语义一致（inbound 回写本来就是 POST）。

**用户 2026-10-11 裁决**：

- `outreach/webhook` → **worker 收敛到只留 POST** ✅ 已做（`chain.py`，
  `api_route(methods=[5 种])` → `@app.post`）。反向漂移 **8 → 4**。
- `leads/crawl-batch` / `leads/{lead_id}/crawl` → **补到 orchestrator**（待做）。
- 总策略追问「以 orchestrator 为准会影响部署架构吗」→ **不会**。已取证：
  `.github/workflows/deploy.yml` 只做「构建前端静态导出 + `pywrangler deploy`
  单个 Worker `kaas`」，**没有任何一步部署 orchestrator**。
  所以"以 orchestrator 为准"只是把它的路由清单当**规格**，
  不是让 orchestrator 上生产、也不是合并两套后端。

  **但有一条限制**（这也正是用户选"补到 orchestrator"的原因）：
  该原则只对 **worker 多余的东西**成立；对 **worker 有的真功能**，
  不能因为 orchestrator 缺就把它删掉 —— 那是**往 orchestrator 补**。

  | worker 有 / orchestrator 无 | 有人在用？ | 处置 |
  |---|---|---|
  | `webhook` 的 GET/PUT/PATCH/DELETE | ❌ 只 raise 501 | **从 worker 收掉** ✅ |
  | `leads/crawl-batch`、`leads/{id}/crawl` | ✅ 前端在调 | **补到 orchestrator** |
  | `subscriptions` ×2 | 待确认 | 先查清再定 |

### `leads/crawl-batch` 补到 orchestrator：施工方案（**未开工，原因见下**）

用户已定「补到 orchestrator」。取证后发现**这不是小活**，故作罢交下一轮，
避免半成品。

**落点**：`app/api/leadgen.py`（orchestrator 已有 `/leads` 列表、`/leads/{id}` 详情、
`/leads/scan-replied`、`/leads` 创建），缺失的是爬取两条：
`POST /leads/{lead_id}/crawl`、`POST /leads/crawl-batch`。

**为什么不能顺手补**：worker 侧的两条端点依赖 4 个助手，
经逐项核对，**orchestrator 侧 4 个全缺**：

| 助手 | 作用 | orchestrator |
|---|---|---|
| `_is_safe_crawl_url` | **SSRF 防护**（只允许公网 http(s)） | ❌ 缺 |
| `_http_get_text` | 抓取网页文本 | ❌ 缺 |
| `extract_product_from_html` | 从 HTML 抽产品名/图片/规格 | ❌ 缺 |
| `_enrich_product` | 把抽取结果富集并回写 | ❌ 缺 |

其中 **`_is_safe_crawl_url` 是安全敏感件**（对外发起网络请求的入口），
必须**逐行照搬 worker 的实现**，不能凭理解重写 —— 这类防护少一条判断就是 SSRF 洞。

**已有的可复用件**：

- 订阅门禁：orchestrator 侧是 `app.api.subs.require_leadgen`（对应 worker 的
  `_require_sub(conn, "leadgen")`）✅
- 查询风格：worker 用内联 SQL + Hyperdrive；orchestrator 的 `leadgen.py`
  用 SQLAlchemy（且 `lead_candidates` **没有 ORM 模型**，需用 `text()` 或裸 SQL）
- 两条端点的业务逻辑本身很短（worker 侧 `chain.py:1709-1810`），
  真正的分量在那 4 个助手上

**建议顺序**（下一轮照此做）：先逐行搬 `_is_safe_crawl_url` 并**为它补测试**
（拒绝内网/回环/非 http(s)/重定向到内网），再搬抓取与抽取，最后接两条端点。

#### 🔴 移植过程中发现的**安全问题**：重定向可绕过 SSRF 防护

worker 的抓取用的是 `redirect: "follow"`（`chain.py:211`），
而 SSRF 防护**只校验请求前的 URL**。于是：

```
http://evil.com  --302-->  http://169.254.169.254/latest/meta-data/
```

请求的确发往 `evil.com`（合法，通过校验），但客户端**自动跟随**到了
云元数据地址。**只校验第一跳等于没校验。**

**orchestrator 侧已按正确做法实现**（`app/services/lead_crawl.py`）：
关掉自动跟随，用 `next_redirect_url` 把每一跳的 Location 过同一把尺子，
并限制最多 5 跳。已补测试（12 条：相对/绝对跳转解析、
指向内网/回环/云元数据/file: 的跳转一律拒绝、空 Location 拒绝、
"任何网络动作之前先过尺子"）。

**worker（生产）侧已修**（本轮）：`redirect: "follow"` → `"manual"` +
逐跳校验，两条路径（`js.fetch` 与 `urllib` 回退）都改，
免得留下"换个运行环境就有洞"的缝。

Cloudflare 官方文档确认了这个改法可用且是官方推荐：
「If set to `manual`, the **`3xx` redirect response will be returned to the
caller as-is**」以及「If the response is a redirect and the redirect mode is
set to `follow`, then all headers will be forwarded to the redirect
destination... you should **set redirect mode to `manual` and implement your
own redirect policy**」。

#### 顺带把一个更大的隐患修掉了：安全件不再有两份

补 orchestrator 时，我一度把守卫在 orchestrator 复制了一份，并给 worker 那份
配了一条测试，结果**测试被 skip 了**，于是我把成因写成
「`chain.py` 依赖 Pyodide，在 CPython 测试里根本 import 不了」。

**这条结论是错的，在此更正**：`chain.py` 是**可以**在测试里导入的 ——
`tests/test_product_extract.py` 早就有现成办法：stub 一个 `main` 模块
（`app` / `_acquire` / `_get_current_user`）、把 `src` 加进 `sys.path`，
再 `import chain`。那条测试甚至**已经在覆盖** `_is_safe_crawl_url`、
`extract_product_from_html`、`_abs_url`。

我的测试之所以被 skip，纯粹是**没做这个 stub 与 sys.path 设置**，
不是"做不到"。**把"我没搭起来"写成"根本测不了"，是把自己环境的局限
当成了事实** —— 这类错误比代码 bug 更难发现，因为它看起来像一条结论。

（搬进共享内核这件事**仍然成立**，只是理由不同：不是为了"能测"，
而是为了**不留两份**、避免将来漂移。）

一条跳过的安全测试比没有更糟 —— 它看起来像有覆盖。

**处置**：抽出 `backend/kaas_common/net.py`（`is_safe_crawl_url` +
`next_redirect_url` + 常量），两端 import **同一份**：

- worker `chain.py` 的 `_is_safe_crawl_url` / `_next_redirect_url` 变成薄别名
  （保留旧调用点，语义指向唯一真源）
- orchestrator 的 `app/services/lead_crawl.py` 只留 httpx 那部分（平台原语不同）
- 测试跑在 orchestrator 套件里 —— **测的就是 worker 实际执行的那份代码**

`sync-shared.ps1` 已把 `net.py` 镜像过去（共享内核 21 → **22 个文件**）。

#### 移植进度

| 助手 | 状态 |
|---|---|
| `is_safe_crawl_url`（SSRF 防护） | ✅ 逐行照搬（`e578941`） |
| `http_get_text`（出站抓取） | ✅ 已移植，且**两处刻意不同**：用 httpx 而非 `urllib` 同步回退（后者会阻塞 FastAPI 事件循环，一次爬取 15 秒全站卡住）；逐跳校验重定向 |
| `extract_product_from_html`（抽产品信息） | ✅ 已入共享内核（`crawl_extract.py`） |
| `_enrich_product`（富集回写） | ✅ 按端各自实现（两端 `run_ai_task` 签名不同） |
| 两条端点（`POST /leads/{id}/crawl`、`POST /leads/crawl-batch`） | ✅ **已接**（`2a158cb`）—— dev 的「批量爬取」404 **已修好** |

**全部完成**：`route-parity` 的「worker 独有」由 **8 → 2**，
剩下 2 条即上表的 `subscriptions`（有既有裁决、有意保留）。

文档里挂着的那条**真缺陷**关掉了。它是一条**静默误读**链路：

```
services/quote_engine.create_quote
  → services/niulanwang_pricing.calculate_base_cost / calculate_tiers
    → repositories/pricing_profiles_repo.get_current_profile
      → customer_pricing_profiles（INT-R3 时代的三档加价倍率模型）
```

模型注释自己写着风险：**把新模型的行插进旧表，老路径会按「加价倍率」解读它们
—— 读到 null / 垃圾值继续算，不报错、不告警。**

**处置：整链删除**（三个文件），理由是它已是死代码 ——
`create_quote` 的唯一引用是 `services/__init__` 的再导出，
加一个测试里的 `assert is not None`；**没有任何 API 调用它**
（`app/api/quotes.py:254` 那个同名 `create_quote` 是路由处理器，不相干）。

连带改动：

- `services/__init__.py` / `repositories/__init__.py` 去掉对应 import 与 `__all__` 条目
- `tests/test_knowledge_provider.py` 里那条"报价链不依赖 FastGPT"的断言
  改断言**现役引擎** `app.services.export_quote.build`（原断言对象已删除）
- `models.CustomerQuoteProfile` 的注释更新（原文写"仍被旧线性流水线读取"，已不成立）

**表本身保留**（里面有历史数据；删表是破坏性动作，需单独决定）。
它现在是**退役状态**：没有任何代码读它，也没有新的写入路径 ——
隐患来自"被读"，读路径没了，隐患即消失。

验证：`app.main` 可导入；orchestrator **511 passed**（不变）；
     worker **142 passed**；`route-parity` PASS；`sync-shared -Check` exit 0。

***

## 方法

不转述文档，而是**实跑门禁与代码取证**（2026-10-11，HEAD 见下方提交）：

| 门禁 | 命令 | 当时结果 |
|---|---|---|
| 契约 | `pnpm -C frontend contracts:check` | ✅ exit 0（R0–R4 全 PASS）**改动前 R2、R4 FAIL** |
| 前端测试 | `pnpm -C frontend test` | 1 failed / 281 passed（失败＝既有 `niulanwang`） |
| 类型 | `pnpm -C frontend typecheck` | ✅ exit 0 |
| Lint | `pnpm -C frontend lint` | ✅ exit 0（仅 warning，无 error） |
| 路由对等 | `python scripts/route-parity.py` | ✅ PASS（缺失 22 已登记 / 未登记 0 / 过期 0 / worker 独有 8） |
| 三方漂移 | `python scripts/route-parity-audit.py` | 【线上坏】6（全部是"有意不做"的平台运维端点） |
| Worker 测试 | `pytest backend/worker/tests` | ✅ 138 passed |
| 后端单测 | `pytest -m unit`（orchestrator） | ✅ 451 passed / 1 skipped **改动前 1 failed → CI unit 任务红** |

---

## 一、本轮已修复（10 项，各一个提交）

| # | 问题 | 提交 |
|---|---|---|
| 1 | **R2 契约漂移**：`workstations.ts` 有工位 `tenant-products`，后端镜像从没有过 → 面包屑/标题退化 | `18f1c03` |
| 2 | **R4 检查器失效**：`DOC_NO_FIELDS` 下沉共享内核后旧解析器抓到无关代码 → 既误报"合同号印成发票号"又完全不设防 | `5b814c8` |
| 3 | **单证逐字节基准在 Windows 全红**：`core.autocrlf` 把 LF 基准检出成 CRLF，18 类单证假红 | `9971f30` |
| 4 | **`route-parity.py` 在 Windows 崩溃**：GBK 下打印 `ℹ️` 抛 `UnicodeEncodeError`，判定算完却看不到结论 | `c1626b4` |
| 5 | **审计脚本只读 `main.py`**：worker 已拆 18 个模块 → 62 条假警报 | `8538652` |
| 6 | **生产缺 `POST /auth/logout`**：前端点登出就是 404（allowlist 里唯一"前端已调用"的待补项） | `e319f26` |
| 7 | **`quote-profiles` 本地联调 404**：Worker 双路径、orchestrator 只有一条，前端用的是缺的那条 | `440e81d` |
| 8 | **CI unit 任务红**：`test_knowledge_provider` 被标 `unit` 却真连 PostgreSQL，CI unit 任务无 postgres service | `d04dd2d` |
| 9 | **单证金额勾稽生产端缺失**：内核 `validate_confirm` 只校验到**行级**，「单证合计 = 行项目合计」只有 dev 有 → 线上能确认"合计≠明细"的单据（信用证不符点） | `c2ee256` |
| 10 | **管理员判定有两份**：`customer_rules.can_see_all` 把 `account_type='internal'` 也算管理员 → `qa_user` 这类内部普通账号能看全部租户 | `7688b77` |
| 11 | **共享 Repository 死代码**：零引用，且 SQL 模板完全没有 `team_id`/归属过滤 —— 接线会**绕过团队隔离** | `e6b54e5` |
| 12 | **生产 schema 落后 14 个迁移**：线上库停在 `202609300001`，代码 head 是 `202610110014`；8 张表 2 个列在生产根本不存在，而对应端点早已上线 | 见下「生产库对齐」 |
| 13 | **规格体系只认枚举**（A2 第一步）：引擎此前要求轴必须匹配 `axis.options`、变体属性必须唯一命中选项 —— 客户实际会给的 `2.3mm` 根本填不进来，"丝径自由配置"无从谈起 | `f6b4b62`（能力层已落地，见下「A2 进展」） |

**另一批"文档写着未完成、实际早已完成"的**（本轮只做核对，未改代码）：

| 原记录 | 出处 | 实测 |
|---|---|---|
| `customers/{}/stage` POST/PATCH 契约分叉 | `WORKER_ORCHESTRATOR_DRIFT` §三、`DUAL_BACKEND_CONVERGENCE:156` | **两端都是 PATCH**（`customers.py:333`、`main.py:1016`） |
| 线上没有 `/api/v1/quotes` → 单证报价单下拉是空的 | `MULTI_PRODUCT_QUOTE_PLAN:86` | **有**，5 条（`quote_api.py:1771-1967`） |
| 线上 `export-quote` 批量导入面板是坏的 | `MULTI_PRODUCT_QUOTE_PLAN:380` | **有**（`quote_api.py:901-978` import/template·preview·calculate） |
| worker 客户读接口不做归属过滤 → "列表里有、点进去 404" | `ROUTE_PARITY_2026-10-10.md:157-171` | **已加**（`main.py:855-867`：`is_deleted` + `_can_see_all` + scope 条件） |
| `useQuoteV2()` 调 `POST /quote` → 智能报价页核心动作 404 | `CURRENT_IMPLEMENTATION_MAP:166` | 前端已无此调用；`useQuoteV2` 不存在 |
| `GET /product-specs` → 智能报价页选项加载失败 | `CURRENT_IMPLEMENTATION_MAP:167` | 前端只在 `mocks/handlers.ts` 引用，无真实调用点 |
| `dashboard/components/stat-card.tsx` 重复实现 | `CURRENT_IMPLEMENTATION_MAP:153` | 只剩 `components/shared/stat-card.tsx` 一份 |
| 出货工位被门禁挡着（缺 `/api/v1/shipments`×4） | `CURRENT_IMPLEMENTATION_MAP:55`、`MULTI_PRODUCT_QUOTE_PLAN:482` | **已实现**（`ws_shipments.py` 4 条路由） |
| 工位订阅校验未完成 | `EXECUTION_SUMMARY_2026-10-10.md:69` | **已完成**（与同批 `PRODUCT_CONFIG_TENANT_UNFINISHED.md` 自相矛盾） |
| 前端 A/B/D（工位可见性·团队生命周期·`quotation` 类型）"执行中" | `FRONTEND_PRODUCTION_READINESS.md:154`、`PLAN_CUSTOMER_RECORDS.md:110` | **已落地**：`layout.tsx:41` 挂 `WorkstationGate`；`team/page.tsx`、`register/page.tsx` 有工位/团队选择；sidebar 走 `filterNavGroups` |
| 页面名有 3 个来源、`/market` 面包屑与 `/research` 重名 | `PLATFORM_UPGRADE_PLAN.md:47-49` | **已收口**到 `shared/contracts/workstations.ts` + R2 门禁（现 PASS） |
| `POST /auth/register` 线上 404 | `TODO_REMAINING_2026-10-10.md:67` | 已补（`main.py:377`） |

---

## 二、仍然存在（已取证）

| # | 问题 | 证据 | 严重度 |
|---|---|---|---|
| 1 | **旧表仍有一条活读取路径**：`quote_engine.py:15 → niulanwang_pricing.py:12,113 → pricing_profiles_repo.get_current_profile` 读 `customer_pricing_profiles`；插入新模型行会被按加价倍率**静默误读**，不报错不告警 | `backend/orchestrator/app/services/niulanwang_pricing.py` | 中高（静默错误） |
| 2 | **反向漂移 8 条**：`outreach/webhook`×4 方法、`subscriptions`×2、`leads/crawl`×2 —— 只存在于 worker，用 orchestrator 重新生成 worker 会丢功能 | `route-parity.py` worker 独有清单 | 中 |
| 3 | **`outreach/webhook` 线上攻击面更宽**：worker 允许 GET/POST/PUT/PATCH/DELETE，orchestrator 只有 POST。**注意**：处理体是预留桩，任何方法都直接返回 501、无副作用 → 不是安全洞，只是两端不一致 | `worker/src/chain.py:1685` | 低（待复核） |
| 4 | **待补路由 22 条**：其中 11 条规格库（`/product-specs`、`/spec/attributes*`、`/spec/skus*`、`/spec/templates*`）前端未直接调用，allowlist 标"按需补" | `scripts/route-parity-allowlist.txt` | 低 |
| 5 | **产品组合数三方不一致**：前端按轴相乘得 **120**，常量是 **160**，测试断言 **48**；后端 4 处断言 `combo_count == 160` | `shared/contracts/niulanwang.ts:99,175`；`test_export_quote_api.py:96,276`、`test_export_quote_formulas.py:324`、`test_export_quote_import.py:82,283` | 中（A2 一并解决：轴改自由数值后该口径作废） |
| 6 | **前端认证契约残留**（不影响功能，`tsc` exit 0）：`lib/auth/session-cache.ts` 仍有 `tenant` 结构与 `user?.tenant_id` 读取；`lib/api/client.ts:43-46` 仍会注入 `X-Tenant-Id`（值恒为空，实际不发） | 只读扫描 | 低（死代码） |
| 7 | **依赖债**：next `^14.2.0 → 15.x` 专项未做。**实测 98 个漏洞**（3 严重 / 24 高危 / 56 中 / 15 低）—— 比 `docs/archive/2026-10-20-closeout/CLEANUP_LOG.md:110` 记的 82 **更差** | `pnpm audit`（2026-10-11 实测） | 中 |
| 8 | **e2e 26 条失败未归真**：依赖本机后端 + 数据库，属"页面没数据"，本轮未复跑 | `docs/archive/2026-10-20-closeout/CLEANUP_LOG.md:32-34`、`E2E_GUIDE.md:38` | 中 |

### 生产库对齐（2026-10-11 已执行，先演练后上生产）

**这一步推翻了本文早先以及多份文档的说法。** 文档一直写「联佳丝网在生产对任何人不可见」，
但直连生产库（Neon 项目 `KaaS` / `production` 分支）实测是另一回事：

| 项 | 迁移前 | 迁移后 |
|---|---|---|
| `alembic_version` | `202609300001`（落后仓库 head **14 个迁移**） | `202610110014`（= head） |
| 缺表 | `teams` / `team_invites` / `team_subscriptions` / `user_subscriptions` / `tenant_products` / `tenant_workstation_products` / `entity_links` | 全部建好 |
| 缺列 | `customers.team_id`、`customers.is_deleted` | 已有 |
| `customers` 数据 | 只有 1 行 QA 冒烟，`tenant_id='qa-smoke-0000-…'` —— **根本没有「联佳丝网」这一行** | 该行 `tenant_id` 已统一为 `default` |
| `teams` | （表不存在） | 1 行：「安平县联佳丝网制品有限公司」，`tenant_id='default'` |

**真实的生产事故是「线上跑的代码，schema 没跟上」** —— 这些端点早已上线，
而它们依赖的表/列在生产根本不存在。
文档里「联佳在生产不可见」描述的其实是 **dev 分支**（当时已在 head，
有 teams=1 / customers=2 / quote_orders=3）。

执行方式（**先演练再上生产**）：

1. 从 `production` 克隆 Neon 分支 `migrate-rehearsal`；
2. 在演练分支跑 `alembic upgrade head` —— 20 个迁移全部通过；
3. 核对演练分支 schema 无误后，才对 `production` 执行同一条命令（同样 20 个，exit 0）；
4. 删掉演练分支。

**验证**（不依赖 token，沿用本项目自己的 PREPARE 手法）：
在生产库上对 15 条**真实端点 SQL 形态**逐个 `PREPARE`（只编译不执行）——
14 条一次通过；第 15 条 `entity_links` 是探针自己把列名写成 `src_kind`
（实际是 `src_type`），改正后通过 → **15/15**。

### 关于组合数（§二 #5）的取证（**未擅自改**，已并入 A2）

### A2 进展（2026-10-11）

**已完成 —— 能力层**（`f6b4b62`）：`ProductSpec` 新增 `numeric_inputs`
（`NumericInput`：key/label/unit/ui_unit/ui_scale/default/min/max/decimals/note），
引擎两条路径都支持自由数值：

- `spec_from_partial` 接受任意值 → 转 Decimal + 上下界防误填（**不枚举**）
- `expand_specs` 把默认值注入每个组合；数值参数**不参与笛卡尔积**
  （连续量没有"组合数"）
- 新增 7 条测试钉死该能力；单元测试 453 → **460 passed**
- 向后兼容：`numeric_inputs` 默认空，`field_fence` 行为不变

**已打通到对外接口**（`8b11b20`）：`describe_product` 暴露 `numeric_inputs`；
定价键的自由数值维度显式声明 `kind="numeric"`（不整维跳过，否则"存了查不到"）；
`explain` 端点接受自由数值（非数值 → 400 `invalid_numeric`）；
引擎容忍同单位后缀（"1.2m"/"100mm"）但不跨单位换算。

**未完成 —— 产品与界面（2026-10-11 尝试过 `field_fence` 改造，验证后回退）**

改造本身是可行的：把 `de`/`height_m`/`mesh_mm` 与 `inner_wire` 变体包
（dm/dv/roll_len_m/roll_dia_m）改成 `numeric_inputs` 后，`combo_count` 从 160
降到 10（表面处理 5 × 工艺 2），§二 #5 的 120/160/48 之争随之作废；
`explain` 基线（65.4020kg / 0.1080m³ / 29.9000m³）逐项不变。

但**集成点比预想多**。实测清单（下次照单推进，别漏）：

| # | 集成点 | 状态 |
|---|---|---|
| 1 | `models.NumericInput` + `ProductSpec.numeric_inputs` | ✅ 已做 |
| 2 | `engine.expand_specs` / `spec_from_partial` | ✅ 已做 |
| 3 | `engine._numeric_value`（含单位后缀容忍） | ✅ 已做 |
| 4 | `app/api/export_quote.py` 的 `explain` 自建规格解析 | ✅ 已做 |
| 5 | `formulas.describe_product` / `describe_pricing_key`（含 `kind="numeric"`） | ✅ 已做 |
| 6 | `importers.py` 的表头映射 + 模板列生成 + `NumericInput.unit_factors` | ✅ 已做（`ccc9d16`） |
| 7 | 前端渲染自由数值 + 退役 `NIULANWANG_SKU_AXES` / `NIULANWANG_COMBO_COUNT` | ✅ 已做（`fa5ee26`、`8d0249d`） |

**牛栏网改造已完成并全绿**（`397aaca`）：`combo_count` 160 → **10**，
重量/体积公式一行未改（本就与企微表格逐项等价）。
验证：orchestrator **469 passed** · worker **142 passed** · 前端 **280 passed / 0 failed**
（那条「各轴相乘 = 48」的红测试随枚举轴一起退役，换成"这些导出不该存在"的反向守卫）·
`contracts:check` R0–R4 PASS · `route-parity` PASS · `sync-shared -Check` exit 0 ·
`NEXT_EXPORT=1 build` exit 0。

改造过程中挖出并修掉 **3 个真 bug**：

| # | 问题 | 后果 | 位置 |
|---|---|---|---|
| a | `实际占用 = 长方体总体积 − 2.5` 是**固定扣减** | **< 2314 米（23 卷）的单子体积为负数**，而这个数要给货代/报关 | `field_fence.py` `SpaceDeduction` |
| b | 尺寸类改自由数值后**绕过了别名表的单位因子** | 「竖丝间距(cm)」的 10 被当成 **10mm**，重量差十倍 | `importers._numeric_factor` |
| c | 空 spec 时变体没选 → 公式取不到 `raw_price`/`wave_factor` | **算出空值却仍返 200**（比报错更坏）。两端各补 `missing_variant` 400 | orchestrator `export_quote.py` / worker `ws_quote_ext.py` |

**另一个发现**：worker 的 `explain`（`ws_quote_ext.py`）**有自己的规格解析**
（`app/api/` 不在镜像范围），此前同样没读 `numeric_inputs` —— 生产端会算出空值。已修并对齐。

### 本轮新拍板的 4 项（用户 2026-10-11 决定，待实现）

| # | 决定 | 要做什么 |
|---|---|---|
| 1 | ✅ **已完成**（`b337251`）**体积扣减改为比例 3.7%**，与「装柜系数」合并 | 见下「体积扣减已修复」 |
| 2 | ✅ **结案：能力已存在，无需改代码**（用户 2026-10-11 确认）；但派生出 **2b** | 见下「档位自建：已存在的能力 + 一个新的缺口」 |
| 3 | **原料价历史 + 均价展示** | 每单填的原料价要留存，并在没有报价时给"参考均价" |
| 4 | ✅ **已完成**：勾花网（`48e591d`）+ 鹿网 | 见下两节 |

### 鹿网已实现（`products/deer_net.py`）

### 术语澄清：租户 ≠ 团队（**重要，避免再搞错粒度**）

用户追问「租户级是什么？团队粒度吗」时核查出的结论：

| | 是什么 | 现状 |
|---|---|---|
| **`tenant_id`** | 历史遗留的租户列 | **恒为 `"default"`**（`unify_tenant` 迁移把所有数据统一到它）→ **已经不是隔离边界** |
| **团队 `team_id`** | **真正的隔离边界** | 客户 / 订单 / 单证 / 工位订阅都按它隔离（B1 修的就是这一条） |

证据：`DEFAULT_TENANT = "default"` 遍布 orchestrator 与 worker；
**定价/成本这条路完全没有 `team_id` 过滤**（grep 零命中）；
而 `team_id` 密集出现在 `teams.py`(62) / `workstations.py`(23) / `auth.py`(22) /
`customers.py` / `orders.py` / `trade_docs.py`。

**所以「租户级一套」= 全实例共用（所有团队混在一起），不是团队粒度。**
此前一轮的选项用词误导了用户，已更正并重新确认。

另一个好消息：现有「自加档位」虽按 `(tenant_id, customer_id)` 存，
但 customer 属于 team（`customers.team_id`）→ **事实上已团队隔离**；
跨客户查看（`scope=all`）要求 `require_tenant_admin`（系统管理员）。
所以问题不在"有没有隔离"，而在"粒度选哪一层"。

### #2b 定稿：档位按**团队级**增删改查

用户 2026-10-11 最终裁决（更正后）：

| 对象 | 粒度 | 理由 |
|---|---|---|
| **档位目录**（有哪些档位、显示名、启用/停用） | **团队级** | 档位 = **公司能做什么**，不该因买家而异 |
| **成本价**（定价数据） | **买家客户级（不动）** | 成本 = **不同买家拿到不同价**，这是商务差异 |

实现要点（下轮照此做）：

- 新表 `team_option_overrides`，键 `(team_id, product_key)`，
  JSONB 载荷形如
  `{"coating_code": {"rename": {"zinc_40": "40克锌层"}, "disabled": ["pvc_black"]}}`。
  **不能塞进 `tenant_products`** —— 那张表存的是**完整 ProductSpec 快照**，
  写进去会让该租户的产品定义冻成快照，以后代码改产品定义它不跟着变。
- 应用顺序：产品定义（代码或租户快照）→ 并入买家自加档位（现有）→ **再套团队级覆盖**。
- **软停用**：停用的档位从下拉里消失，但 `spec_from_partial` 仍能解析它 ——
  否则已引用它的历史报价单重算会取不到档位。定价数据删除已是软删除，沿用同一惯例。
- **改的是显示名，不是 code**：code 是查价键的一半，一变历史定价数据与报价单就对不上。
- 一个待收口的一致性：现有「自加档位」是**从定价数据反推**的（per-customer），
  而档位目录改团队级后两者关系要明确。计划：**保留自动反推作为兜底**
  （不破坏"加档位只有一步：录成本"这个设计），显式目录负责**改 / 停用**。

**#2b 进度**：机制层已完成（存储 + 应用 + 读路径接线），**写接口待做**。

| 部分 | 状态 |
|---|---|
| 表 `team_option_overrides`（键 `(team_id, product_key)`，JSONB） | ✅ 模型 + 迁移 `202610110015` |
| `models.apply_option_overrides`（改名 + 标记停用） | ✅ |
| `models.visible_options`（界面清单过滤，引擎不用） | ✅ |
| `describe_space` / `describe_pricing_key` 滤掉停用项 | ✅ |
| `services/option_overrides.py`（读 / 整体写 / 增量合并 / 载荷归一） | ✅ |
| `_with_team_overrides` 接进有效产品定义 | ✅ |
| **写接口（增删改查 REST）** | ❌ 下轮 |
| **迁移应用到生产库** | ❌ 待做（表是空表，无数据风险） |

两条约束在**代码里**落实（不只是注释）：

1. **改名只动 `name`，`code` 一字不改** —— 查价键用 code，
   实测改名后 `describe_pricing_key` 仍输出 `zinc_40`、引擎仍能按 code 解析。
2. **停用是"标记"不是"移除"** —— 停用档位**留在 `options` 里**并打 `disabled: true`，
   于是引擎仍能解析它（已引用它的历史报价单可重算），
   而 `describe_space` / `describe_pricing_key` 把它滤掉（界面看不到）。
   专门有一条测试断言"引擎能解析停用档位"。

`_with_team_overrides` 在 `auth.team_id` 为空时**不做任何事**，
**不退化到全实例** —— 否则会把别的团队的档位混进来，正是本次要避免的粒度错误。

公式取自表格的公式字段：

```
单件重量 = 0.01234 × L × ( De² + Di²(N−2)/2 + (W×1000+80)×Dw²/(S×10)/2
                          + (N−2)×140×Dt²/(S×10)/2 )
```

整理成与牛栏网同写法（0.00617 = 0.01234 ÷ 2）后逐项等价。

**⚠️ 本产品没有真实数据可核对**：表格 21 行里**没有鹿网记录**
（只有牛栏网 / 勾花网 / 刺绳 / Y型立柱 / 骑马钉 / 围栏钳等）。
所以改成"把表格公式原样抄进测试再逐点比对"：4 组输入上两条公式相对误差 < 1e-20。
这一点已写进产品 `notes`，避免后人误以为它像牛栏网/勾花网那样被真实数据验过。

另外补了一条**防丢经验项**的测试：表格里的 `80` 与 `(N−2)×140` 是经验项，
去掉任一项后量纲照样对、数字照样出得来但**值错了**，所以专门断言
`带经验项 ≠ 只带80 ≠ 都不带`。

计价按**重量**（`cost_unit = "CNY/kg"`）：表格的成本公式是
`IF(产品="勾花网", L×W×元/㎡, 元/kg×单件重量)` —— **只有勾花网按面积**，
其余都按重量。这条由表格定的，不需要额外确认。

### 三个产品现状

| 产品 | 公式核对方式 | 计价口径 |
|---|---|---|
| 牛栏网 | 表格 4 行真实数据，**逐位相符** | 元/kg（按重量） |
| 勾花网 | 表格 3 行真实数据，**逐位相符** | 元/㎡（**按面积**） |
| 鹿网 | **无数据行**，与表格公式逐点等价（相对误差 < 1e-20） | 元/kg（按重量） |

### 勾花网已实现并用表格数据核算（`products/chain_link.py`）

**公式逐位对齐智能表格实测值**（表里勾花网 3 行，`单件重量` 是公式字段）：

| d(mm) | S(cm) | W(m) | L(m) | 引擎 | 表格 |
|---|---|---|---|---|---|
| 2.5 | 5 | 1.8 | 10 | 28.8000 | 28.8 |
| 3.0 | 6 | 1.8 | 10 | 34.5600 | 34.56 |
| 3.0 | 5 | 1.2 | 25 | 69.1200 | 69.12 |

按面积计价也对上了：`L×W = 30㎡ × 9.3 元/㎡ = 279` ✓（表格同为 279）。

**两处与牛栏网的实质差别**（都是表格口径，不是特例代码）：

1. **成本按面积**：`cost_unit = "CNY/㎡"`，件价 = 单位价 × **单件面积**。
   价链本身与单位无关（`price.breakdown(cost_pretax)` 只要求成本与 cost_unit 同单位，
   「单位价 → 件价」由产品自己乘），所以**没有为按面积计价改价链**。
2. **不预置表面处理档位**，由客户在定价数据里自建。

**「档位由客户自建」这条链路本轮才真正打通**，过程中发现两个必须修的点：

- `describe_pricing_key` 原本会**跳过没有取值的维度**。档位由客户自建时，
  产品定义里就是"声明了但没取值" —— 跳掉这一列，客户在定价页看不到、
  加不进来，就永远报不了价。已改为：**声明了就要画出来**（空选项也画），
  只有完全没声明的维度才跳过。
- 引擎本来就要求每个变体包都给值，于是"还没有档位"时报的是
  `缺少「表面处理」；可选: `（**空列表**，等于没说）。已改成可操作的提示：
  「该产品还没有可选档位 —— 请先在『定价数据』里添加档位」。

验证：模拟客户加档位后，`spec_from_partial` 正常解析、重量与表格相符；
新增 `tests/test_export_quote_chain_link.py` 10 条钉住上述行为。

### 体积扣减已修复（`b337251`，即上表 #1）

### 档位自建：已存在的能力 + 一个新的缺口（上表 #2 / #2b）

**#2 结案**（用户确认）：用户要的「表面处理档位由客户自行添加」**系统已经支持**，
不需要改代码。链路：

```
定价数据里加档位 → load_option_extensions(db, tenant, customer, product)
                 → models.extend_product 并入产品定义
                 → _with_customer_options 同时喂给「规格空间」与「算价」两个入口
```

关键性质（都是设计里写明的）：

- 新档位**只写 code + 显示名**，不写 `raw_price`
  —— 「成本由定价数据提供，这正是『定价数据就是成本来源』的落点」，
  即用户说的「只加名字、价每单填」；已有实现。
- 规格接口与算价接口**共用同一份有效定义**，注释原话：
  「两边看到的选项必须完全一致 —— 只要有一边用了原始定义，就会出现
  『下拉里能选、一算就报错』或者『算了但下拉里选不到』」。
- 产品定义是全局的，客户加档位是客户自己的事。

**#2b 新缺口**（用户追加口径：「保留全局默认，客户可以对其进行**增删改查**」）：

`extend_product` 目前**只会追加**（`options + added`），因此客户对**全局默认档位**
只能"用"，不能改名、停用或删除。要做到增删改查，需要一层**客户级覆盖**：

- 增：已有 ✅
- 删 / 停用：需要 per-customer 的 `disabled` 集合（且**不能删**历史报价引用到的
  档位，否则老报价单重算会取不到档位）
- 改：需要 per-customer 的显示名覆盖（`code` 必须保持稳定 —— 它是查价键的一半）
- 查：已有（定价数据矩阵会列出已定义取值 + 客户自加值）✅

设计要点：**改的是显示名，不是 code**。code 一变，历史定价数据与报价单就对不上了。

### 用户新指令（2026-10-11）

### 用智能表格真实数据核算报价引擎（`scripts/verify/verify_against_sheet.py`）

用户指令：「报价功能你可以用智能表格中的数据来核算是否正常」。
数据源：「客户询盘跟进表 → 明细表」（21 行 / 55 字段 / 19 个公式字段），
取**牛栏网且数据完整**的 4 行，两层核算。

**第一层 · 公式级：完全一致**（4/4 行相对误差 = 0，门槛 1e-20）

```
表  ：0.01234 × L × (De² + Di²(N−2)/2 + Dw²((W×1000+(N−1)×50)/2/(S×10)))
代码：0.00617 × L × (2·de² + (n−2)·dm² + dv²(w + (n−1)×50)/s)
```

数学上等价（0.01234 = 2×0.00617、w = W×1000、s = S×10）。
体积同理：表 `(卷径/100)²×W×数量` ↔ 代码 `卷径²×网高×件数`。
**这直接证明了 A2 改造没有动坏重量/体积链路。**

**第二层 · 引擎输出**：差异全部来自引擎**刻意**的 4 位小数落定
（代码注释：为了让表上「单卷重 × 卷数 = 总重」对得上）。

| 指标 | 最大相对偏差 |
|---|---|
| 单件重量 | 1.4e-6 |
| 单件体积 | 2.4e-4（0.0724 vs 0.0723823） |
| 长方体总体积 | 4.3e-4 |

建议（未改）：体积类 `decimals` 由 4 提到 6 —— 体积量级只 0.1 m³，
第 4 位小数已是 0.1% 分辨率，乘几百件后放大到 4e-4。

**顺带发现两处口径差异（未擅自改）**：

1. 表格里真实的装柜系数是 **0.96（扣减 4%）**，而上一轮按
   「满柜 2–3 m³ ÷ 40HQ 68 m³」推算的是 **3.7%**。满柜处两者都落在工厂经验区间
   （4% → 2.72 m³、3.7% → 2.52 m³），但**表格是业务自己配的数**。
   「以表格为准」与「按整柜容量上限推算」两条指令在此冲突，待用户确认。
2. 表格把装柜系数做成**每行可编辑的输入**（21 行都是 0.96）→
   它应当是**每单可改**的，而不是产品定义里的常量。

1. 「系统化全部开始吧，该做的都要做」—— 剩余项按依赖顺序逐项推进，不再逐条等确认。
2. **「报价功能你可以用智能表格中的数据来核算是否正常」**——
   企微智能表格「客户询盘跟进表 → 明细表」有 **21 条真实记录**（55 字段、19 个公式字段），
   可作为报价引擎的**黄金数据集**做交叉验证：用表里的输入参数跑我们的引擎，
   比对表里公式算出的单件重量 / 总体积 / 成本 / 售价 / FOB·CFR·CIF。
   这是对 A2 改造最直接的正确性证据。

原先 `实际占用 = 长方体总体积 − 2.5 m³`（每单扣一次、不随数量缩放）。
实测牛栏网：**< 2314 米（23 卷）的单子实际占用体积为负数** ——
而这个数是要给货代/报关的。

改为 `volume_effective_m3 = volume_box_m3 × (1 − space_deduction_ratio) − space_deduction`：

| 订单米数 | 卷数 | 长方体体积 | 实际占用 | 扣减 |
|---|---|---|---|---|
| 100 | 1 | 0.1080 | **0.1040** | 0.0040（原为 −2.3920） |
| 30000 | 300 | 32.4000 | 31.2012 | 1.1988 |
| **63000** | **630** | **68.0400** | **65.5225** | **2.5175** ← 满柜，落回工厂经验「2~3 m³」 |

比例 `0.037` 的来源：工厂原话「满柜减 2–3 m³」取中位 2.5
÷ 40HQ 可用容积约 68 m³。**该推算被满柜数据反向验证**（2.52 m³ ∈ [2,3]）。

模型上 `SpaceDeduction` 新增 `mode="ratio"`；固定额与比例是两个不同性质的量
（m³ vs 无量纲），分开给、公式里合成，两者可叠加。
`explain` 两端也补了该系数（它们各自设作用域，漏了会算出空值）。

**第 6 项是回退的原因**：导表（CSV/Excel 导入导出）的表头映射在
`importers._build_header_map` / `_resolve_column` / `template_columns` 里，
它按 `product.axes` / `variants` 建表，不认识 `numeric_inputs` ——
不补这一环，`field_fence` 的报价表**整个导入不出来**。
而这里映射错了会**静默导错报价数据**（不是报错），风险高于收益，
所以没有在同一轮里硬塞。正确顺序是：先补 importers + 模板生成，
再改产品定义，最后动前端。

**表格公式（已逐项核对）**：牛栏网的代码实现与表格**完全等价** ——
代码 `0.00617×L×[2·d边²+(n−2)·d横²+d竖²(w+(n−1)×50)/s]`
↔ 表格 `0.01234×L×(De²+Di²(N−2)/2+Dw²((W·1000+(N−1)·50)/2/(S·10)))`。
待补的是另两个产品的分支（鹿网含 `(N−2)×140×拧花丝径²/(S·10)/2` 一项；
勾花网是 `d²×1.28/S×W×L`，且**成本按面积** `L×W×元/㎡`，不是按重量）。

**一个待你确认的设计点**：表格把「原材料进货成本 元(kg/㎡)」做成**每单填写的输入**，
而代码把它做成产品变体属性 + 定价数据查表（`raw_price`）。
按"以表格为准"，新产品的原料成本应声明为 `numeric_inputs`（每单填）；
但那样会与现有「定价数据」机制并存。这一条下一轮开工前需要你点头。

| 值 | 来源 | 推导 |
|---|---|---|
| **120** | 前端轴相乘 | 3（丝径方案）× 2（网高）× 2（竖丝间距）× **5**（镀锌量）× 2（工艺） |
| **160** | `NIULANWANG_COMBO_COUNT` + 后端 4 处断言 | `RELEASE_2026-10-10_quote_model.md:61` 记「组合数 64 → 160」；`1efeabc` 同一提交把镀锌量扩到 5 项并写下 160 |
| **48** | 测试断言（`niulanwang.test.ts:22`） | 3×2×2×**2**×2 —— 镀锌量还是 2 项时的旧值 |

关键：`64 = 4×2×2×2×2` ⇒ 那个口径假定**丝径方案有 4 个取值**，
而前端 `NIULANWANG_SKU_AXES.wire_option` 只有 **3** 个（`all_wire_20` / `all_wire_25` / `edge25_inner20`）⇒ 才落到 120。

**所以是二者之一，都需要业务判断，本轮没有擅自改**：
1. 前端 `wire_option` 漏了一个取值（补上则 4×2×2×5×2 = 160，与后端一致）；或
2. 后端的 160 已过期（则前端 120 与常量都该跟着改）。

---

## 三、需要产品决策（不擅自改）

1. **A2 的柜级体积扣减层级**：2–3 m³ 是「圆柱体按长方体算、对**整柜**多占的量」（工厂经验总结）。
   现在引擎 `resolve_space_deduction` 把它解析成**一个数、只扣一次**（等价"每单一次"）。
   一单多柜时应改为 `扣除额 × 柜数` —— 需你确认按「每单一次」还是「每柜一次」。
2. **`outreach/webhook` 是否收紧到 POST**（对应 §二 #3）：处理体是 501 预留桩、
   任何方法都无副作用，所以不急；但将来若实现 inbound 回写，`GET` 必须去掉
   —— 邮件客户端预取链接会误触发（标记已回复之类）。

**已定的（记录口径，勿再当作待决）**：

- **租户模型** → 统一到 `default`（收敛为「单租户 + 团队隔离」）。**已于生产执行**（见上「生产库对齐」）。
- **新团队试用工位** → **维持现状**（不给试用，由管理员开通）。
- **共享 Repository 层** → **删除**，不接线（`e6b54e5`）；理由见 `DB_LAYER_OPTIMIZATION.md`。

---

## 四、需要排期 / 环境（非本轮）

- ~~规格库 11 条接口补齐~~ ✅ **已退役**（`8225bbf`，见下「规格库 11 条已退役」）
- 依赖升级专项（next 15 + 漏洞收敛）
- e2e 26 条归真
- 产品定义**可视化**编辑器（现仅 JSONB 文本编辑）
- 团队管理员转让（现固定为创建者）
- 单证渲染**投产联调验收**：18 种模板就绪，生产联调（字段打通 / PDF·打印 / 盖章 / 双语 + 样张对照）未做

---

## 五、文档状态（照旧文档施工会踩空）

| 文档 | 状态 |
|---|---|
| `CURRENT_IMPLEMENTATION_MAP.md` | 多处过期（stat-card / POST quote / product-specs / stage 分叉 / shipments 门禁） |
| `archive/2026-10-20-closeout/MULTI_PRODUCT_QUOTE_PLAN.md` | `:86`、`:380`、`:482` 三项已不成立 |
| `archive/2026-10-20-closeout/WORKER_ORCHESTRATOR_DRIFT.md` | 数字口径过期（当时工具只读 `worker/src/main.py`），已被 `route-parity.py` ＋ 修好的 `route-parity-audit.py` 取代 |
| `DUAL_BACKEND_CONVERGENCE.md` | 方案仍"待批准"；A 类 33 → 现 6、B 类 10 → 现 8 |
| `EXECUTION_SUMMARY_2026-10-10.md` | `:69` 与 `PRODUCT_CONFIG_TENANT_UNFINISHED.md` 自相矛盾 |
| `FRONTEND_PRODUCTION_READINESS.md` | A/B/D 标"执行中"，实际已落地 |
| `PLATFORM_UPGRADE_PLAN.md` | `:47-49` 命名冲突已由契约 + R2 收口 |
| `ROUTE_PARITY_2026-10-10.md` | 结论以本文 §一、§二 为准（缺口 24 → 22，待补 13 → 11，worker 独有 12 → 8） |

---

## 复现方式

```bash
pnpm -C frontend contracts:check
pnpm -C frontend test
pnpm -C frontend typecheck
python scripts/route-parity.py
python scripts/route-parity-audit.py
cd backend/worker && pytest tests -q
cd backend/orchestrator && pytest -m unit -q
```

***

## 追加：团队管理员转让 —— **全链路完成**（`9d42f44` + `99f783c`）

> 补记。用户 2026-10-11 裁决：**现任团队管理员也能自己转**（不必再找平台管理员）。

| 层 | 内容 | 提交 |
|---|---|---|
| orchestrator | `POST /api/v1/teams/{team_id}/transfer`（body `{user_id}`）；授权复用 `_require_team_admin` → 共享内核 `is_team_admin`，**未新增授权规则**；校验走共享内核 `validate_transfer_target` | `9d42f44` |
| worker | 同路由同语义（否则线上 404）；实现后 allowlist 那条「待补」**已删除**（棘轮要求） | `13389b6` |
| 前端 | 成员面板「操作」列加「转让」按钮（只对非管理员成员显示）；确认文案**写明后果**：不可逆的自我降权、要收回只能让对方转回 | `99f783c` |

**策略无关校验**（目标必须是本团队成员、不能转给自己）在共享内核并测住 **9 条**
（`tests/test_team_transfer_rules.py`），两端共用。

**动作语义**：改 `teams.created_by`（本项目"管理权"就等于创建者）；前任留在团队里当普通成员。

**验证**：`route-parity` 缺失回到 **11**（两端齐平，线上不再 404）；
orchestrator 598 passed；worker 142 passed；前端 `typecheck` exit 0、
`NEXT_EXPORT` 构建 exit 0（34/34 静态页）。

**已补**：接口级（带库）测试 —— `tests/test_teams_transfer_api.py`（`5ac9c60`，7 条：
转给成员 / 前任留作普通成员 / 转给自己 422 / 非成员 422 / 普通成员 403 /
平台管理员可发起 / 未知团队 404）。纯函数校验另有 9 条单测。
（该文件需 PostgreSQL：本机无库时**整体 skip**，不假绿；CI 会跑到 ——
本仓库带库测试的既有约定。）

### e2e 一条线的深度结论另见

`docs/E2E_STATUS_2026-10-11.md` —— 因本文档当时被另一条任务（单证 PI 模板）
并发编辑，e2e 的结论独立成文，避免写冲突。

***

## 追加：目标原文逐条对照（取证于 `149fccf`）

> 目的：让接手者**不必读任何对话**，只看这张表就知道每一项做到哪一步、证据在哪。
> 「✅」= 有提交且在远程核验通过；「🔶」= 部分完成；「⏸」= 卡在输入/环境。

| 目标原文 | 状态 | 证据 / 卡点 |
|---|---|---|
| A1 worker 补「单证合计=行项合计」勾稽 | ✅ | `c2ee256` |
| A2 规格体系改自由数值+公式；牛栏网/鹿网/勾花网；税务项可配、不要手工覆盖项 | ✅ | `f6b4b62`…`6d27b39`；`Sheet` 真实数据核算 `c7d096e`（公式级不一致 0） |
| B1 修租户/团队隔离（管理员见所有团队、成员仅见本团队）+ 联佳丝网生产可见 | ✅ | `2a46e63` + 生产库迁移 |
| B2 新团队试用工位维持现状 | ✅ | 用户裁决**维持**，无需改动 |
| C1 处置共享 Repository 死代码 | ✅ | `e6b54e5` |
| C2 worker 客户可见性对齐共享内核 | ✅ | `7688b77` |
| E 生产部署先保持 | ✅ | 无需动作 |
| 规格库 11 条接口 | ✅ | 用户裁决**退役**：`8225bbf`（路由已删、allowlist 已撤） |
| 依赖漏洞 | 🔶 | 98 → **78**；余 **2 critical 全是 `next`**，只能在 Next ≥ 15.5.24 修（14→15 跨大版本 + React 19）——用户已定**单独排期** |
| e2e 归真 | 🔶 | 已修 **2 个真实应用缺陷**（`customers/page.tsx` 的 `.length`/`.map`）；**排除 7 个假设**；根因收窄为"`/api/v1/*` 不被 MSW 拦截"；**数字受并发构建污染，须静止重测**。详见 `docs/E2E_STATUS_2026-10-11.md` |
| 产品定义可视化编辑器 | ⏸ | **待用户输入**：要编辑哪些字段？存 `tenant_products` 快照还是增量覆盖？（后者有"租户一改就被冻住"的已知风险） |
| 团队管理员转让 | ✅ | 后端两端 `9d42f44` / `13389b6` + 前端入口 `99f783c`；策略无关校验 9 条单测 |
| 单证投产联调 | ⏸ | **需生产环境**（字段打通 / PDF·打印 / 盖章 / 双语 + 样张对照）；另一条任务正在做 PI 模板，**可考虑合并联调** |
| 前端认证契约残留 | ✅ | `35a89a8`（不再发 `X-Tenant-Id`） |
| 反向漂移 8 条 | ✅ | 6 修 + 2 有意保留：`65db192`、`2a158cb` |
| 旧表 `customer_pricing_profiles` 活读取路径 | ✅ | 整链删除（−671 行）；表保留（有历史数据，退役状态） |

**结论**：目标 17 项中 **✅ 12 项、🔶 2 项、⏸ 3 项**。
三项 ⏸ **全部卡在外部**（用户输入 / 生产环境），**不是未做**。

**另**：本会话额外产出（不在目标原文里但已落地）——
原料价历史均价、`AGENTS.md` 全局规则、爬取移植（含**修掉生产 SSRF 绕过**）、
`docs/E2E_STATUS_2026-10-11.md`。

---

## 追加（2026-10-11 晚）：生产库重新打通 + 文件存储规划

**生产库访问已恢复**（此前所有路径都断：Hyperdrive 口令被 Cloudflare 抹掉、
Neon 令牌过期、Edge 无会话、无 `.env`）：

- 用 Neon CLI 重新登录（`neon login`，OAuth；**Agent 不自行拉起浏览器**，由用户完成授权），
  签发**项目级 API key**（`dsh-mcp-2026-10-11`，id `3419989`）→ 写
  `~/.dsh/neon-api-key.txt` + **用户级环境变量 `NEON_API_KEY`**（供 `mcp-neon` 使用，
  **DSH 重启后生效**；此前 `mcp-neon` 一直 disconnected 就是缺这个变量）。
- `neon env pull --file <temp>` 取得生产 DSN（**未打印口令**），只读连通性验证通过：
  `public` 表 **100** 张；`users=3`、`customers=1`、
  **`trade_docs=0`、`trade_doc_items=0`、`tenant_company_seals=0`、`external_doc_uploads=0`**
  ⇒ **生产环境一张单证都没开过、一枚公章都没存过**（单证工位在生产上从未真正使用）。

**文件存储规划**（用户要求：业务数据与文件各存在自己的位置，不要内联混在业务表里）
→ 新增 `docs/PRODUCT_MEDIA_STORAGE_PLAN.md`：

- 三层分开：**业务行**留在各业务表 / **文件元数据**进 `file_objects`（全平台唯一文件域）/
  **文件本体**进对象存储（生产 **Cloudflare R2**，本地 MinIO，同为 S3 兼容，代码一份）。
- 产品图**引用而非复制**：产品图存一份，单证用 `trade_doc_files.file_id` 引用
  ⇒ 「一次维护、重复使用」。
- 盖章回传按用户裁决**版本化**：新版本上位 `is_current`、旧版 `supersedes_id` 留档。
- 待拍板：文件本体是否用 R2（建议采纳）；产品 key 直接用现有 `ProductSpec` key（不建第二套主数据）。

**（续 · 2026-10-11 晚）字节落点与 S3 直传：实现完成并交叉验证；S3 密钥已设置，真实上传实测待做**

- **落点优先级**（Worker 与本地 orchestrator **共用同一段 SigV4 代码**与「什么算配好」的规则）：
  ① **S3 预签名**（配好 `S3_*` 时；浏览器直传，**字节不过服务端**）→
  ② **R2 binding**（`FILES`，桶 `kaas-files`；生产 Worker 的平台直连）→
  ③ **inline**（写 `file_objects.content` 兜底）。
  本地 orchestrator 无 binding，是 ① → ③。**无论走哪条，真实落点都写入
  `file_objects.storage`**（`s3` / `inline`），不隐瞒数据在哪。
- **新增共享内核** `backend/kaas_common/files/s3.py`：AWS **SigV4 预签名**，**纯标准库**
  （Pyodide 装不了 boto3），含 `s3_config(get)` —— 统一「配好 = endpoint + access_key + secret_key」，
  不完整返回 `None`（调用方据此回退），避免两端各自判断漂移。
  **正确性证据**：`backend/orchestrator/tests/test_files_s3.py` **8 条通过**，其中与本地
  `minio-py` 的 `presign_v4` **逐字符比对签名**（GET / PUT、不同有效期）完全一致 ——
  自己写的密码学必须拿独立实现对照，否则「看起来能跑」说明不了任何问题。
  `sync-shared.ps1 -Check` 实测：共享内核 **26** 个文件一致（此前记录 23）/ 报价引擎 19 / 枚举字典 1。
- **直传相关端点（两端一致）**，orchestrator OpenAPI **实测 170 条路径**（此前 167）：
  - `POST /api/v1/file-objects/presign`（**新增**；未配 S3 返回 `{"configured": false}`）
  - `POST /api/v1/file-objects/register`（**新增**；直传后登记元数据，不碰字节）
  - `GET /api/v1/file-objects/{id}/url`（短时效直链，**默认 900 秒**）
  - 前端 `/products` 已走**直传优先、失败回退 multipart 代理**。
- **基础设施实测**：R2 桶 `kaas-files` 已建；**桶 CORS 已设**（Cloudflare API 读取实测：来源
  `https://kaas.powervoy.com` / `http://localhost:3000` / `http://127.0.0.1:3000`，
  方法 `GET`/`PUT`/`HEAD`，允许头 `Content-Type`，暴露 `ETag`，maxAge 3600）；
  `backend/worker/wrangler.jsonc` 已加 `r2_buckets`（binding `FILES`）与非机密
  `vars`（`S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_PRESIGN_EXPIRES`）。
- **激活步骤**：R2 的 S3 密钥只能在 Cloudflare dashboard 的 **Manage R2 API Tokens** 创建 ——
  **Cloudflare API 没有创建长期 R2 S3 密钥的端点**（已核对 OpenAPI：只有
  `/r2/temp-access-credentials` 临时凭证与 R2 SQL catalog 凭证）。
  ✅ **密钥已设置（用户操作，已完成）**：用户在 dashboard 给 Worker `kaas` 设了
  `S3_ACCESS_KEY` 与 `S3_SECRET_KEY`；由 lead 用 Cloudflare API **只读核验名称存在
  （`secret_text`），未读取值**。
  ⚠️ **后续生产验收发现该 access key 长度不合规（13 位，R2 要求 32）⇒ 生产直传不可用**，
  详见「续四」。
  ⏳ **但真实上传（R2 写入/读取）端到端实测仍未做** —— 需要一次带登录的实际上传；
  在实测通过前**不得声称「生产上传已成功」**，① 是否已在生产生效也尚未核实。
- **进度表更新**（`docs/PRODUCT_MEDIA_STORAGE_PLAN.md`）：第 **9** 项
  「单证编辑页从产品图库选图」**已完成**（`trade-docs/components/doc-photo-picker.tsx`：
  选产品 → 点图 → 写入 `{"file_id": N, "caption": …}`，已添加的图标记「已添加」防重复）；
  第 **10** 项改为「S3 实现已完成且交叉验证（含 15 条真回环）；**S3 密钥已由用户在 dashboard
  设置**；**真实上传端到端实测待做**」。
- **前端门禁实测**：`typecheck` 0 error；`lint` 0 error / 9 warning（均为既有）；
  `test` **304 passed / 22 files**（**lead/队友实测**；已同步更新本文 §「当前门禁」表）。

**（续二 · 2026-10-11 晚）构建门禁在并发 worktree 下曾假红（已修）；并补一组 S3 真回环验证**

**1. 构建门禁（`NEXT_EXPORT=1 pnpm build`）：现在 PASS，且加了并发隔离**

- **曾两次失败**（原地跑）：`Cannot find module 'frontend/.next/server/middleware-manifest.json'`；
  换独立目录后又出现 `PageNotFoundError: Cannot find module for page: /admin/gray-release`。
- **定性：并发环境问题，不是代码缺陷**。同一 worktree 里**另一条线正在跑 `next dev` +
  Playwright e2e**，双方都写 `frontend/.next`。取证：frontend 源码整体复制成隔离副本
  （**284 个文件**，`node_modules` 用同深度 junction）后 `next build` **exit 0**，全路由表正常输出。
- **修复**：`frontend/next.config.mjs` 加 `distDir: process.env.NEXT_DIST_DIR || ".next"`；
  `.gitignore` 加 `.next-build/`。
- **复测（本 worktree，并发 `next dev` + e2e 仍在跑）**：
  ```powershell
  $env:NEXT_EXPORT="1"; $env:NEXT_DIST_DIR=".next-build"
  node node_modules/next/dist/bin/next build    # exit 0
  ```
  文档线复跑得到 **exit 0**，全路由表正常输出（37 条路由 + middleware）。
- ⚠️ **但 `NEXT_DIST_DIR` 只隔离产物目录，不隔离源码的并发写**：文档线首次尝试（与另一条线
  改写 `frontend/src/app/(app)/trade-docs/*` 的时间重叠）**仍是 exit 1**
  （`Export encountered errors`，含 `JSON.parse` 栈）；等对方写入停止后同命令复跑 exit 0。
  ⇒ 「**取数前确认工作区静止**」这条纪律对构建同样适用。
- ⇒ **口径**：构建门禁**通过**；但**并发 worktree 下必须**用 `NEXT_DIST_DIR` 指定独立产物
  目录，否则会与 `next dev` 互相破坏 —— 这类失败看起来像代码坏了，实际是环境。

**2. 新增 S3 真回环验证**：`backend/orchestrator/tests/test_files_s3_roundtrip.py`（15 条，`unit`）

- 在 `127.0.0.1` **随机端口**起纯 `http.server` stub S3，**真发 PUT/GET 字节**，
  断言 stub 实收的路径 / 内容 / `Content-Type` 正确；
- 对 stub **实际收到**的请求，用 `minio.signer.presign_v4`（独立实现）按 `X-Amz-Date` /
  `X-Amz-Credential` 里的 scope **重算并逐字符比对**签名与整个查询串；
- 覆盖 inline 回退的 5 种半配形态（全没配 / 只有 endpoint / 只有密钥 / 少 secret / 空白 endpoint）。
- **实测**：该文件 **15 passed**；文件域三件合跑 **41 passed**（`test_files_kernel.py` 18 +
  `test_files_s3.py` 8 + 本文件 15）。
- **变异自证**（队友实测）：篡改签名 / 错 secret / region 漂移 / 方法互换 **4/4 被拒**。
- ⚠️ **这条验证的边界（必须如实标注）**：stub **不做服务端验签**，所以
  **「生产 R2 会接受这个预签名 URL」仍未证实**。它证明的是两件事 ——
  「生成的 URL 是正确的 SigV4 预签名」+「代码路径真能 PUT/GET 字节」。

**3. 门禁滚动表已按本轮实测更新**（见本文 §「当前门禁」）：orchestrator **680 passed / 1 skipped**、
worker **142 passed**、共享内核 **26** 个文件、构建门禁 **PASS** —— 这四项由**文档线复跑**；
前端 `test` **304 / 22 files** 为 **lead/队友实测**。

**（续三 · 2026-10-11 晚间最终轮）产品图排序 + 公章链路 + 三个缺陷修复**

**1. 迁移 018 已上生产**：`file_objects.sort_order INTEGER NOT NULL DEFAULT 0`（**只新增列**，
存量行自动补 0；`downgrade` 只删列）——`backend/orchestrator/alembic/versions/202610110018_file_sort_order.py:31-41`。
lead 实跑 `alembic upgrade 202610110018` 成功；生产只读复核 = **23 列**、`sort_order` 默认 0。

**2. 产品图排序**（目标口径要求，此前只有"设主图"）：
- 两端同一常量 `_FILE_ORDER_BY = "is_primary DESC, sort_order, id"`
  （orchestrator `files.py:74` ↔ worker `ws_files.py:69`），媒体/列表共用；
- `PATCH /file-objects/{id}` 接受 `sort_order`，范围 **0–9999**（`_MAX_SORT_ORDER`），
  越界 **422 `SORT_ORDER_OUT_OF_RANGE`**（`files.py:360-367` / `ws_files.py:370-375`）；
- worker 的 `FilePatch` 补上此前缺失的 `caption`，两端字段一致（`files.py:324-328` / `ws_files.py:338-342`）；
- 前端卡片「上移/下移」+ 位次徽标 + **主图恒最前**（第 2 张不能越过主图）；
  只对位次真变的图发 PATCH、失败提示（`products/page.tsx:91-93,97-113,319,346-363`）。

**3. 公章链路**（此前前端**无任何入口** ⇒ 生产 `tenant_company_seals` **0 行**，PI 永远出不来章）：
- 上传界面 `CompanySealCard` 挂在 `settings/company-profile`；5 个端点与两端后端一一对应
  （后端路由 `backend/orchestrator/app/api/company_seals.py:112,201,217,241,263`）；
- **Canvas 转 PNG 是后端契约要求**（`validate_seal_image` 只认 PNG 魔数，
  `kaas_common/trade_doc/png.py:42`），**不是降级**；
- 空态明说「没有公章时签章区不会盖章」。
- **默认章自动带入渲染**：纯函数在共享内核 `backend/kaas_common/files/seal.py`
  （`SEAL_FIELD` / `seal_field` / `seal_data_uri` / `apply_default_seal`）；
  优先级 = `custom` **显式给过**（含空串）⇒ 不覆盖、不查库 → 否则取 `is_default` 转 data URI →
  无默认章/空字节/None ⇒ **不注入**（**不伪造空图**）。两端只剩取数壳
  （`trade_docs.py:47,775-779,827` / `main.py:3589,3598-3608,3683`），
  且 `apply_default_seal` 是**同一个函数对象**（测试断言 `test_trade_doc_seal_default.py:79`）；
  `sync-shared -Check` 共享内核 **27** 文件一致。

**4. 三个缺陷修复**（队友发现、lead 修）：
a) 坏 `file_id`（如 `{"file_id":"abc"}`）让 render-data **500** → 共享内核新增 `coerce_file_ref_id`
   （只认正整数/数字字符串，**`bool` 单独挡掉**——它是 `int` 子类），`is_file_ref` 复用它
   （`kaas_common/files/rules.py:203,232-235`）；回归测试用 **`db=None`** 证明坏 id 走完装配**不触库**，
   合法引用在 `db=None` 下必然抛错作为对照。
b) `attach_doc_file` 让位只处理 `stamp_scan` ⇒ 反复归档 PDF 会出现多条"当前 PDF" →
   扩到 `("stamp_scan","render_pdf")`，旧链接挂 `<role>_superseded`、**不物理删**
   （`files.py:543-550` / `ws_files.py:466-472`）。
c) 前端两处：界面把 Markdown `**` 当文本渲染；历史版本号用 `version+1` **推算** →
   改为按**后继件的 `supersedes_id`** 找后继（`doc-stamp-return.tsx:118-124`），两条都已被测试钉住。

**5. 验证资产**：`backend/worker/tests/test_ws_files_storage.py`（**34**）、
`frontend/src/lib/products/__tests__/use-products.test.ts`（**9**）、
`frontend/src/app/(app)/trade-docs/components/__tests__/doc-stamp-return.test.tsx`（**5**）、
`backend/orchestrator/tests/test_trade_doc_seal_default.py`（**28**）、
`docs/TRADE_DOC_PDF_ARCHIVAL.md`（PDF 留档设计，含 6 项"未验证"，其中第 6 条**已于本轮核对并修正** ⇒ 当前仍开放 **5** 项）；
另修测试配置缺口：仓库此前**没有任何 `.tsx` 测试**，而 `tsconfig` 的 `jsx: preserve` 会被 Vite 8 的
**oxc** 照搬 ⇒ 任何 import `.tsx` 的测试都跑不起来；`frontend/vitest.config.ts:13` 加
`oxc: { jsx: { runtime: 'automatic', importSource: 'react' } }` 修好。

**6. ⏳ 仍未做（保持待办，别写成已完成）**：
① **真实上传端到端**（工具 `scripts/verify-file-storage-e2e.mjs` 已备，需一次**带登录的生产上传**）；
② **真实 PostgreSQL / db 级用例**（部分唯一索引唯一性、跨租户隔离、`bytea` 往返）；
③ **盖章在 PI 版式中的位置/尺寸无视觉验证**；
④ **排序的页面级过滤逻辑**未被测试覆盖（hook 层有契约测试，页面层没有；
   队友已说明**没有用复刻逻辑假装覆盖**）。

**7. ⚠️ 构建门禁本轮再复现假红（如实记录）**：文档线用
`$env:NEXT_EXPORT="1"; $env:NEXT_DIST_DIR=".next-build"` 复跑**失败**
（`PageNotFoundError`/ENOENT，`load-components`）；当时另一条线正在写
`frontend/src/mocks/handlers.ts` 等（**22:54:20** 仍在写）。⇒ `NEXT_DIST_DIR`
**只隔离产物目录、不隔离源码并发写**；**构建门的数字只在工作区静止时作数**。

**（续四 · 2026-10-11 深夜）生产真实验收：入口打通、配置齐全，但卡在 R2 密钥长度；直传失败改为自动回退**

**1. 生产验收已执行（有硬结论）**
- **入口打通方式（经用户授权）**：临时替换 `qa_user@qa.kaas.internal` 的 **bcrypt 哈希** →
  登录拿到 JWT → **立即改回原哈希**。复核两点：**恢复后与备份逐字一致**、
  **新口令不再匹配** ⇒ **生产数据最终未变**。
- 因 `PUT` 被拒，**没有创建任何测试记录**（`register` 未执行）。
- 核实到的事实：生产 `users` 只有 **3 个账号**（`admin@kaas.dev` / `qa_user@qa.kaas.internal` /
  `qa_customer@qa.kaas.internal`），**没有联佳账号**；口令全为 **bcrypt（不可还原）**
  ⇒ 「从库里取登录凭证」这个说法**在事实上不成立**。
- 线上配置已核实**齐全**：`S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_PRESIGN_EXPIRES`（`plain_text`）
  + 两个 secret + `FILES` binding。

**2. ⏳ 唯一坏点：`S3_ACCESS_KEY` 只有 13 位（R2 要求 32 位）**
- 现象：预签名 `PUT` 返回
  **`400 InvalidArgument: Credential access key has length 13, should be 32`**。
- ⇒ **生产 S3 直传当前不可用**；**服务端代理上传（multipart）仍可用**。
- ⏳ **待用户重建 R2 S3 密钥并更新 Worker 的 `S3_ACCESS_KEY` / `S3_SECRET_KEY`**
  （步骤见 `docs/PRODUCT_MEDIA_STORAGE_PLAN.md` 文末 FAQ）。
- 在密钥修好并跑通 `scripts/verify-file-storage-e2e.mjs` 之前，**不得声称「生产直传已成功」**。

**3. 新增健壮性行为（已实现并推送）：直传失败 ⇒ 自动回退服务端代理，且不静默**
- `presign` 请求失败 / `PUT` 非 2xx / `PUT` 抛异常 ⇒ **回退 `POST /products/{key}/media`**，
  返回体带机器可读标记 **`fellBackToProxy: true` + `fallbackReason`**；
  界面如实显示 **`已上传（直传失败：<原因>；已走服务端兜底）`**（`products/page.tsx:126-131`）。
- **`PUT` 成功但 `register` 失败 ⇒ 抛错、不回退重传**（避免重复对象 / 重复流量）。
- **`configured=false` 不算回退**（设计如此，不给用户惊吓）。
- 证据：`pnpm test` 文档线实跑 = **28 files / 354 passed**（`use-products.test.ts` **13 tests**）；
  **lead 实测**：4 条新用例在旧实现下都会红（文档线未复现"旧实现下红"这一步）。
- **未覆盖**：`products/page.tsx` 的 `doUpload` **无自动化测试**（整页渲染成本高，本轮未做）。

**4. 必须写清楚的运行事实**：在密钥修正前，**UI 里产品图上传**会走"直传失败 → 服务端兜底"这条路径
（用户看到带原因的提示），**不是静默成功** —— 这正是不掩盖故障的设计。

**5. 待办更新**：原「① 真实上传端到端」由 **⏳ 未做** 变为 **⏳ 已尝试、卡在密钥长度**
（工具 `scripts/verify-file-storage-e2e.mjs` 已备好，密钥修好即可跑）；②③④ 不变。

***

## 追加：智能体团队收口 + **e2e 转绿**（2026-10-12 00:1x）

> 用户指示「执行任务时创建智能体团队提高效率」后，本条线以 **4 名队友 / 13 个共享任务**推进，
> 写入范围互不相交，每项都要求 file:line 证据 + 门禁 + 范围自证。

### 🎉 e2e 归真：**19 passed / 6 skipped / 0 failed**（= 25，算术核对 ✓）

**根因（不是 MSW、不是 Service Worker、不是 axios adapter、也不是并发 build）**：

> **`MswProvider` 用"启动过"当放行条件** —— 旧实现的真值是 `started.current` / `globalStarted`
> （语义 = "**启动过**"），而 `next.config.mjs:10` 开了 **`reactStrictMode: true`**，
> React 18 dev 会 mount → 模拟 unmount → mount ⇒ effect **第二遍立刻走"启动过 ⇒ 放行"分支** ✗
> ⇒ 首屏 `/api/v1/*`（`auth/me` / `events` …）在 `worker.start()` 之前发出 ⇒ **绕过 MSW**
> ⇒ 命中 Next dev 的 `/api/v1/*` rewrite ⇒ **自己代理自己** ⇒ 500/挂起
> ⇒ `/auth/me` 失败 ⇒ 清会话 ⇒ `RouteGuard adminOnly` **整页不渲染**（「您没有访问此页面的权限」）

**修法**（`4dd125b` + `8d8f600`）：改成**模块级就绪 promise**，语义从"启动过"改为"**真就绪**" ——
只 `worker.start()` 一次、`setReady(true)` 只挂在 promise 的 `.then` 上（两遍都只能在真正就绪后放行），
并加 **总预算 fail-open**（`Promise.race([ready, 5s])`，防 `worker.start()` 卡住导致永久白屏）。

**机制级证据（比通过数硬）**：

| 判据 | 修前 → 修后 |
|---|---|
| `e2e/kb.spec.ts:4`（页面**纯静态** ⇒ 失败**只能**由数据层解释；判据文件**全程未改**） | **0/5 → 5/5** ✓（90s → 15.1s） |
| 探针顺序 | 修前：`auth/me`×2 + `events` 在 `[MSW门] started` **之前** ✗ → 修后：`started; controller = true` 在**所有 `/api/v1/*` 之前** ✓ |
| `[绕过MSW]` | **归零** ✓（18 次用例里 `[MSW门]` 日志 **14/14** = `controller=true`，`start FAILED` = **0**） |
| fa-open | 触发 **0 次**；`ok=18 / x=5 = 23 = 5+9+9` ✓ |

**顺带修好三处**：`dashboard` 的 `summary={}` **崩**（**0/3 → 3/3** ✓，按既有口径渲染 `—` 而非 `0 个数据集`）；
删除死文件 `e2e/setup.ts`（**删前删后 `--list` 都是 25/8** ⇒ 零覆盖损失 ✓）；
残余"测试侧"写法（`networkidle` 后**一次性 `count()`** ⇒ 门未开时"没有请求"⇒ `networkidle` 立即满足 ⇒ `count()=0`）
改为**可重试断言** ⇒ `57ab4b7` **套件转绿** ✓

### 同期完成的收口（12 项）

| 主题 | 产出 | 关键提交 |
|---|---|---|
| 契约一致性 | `/admin/tenants` 系列 **四方不一致**修好（租户名空白/状态恒停用/点重载崩/灰度页恒 OFF） | `0a66e9b` |
| 契约门禁 | **R5**（3 端点 × 12 侧，**双向棘轮**：未登记 ⇒ FAIL；**修好忘删登记** ⇒ FAIL） | `15aaf7f` |
| mock 契约 | 12 处修复（含客户列表**恒 0 行**、灰度开关 key 错致**恒 OFF**）+ 5 个写 handler + **M1 最小集 4 条**（切断挂死） | `495d72a`…`e3c1701` |
| 产品模块 | 合并方案 + **17 步可执行计划** + P1 政策（本地无 Postgres 的实测结论、迁移号、回填政策、写权尺子、账本接回最小范围） | `e6ebc00`…`0d5d98b` |
| 工程陷阱 | `.gitignore:53` 裸 `data/` **静默吞掉** `frontend/src/mocks/data/` 新文件（实测探针证实）⇒ 加最小例外 | `9e9838b` |

### 两条已写进 `AGENTS.md` 的协作/测量纪律（本轮血泪）

1. **`git commit -- <pathspec>` 不足以保证"不提交别人的东西"**（它记录**工作树内容**，同文件别人的 hunk 会被带走；
   实测 `main.py` 两拨人 hunk 混在一起且依赖未跟踪文件 ⇒ 提交必炸）⇒ 改用**私有 `GIT_INDEX_FILE`**，
   并做提交前/后自检（**提交后必须确认别人的改动原样还在**）。
   ⚠️ 补充实测：**部分 hunk 提交要先转 LF**（工作树 CRLF vs index blob LF，130 个 CR ⇒ `patch does not apply`）。
2. **宣布任何通过/失败/归零前，必须打印完整不过滤摘要 + 算术核对**（曾用过滤视图得出**假的 "0 failed"**）；
   **"没匹配上" ≠ "没有"**（探针在 abort 时**不打日志**）；**不要用关键字 grep 当"某文案不存在"的证据**（曾错判 `events`/`kb`）。

### 待排期（均为发现，无 CI 会红）

1. `orchestrator/docs/openapi.json:6673-6734` 仍是旧形状 ⇒ 需重生成（**无新鲜度校验**）
2. **worker `POST /admin/feature_flag` 是请求体形状 ⇒ R5 只比响应键集，此缺陷无门禁覆盖**
3. 契约错位：`ExportProduct.params` 契约写**对象**、后端回**二维数组**；`pricing_key[].ui_unit/ui_scale` 用 zod `.default()`
   声明成输出必填、后端不产出（**类型撒谎、运行时 undefined**）
4. 前端真缺陷：`PATCH /customers/:id/stage` 的 409 二次确认门前端未实现 + **对象型 detail 崩 JSX**；`inquiries` 的 `channel` 枚举与前端自由文本不符
5. 另一条任务的**生产验收卡在 R2 密钥长度 13≠32**；`sampling_rate: 0.1` 非 bool

***

## 追加：**最终门禁全绿**（Lead 在工作区静止时跑）+ e2e/契约两条线收口

### 1. 全套门禁（HEAD `996453c`）

| 门禁 | 结果 |
|---|---|
| orchestrator `pytest -m unit` | **887 passed** / 1 skipped |
| worker `pytest` | **203 passed** |
| `python scripts/route-parity.py` | **PASS**（缺失已登记 / 未登记 0 / 过期 0） |
| `sync-shared.ps1 -Check` | **exit 0**（共享内核 30 / 报价引擎 19 / 枚举字典 1） |
| 前端 `typecheck` / `lint` | **exit 0** / 无 error |
| 前端 `test` | **29 files / 359 passed** |
| `contracts:check` | **PASS R5**（3 响应端点 + 1 请求体规则，15 侧，1 侧已登记） |
| **`NEXT_EXPORT=1 pnpm build`** | **exit 0（35/35 静态页）** |

> ⚠️ 第一次跑时 **worker 出现 2 failed** —— 当时另一条线正在改 `backend/worker/src/{main,dbjson}.py`
> 与 `tests/test_four_domains.py`（**改动时间距检查仅 20 秒**）。**按纪律先复查再认领**：
> 复跑 ⇒ **203 passed**，**2 条红确认为并发中间态** ✓
> （教训：并发会让门禁瞬态红 —— **先复查**，但**也不能拿它当借口**，必须复跑确认才能下结论。）

### 2. e2e 线：**没有待办了**

- 套件 **19 passed / 6 skipped / 0 failed = 25**（与 `--list` 一致 ✓）
- **13 处** `waitForLoadState('networkidle')` **全部**改为"等具体元素"（每条都有页面源码 file:line 依据）
  ⇒ `networkidle` 调用数 **13 → 0**；改动前后 `30 skip / 95 passed / 0 failed = 125 = 25×5` **完全相同**
  （⇒ 没有增删用例）；耗时 4.6m → 2.5m（**按观测陈述，不当因果证明**）
  - 复核更正：此处先前写"11 处"是**笔误**，逐项相加为 **13 处**（由执行者纠正）
  - **保留 5 处 `waitForTimeout`** 并逐条说明：它们是"点完 tab/行之后让 UI 落定"的**短固定等待**，
    不是"等数据"，也不属于 `networkidle` 这一件事；按"只改等待方式、不扩大范围"未动（若要收口建议单独一轮）
- 6 条 skip **各有出处**：3 条 quotations 既有、2 条 customers 判定陈旧、1 条 events 的 `error=500`
  **触发路径根本不存在**（`events/page.tsx` 不读 `?error=`，`useEvents()` 只把 filters 拼进 query）

### 3. 契约线：`openapi.json` 刷新 + R5.4

- `openapi.json` 从 **`git archive HEAD` 快照全量重生成**（**不含任何未提交内容** ✓，对 `app/**` 只读 ✓）
  ⇒ **79 → 171 paths、48 → 115 schemas** —— 旧产物**远不止 admin 段过期**（9 条已删路由还挂着、101 条缺失）
  ⇒ 说明"当时工作区不静止（`files.py` 刚被改）"，故**不走局部手改**也不走"把别人半成品固化进 schema"
- admin 段**按 JSON 键**（非子串）验证：`TenantItem=[tenant_id,display_name,is_active]`、
  `TenantReloadResponse=[reloaded_count,active_tenants]`、新增 `TenantReloadItem`，**无 `enabled`/`tenant_count`/`message`**
- **R5.4「请求体键集合」**门禁上线（三方比对：前端实发键 / 两端读取键 / 必需键；`K⊄S` 或 `K⊄B` ⇒ FAIL
  —— **历史 422 的形状**）；自证只用自己 `$TEMP` 副本（含棘轮另一半"过期登记判失败"）
- 遗留：本文件描述 **HEAD 的** API，`files/trade_docs` 合并后**需再 dump 一次**；**无 CI 新鲜度校验**

### 4. 一条工具口径的澄清（避免后来者被误导）

同一份文档曾被数出**四种行数**：`read` 工具 2031 / `git show | Measure-Object -Line` 1592 /
`Get-Content .Count` 1323 / **Python 读原始字节 2070**。复核：文件内 **0 个 `\r\n`、无 NUL、无超长行**，
而 `read` 工具与 Python 口径**一致**（2070/2134）⇒ **`Get-Content` 那个读数不可靠** ✗。
**教训：同一事实多个工具口径不一致时，先定"哪个工具跑在预期对象上"，再下结论。**

**（续五 · 2026-10-12）渲染指纹「对账端点」：C 方案从"存了"变成"能查"**

**1. 两端端点（逐字相同，只读）**
- orchestrator：`GET /api/v1/trade-docs/{doc_id}/render-fingerprint-check`
  （`backend/orchestrator/app/api/trade_docs.py:910`）；
- worker：同路径同语义（`backend/worker/src/ws_docs_ext.py:304`）；
- 判定**全在共享内核** `kaas_common/trade_doc/render_fingerprint.py::render_fingerprint_check`，
  端点只做"取单据 + 调装配 + 调内核"。
- **前提：走与 `POST /trade-docs/{id}/confirm` 同一套装配**（`get_trade_doc_render_data`）
  ＋ **同一个摘要函数** —— 否则比对没有意义（`trade_docs.py:928-929` 的注释即此口径）。

**2. 返回 11 个字段**（内核 `render_fingerprint.py:278-301`，就是两端响应契约）
`has_fingerprint` / `frozen` / `current_sha256` / `matches` / `render_version_frozen` /
`render_version_current` / `render_version_drift` / `reason` / `checked_at` /
`current_note` / `frozen_note`。

三个最该记住的：
- `matches`：**当且仅当**两边都有摘要且完全相等才 `true`（`:282-287`）；
- `reason`：`matched` / `version_drift` / `data_changed` / `no_fingerprint` /
  `frozen_unavailable` / `current_unavailable`（`:227-232`）—— **"模板改过"与"数据被改"分开报**；
- `render_version_drift`：渲染器/模板版本漂移（`:290`）。

**3. 保守语义（宁可比不了，也不给假结论）**
- 没有 `_render`（草稿 / C 方案之前的老单据）⇒ `has_fingerprint=false`、`reason=no_fingerprint`，
  其余字段如实给当前值，**不报错**；
- **现在装配失败** ⇒ `current_sha256=null` + `current_note`、`matches=false`
  （`current_unavailable`），**绝不返回"看起来匹配"的假结论**；
- 冻结时就没摘要 ⇒ `frozen_unavailable`，同样**不报 matched**；
- 单据不存在 ⇒ **404 `DOC_NOT_FOUND`**（`trade_docs.py:935-936`）。

**4. 五情形证据**（`backend/orchestrator/tests/test_trade_doc_render_fingerprint.py`）
- 匹配：`test_matched:300`；
- **不匹配：`test_data_changed_is_detected:324`** —— 这一例是**真的改了被纳入摘要的业务数据**
  （`total_amount` / `currency` / 买方抬头 / 行项，**4 个参数化用例** `:317-322`），**不是自证式断言**；
- 无指纹：`test_no_fingerprint_is_not_an_error:337`；
- 装配失败：`test_current_assembly_failure_never_reports_match:365`、
  `test_unusable_frozen_never_reports_match:356`；
- 版本漂移：`test_version_drift_is_reported_separately_from_data_change:378`；
- 契约字段固定：`test_response_contract_is_stable:398`。
worker 侧另有 `backend/worker/tests/test_ws_render_fingerprint_check.py`，
含"路由确已注册进 OpenAPI"的断言（`:206-207`）。

**5. 消费者：前端入口与批量（2026-10-12 更新）**
- ✅ **前端入口（task-19）**：单证预览区「**核对指纹**」按钮 —— **仅已签发单据显示**、**点了才查**
  （`useMutation`，预览时**不自动**拉）、按 `reason` 显示**一行结论**；`data_changed` **红字**
  「**签发后数据已被修改**」、`version_drift` 黄字、未知 `reason` 落"无法判定"（**不猜**）
  （`frontend/src/app/(app)/trade-docs/components/doc-preview.tsx:145-179,370-393`）。
- ✅ **批量对账（task-20）**：`GET /api/v1/trade-docs/render-fingerprint-checks/batch`（两端同契约；
  orchestrator `backend/orchestrator/app/api/trade_docs.py:979`、worker `backend/worker/src/ws_docs_ext.py:360`）
  —— 入参 `doc_ids`（逗号分隔，**去重后上限 50**，超限 ⇒ 400）；返回
  `{total, matched, data_changed, version_drift, no_fingerprint, unavailable, items}`，
  卡片 `{doc_id, doc_no, reason, matches, render_version_drift, error}`；
  **一张失败不拖垮整批**（该卡 `reason=unavailable` + `error`，其余照常）；
  **五桶之和恒等于 `total`**（不允许漏桶）。
- ⏳ **仍未做**：① **定时调度**（批量是**按需调用**，没有 cron）；② **列表页一眼标出"哪些被改过"**
  （结论要逐张点开或调批量接口才看得到）。

**6. 一条性质说明（不是 bug，但值得留档）**
对账的前提是"两边同一套装配"。若将来给 `render-data` 加了**新数据源**却忘了同步到**签发冻结**
那条路径，两边会**一起变**、`matches` 仍报 `true` —— 对账**发现不了**这种"新增字段没被纳入"的偏差。

**7. 口径提醒**：`matches=false` **不等于**"单据被篡改" —— 也可能是 `version_drift`（模板/渲染器改版）
或 `current_unavailable` / `frozen_unavailable`（现在或当时装配不出来）。**先看 `reason`，再下结论。**

> 来源标注：本节的行号、字段契约与语义均为**文档线读源码/测试**核对；
> **测试通过数**（orchestrator **946 passed / 1 skipped**、worker **217 passed**）来自
> **lead 与队友实测** —— 文档线本轮**未跑 pytest**。

***

## 追加（2026-10-12）：alembic「双 head」取证 —— 假警报 + 一个真问题（task-16）

**一句话结论**：`alembic heads` **只有一个**（`202610110018`），**没有双 head、不需要 merge 迁移**；
所谓"双 head"是 `artifacts/alembic_head.py` 的解析假阳性。但取证顺带实测出一个**真问题**：
**真·空白库跑 `alembic upgrade head` 会失败**（链在 `feb821f0b9c0` 就断）。
生产**不动**：版本行已是唯一 head，且 018 的 DDL 已生效（下面有形状级证据）。

> 本线**没有新建任何迁移文件**（`202610110018` 仍是最后一个）；没有改仓库里的迁移链；
> 没有连生产写任何东西（所有生产查询都在 `SET default_transaction_read_only = on` 会话里跑）。

### ① 权威事实：单 head、55 revision 单链

```
$ cd backend/orchestrator && python -m alembic heads
202610110018 (head)
```

用 AST 解析全部迁移文件（正确处理 `revision: str = …` 与 `revision = …` 两种写法）：

```
total migration files/revs = 55
HEADS = ['202610110018']
multi-parent (merge) revisions = none
parents not in files = []
```

链的形态（base → head，节选关键段）：

```
<base> 202605020001 → … → 20260921_leadgen_outreach → 20260922_research_workstation
        → 202609230001 → 202609230002 → 202609230004 → … → 202610110015
        → 202610110016 → 202610110017 → 202610110018 (head)
```

即：**情报链的 revision 就在主链中间**，不是并行分支。另附离线 SQL 佐证（`--sql`）：

```
$ alembic upgrade 202610110015:head --sql     # exit 0，3 个 revision
CREATE TABLE file_objects ( … )
ALTER TABLE file_objects ADD COLUMN is_primary BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE file_objects ADD COLUMN sort_order INTEGER DEFAULT 0 NOT NULL;
UPDATE alembic_version SET version_num='202610110018' WHERE …'202610110017';
```

### ② "双 head"从哪来：naive 解析脚本的假阳性（可复现）

```
$ python artifacts/alembic_head.py
migration 总数 = 52
head(s) = ['20260922_research_workstation', '202610110018']
```

根因（三处一起看）：

1. 该脚本的正则是 `^revision:\s*str\s*=\s*["']…`，**只认带类型注解**的写法；
2. 仓库里有 **3 个**文件写的是普通赋值 `revision = "…"`，被它**整体 `continue` 跳过**：
   `202609230001_drop_conversation_tables.py`、`202609230002_drop_wechat_tables.py`、
   `202609230004_merge_customers.py`（52 + 3 = 55 对得上）；
3. 被跳过的 `202609230001` 正是**把情报链挂回主链**的那一环（`down_revision = "20260922_research_workstation"`）
   ⇒ 脚本从来没把 `20260922_research_workstation` 记进 `downs`，于是把它当成 head 打了出来。

**教训**：`alembic heads` 要用 **alembic 自己**的输出；自己写正则解析 revision 图时，
漏一种声明写法就会得出"双 head"这种看起来很像真的结论。

### ③ 处方 merge 会怎样：凭空造出 branchpoint（临时副本实测，未落仓库）

按任务卡原方案（`down_revision = ("20260922_research_workstation", "202610110018")`，upgrade/downgrade 空操作）
在 `%TEMP%` 的**副本**里试（仓库文件一行未动）：

```
$ alembic -c <temp>/alembic.ini heads
202610120001 (head)                     # alembic 接受，不报错
$ alembic -c <temp>/alembic.ini branches
20260922_research_workstation (branchpoint)
                              -> 202610120001 (head) (mergepoint)
                              -> 202609230001
```

⇒ 它**不会**让图更干净，反而在一条**本来线性**的链上**虚构一个 branchpoint**
（`20260922` 真实只有一个子节点 `202609230001`），从此 `alembic history/branches/downgrade` 都要
解释一个不存在的分支。**结论：不加这个 merge。**

### ④ 真问题：真·空白库 `alembic upgrade head` **失败**（实测）

用一个临时 PostgreSQL 集群（`pgserver`，数据目录在 `%TEMP%`）+ 一个**全新空库**，
用仓库真实的 `alembic/` 跑 `upgrade(head)`：

```
[2] 运行 alembic upgrade head（空库）…
sqlalchemy.exc.ProgrammingError: (psycopg.errors.UndefinedTable) relation "quotations" does not exist
[SQL: ALTER TABLE quotations ADD COLUMN tenant_id TEXT]
[3] alembic_version = None
[3] 空库升级后 public 表数 = 0        # 整条链一个事务，报错即全部回滚
```

定位：

- 失败点 = `feb821f0b9c0_add_tenant_id_to_quotations_and_.py:61`
  （`op.add_column('quotations', sa.Column('tenant_id', …))`，**无兜底**）；
- `quotations` 在整个链上**只在更晚的** `f82ac951b473_intel_workstation_v1.py:661`
  才 `op.create_table('quotations', …)`（链序：`feb821f0b9c0` → `202605170001` → `202605220001` → `f82ac951b473`）；
- 真实库能跑，是因为 `quotations` 早由 `Base.metadata.create_all()` 建好了 ——
  这一点该文件**自己写了注释**（`:22-28`：旧版本靠 create_all 建表，空库必然报 `relation does not exist`，
  所以补了"按 ORM 模型建表"的兜底）—— **但兜底只给了 `customer_capabilities`，`quotations` 漏了**。
- 同一个文件也是 `--sql` 离线全链生成的第一道墙（`sa.inspect(MockConnection)` 在离线 mock 上不可用）；
  后面的数据迁移还会撞 `No literal value renderer … "['lianjia@kaas.local']"`（ARRAY 字面量）。
  ⇒ **"空库 `--sql` 一把生成"在本仓库现状下本来就做不到**，与 head 数量无关。

**性质**：这是 create_all 时代的设计遗留，**不是**本任务引入的，也**不影响生产**（生产 schema 早已存在）。
但"新环境/CI/异地重建 → `alembic upgrade head`"这条路**当前是断的**，值得单独排期。

### ⑤ 生产现状（只读取证 · 2026-10-12 · 会话级 read-only）

DSN 用 `neon env pull --file <temp> --project-id falling-salad-31662168` 重取
（branch **production** `br-raspy-snow-b5bp9zoh`；**全程未打印口令**），
所有查询在 `SET default_transaction_read_only = on` 下执行。

| 事实 | 实测 |
|---|---|
| `alembic_version` 行数 / 值 | **1 行** / `'202610110018'`（len 12；唯一列 `version_num`） |
| 其它 version/migration 表 | 无（只有 `alembic_version`） |
| 018 是否生效 | **是**：`file_objects.sort_order` = `integer, NOT NULL, default 0`（正是 018 的 DDL） |
| 017 指纹 | `file_objects.is_primary` = `boolean, NOT NULL, default false` |
| `file_objects` | 23 列 / 6 索引（`uq_file_current`、`uq_file_primary` 都在）/ **0 行** |
| 情报链表 | `research_products` 存在（**0 行**，30 列与 `20260922` 迁移定义**逐列一致**，4 个索引/约束齐全）、`research_runs` 存在（**5 行**）、`lead_candidates.crawl_status/product_image_url/spec_normalized` 都在 |
| 遗留表（链上"应已删"却还在） | `conversations`、`conversation_messages`（`202609230001` 删）、`wechat_bot_accounts`、`wechat_conversations`、`wechat_message_events`（`202609230002` 删）、`cust_customers`（`202609230004` 删）**都存在** |
| 链上"应已建"却没有 | `feature_flags`、`feature_flag_audit`（`202609230005`） |

**"单行 version 却有情报链表"的矛盾解释（正面回答）**：
`20260922_research_workstation` 是 `202610110018` 的**祖先**（① 的单链)，alembic 在**单 head** 下
`alembic_version` 只维护**一行**。所以"一行 version + 情报链表存在"**完全自洽**：
走到 018 必然经过情报链那一环。**不存在"历史上走过别的路径建表"这回事。**

**但**⑤ 表格最后两行是**另一件独立事实**（与 head 无关，别混为一谈）：
生产的 schema 并不是迁移链的忠实产物 —— 该删的没删、`202609230005` 的表没有。
这与项目自己的注释一致（真实库由 `create_all` 建、alembic 后接入：
`feb821f0b9c0:22-25`、`202609250001:31`）⇒ **生产 `alembic_version` 是"标签"，不是 schema 证书**。
这一条只做记录，**本次不动**。

### ⑥ 生产该怎么走（建议；由 lead 执行，本线未碰生产）

1. **不要加、也不要跑 merge 迁移** —— 没有第二个 head（①）；加了只会虚构 branchpoint（③）。
2. **生产不需要任何迁移动作**（时点 2026-10-12；**2026-10-17 已升到 `202610170004`**，见顶部交接）——
   当时版本行 = 唯一 head `202610110018`，018 的列已在（⑤）。
   想亲眼复核（**只读**）：
   ```bash
   cd backend/orchestrator
   DATABASE_URL=<生产 direct DSN> python -m alembic current     # 期望：202610170004 (head)
   ```
   万一将来发现版本行 < head：`DATABASE_URL=<生产 direct DSN> python -m alembic upgrade head`
   （018 的 DDL 是 `ADD COLUMN … DEFAULT 0`，PG11+ 不重写表；`file_objects` 生产 **0 行**，风险极低）。
3. **新环境（CI / 新同事 / 异地重建）现在不能直接 `alembic upgrade head`**（④ 实测断在 `feb821f0b9c0`）。
   在修好之前，事实上的流程仍是"先 `create_all` → `alembic stamp head`"；
   若要修（**建议单独排期，本线未做**）：把 `feb821f0b9c0` 那处兜底从 `customer_capabilities`
   扩到 `quotations`（照抄它自己的写法、排除马上要加的 `tenant_id`），并**逐个排查其它 create_all-only 表**
   （工作量未评估：每修一处就要在真空库上重跑到下一处）。
4. **schema 漂移（legacy 表 / 缺 `feature_flags`）也单独排期**：
   用 `alembic check` 或 `pg_dump --schema-only` 与参考库（空库 + create_all）对比后再定动作。
   **不要**拿 merge 迁移当清理工具。

### ⑦ 复现方式（脚本都在 gitignored 的 `artifacts/`，不提交）

| 脚本 | 作用 |
|---|---|
| `artifacts/task16_prod_evidence.py <dsn_file>` | 只读：版本行 / 情报链表列与索引 / 尾部指纹 / relkind |
| `artifacts/task16_prod_tables.py <dsn_file> <out.txt>` | 只读：`pg_class.relkind` 精确判定 + public 全量关系清单 |
| `artifacts/task16_graph_analysis.py <relations.txt>` | 纯本地：按**链序**推导"到 head 应有的对象集合"，与生产差集 |
| `artifacts/task16_prod_head_check.py <dsn_file>` | 只读：head 值精确比对 + `file_objects` 列形状/索引 |
| `artifacts/task16_fresh_db_check.py` | **真·空白库**跑 `alembic upgrade head`（临时 `pgserver` 集群，数据目录在 `%TEMP%`；需先 `python -m venv %TEMP%\kaas-t16-pg && pip install pgserver`） |

- 空库实测两次结果一致：`relation "quotations" does not exist` / `ALTER TABLE quotations ADD COLUMN tenant_id TEXT`，
  `alembic_version` 不存在、public 表数 0（整链一个事务回滚）。
- 取生产 DSN：`neon env pull --file <temp> --project-id falling-salad-31662168`
  → `artifacts/dsn_unpooled.py <env> <dsn_out>`（只落盘、**不打印口令**）。
- 一条测量纪律的复现：本线写入前**同一时刻**实测 `Get-Content … | Measure-Object -Line` 得 **1433**、
  `read` 工具得 **2245**（本文档随后又被本线追加了本节，两个数都会变）
  —— 与上文 §4「同一份文档四种行数」一致：**行数类证据必须说清是"哪个工具、哪一刻"**。

### ⑧ 处置结果：第一个断点已修，整链仍跑不到 head（task-18，2026-10-12）

**改动（只这一处）**：`feb821f0b9c0_add_tenant_id_to_quotations_and_.py` —— 把 `quotations` 那段
（`ADD COLUMN tenant_id` → 两条 backfill `UPDATE` → `SET NOT NULL` → 两个索引）包进
`if sa.inspect(bind).has_table("quotations"):`（补丁后该 guard 在 `:74`，`ADD COLUMN` 在 `:75`）。
**只兜 `upgrade`**；其余语义、依赖顺序、其它迁移一律未动。

**为什么是"跳过"而不是像 `customer_capabilities` 那样"按 ORM 模型补建"**：链上更晚的
`f82ac951b473_intel_workstation_v1.py:661-688` 才 `create_table('quotations')`，而那份定义**本身已带
`tenant_id NOT NULL` 和同名的两个索引**（`idx_quotations_tenant` / `ix_quotations_tenant_id`）。
在这里先建表 ⇒ 必与那次 `CREATE TABLE` 撞 `already exists`；空库上"跳过"**不丢语义**。

**实测（临时 pgserver 集群 + 全新空库；用完全部清理，0 残留）**

| 阶段 | 结果 |
|---|---|
| 补丁前（task-16） | 断在 `feb821f0b9c0`：`relation "quotations" does not exist`（3 次一致） |
| 补丁后 | **穿过 `feb821f0b9c0`** —— SQL 捕获里出现 `UPDATE alembic_version SET version_num='feb821f0b9c0'`，随后进入 `feb821f0b9c0 -> 202605170001` |
| 紧接着的**环境级**拦路 | `202605170001:24` 的 `CREATE EXTENSION IF NOT EXISTS pg_trgm` → `extension "pg_trgm" is not available`：本地打包的 pgserver **不含 contrib**（`share/postgresql/extension` 只有 `plpgsql` / `vector`） |
| 在**探针副本**里中性化这两条扩展后 | 撞上 `btree_gist` 的**真依赖对象**：`ALTER TABLE product_sku_prices ADD CONSTRAINT excl_psp_overlap EXCLUDE USING gist (…)` ⇒ `btree_gist` 是硬前提，不是多余一句 |
| 再把该约束也中性化后 | **下一个 repo 级断点**：`202605170001_spec_system_v1.py:279` `ALTER TABLE quotations ADD COLUMN sku_id BIGINT` → `relation "quotations" does not exist`（与第一个断点**同类根因**） |

**明确结论**：整链**仍跑不到 head**。第一个断点已按最小改动修掉并实测穿过；下一个是
`202605170001:279`（同一个 create_all-only 表的同类问题）——**该处已在 task-21 修掉，见 §⑨**。
修完整条链要牵涉 ≥2 个历史迁移、
并先理清"哪些表只由 `create_all` 建、链上第一次 ALTER 它出现在哪"——**属单独决策**（本任务明确不要求一次修完）。
另：空库路径还有**环境前提** —— 链要求 contrib 扩展 `pg_trgm` + `btree_gist`（后者被 `excl_psp_overlap`
真正用到）；Neon / 常规 Postgres 一般都有，但"裸装无 contrib"的 Postgres 会在 `202605170001` 断。

**"已有库行为不变"的实测论证（A/B，不是推理）**：两个同构 fixture 库（各放最小 `customers` + `quotations`），
分别用**未打补丁的迁移副本**与**仓库打完补丁的迁移**跑 `stamp 82e2cd95a9dd` → `upgrade feb821f0b9c0`，
用 SQLAlchemy 事件逐条抓**实际执行的 SQL**：

- 剔除只读 catalog 查询后，**DDL/DML 序列逐条相同**（pre 17 条 / post 18 条，差的 1 条就是 `has_table`
  的 introspection `SELECT`）；
- 结果 schema 相同（列 + 索引）；
- 阳性对照：两次都**确实执行**了 `ALTER TABLE quotations ADD COLUMN tenant_id TEXT` ⇒ 表在时条件为真、走原路径。

源码层面同理：`has_table` 为真 ⇒ 括号内语句与改动前逐字相同。

**生产影响 = 无**：生产 `quotations` 存在（§⑤ 已证 `alembic_version` = 唯一 head、018 已生效）⇒ 条件为真 ⇒
行为与改动前一致；本改动只在"表不存在"（空库）时才改变行为。

**复现**：`artifacts/task16_fresh_db_check.py`（空库整链；`ALEMBIC_INI` 可指向探针副本）、
`artifacts/task18_ab_existing_db.py`（A/B 行为对照）。

### ⑨ 继续修同类断点：第二个断点已修；边界 = `f82ac951b473` 的整库 dump（task-21，2026-10-12）

**改动 2（`202605170001_spec_system_v1.py`，`# ── 13. quotations ALTER ──` 那段）**：把 `quotations` 的
三条 `op.add_column`（`sku_id` / `price_id` / `schema_version_v2`）+ `op.create_index('idx_q_sku', …)`
包进 `if sa.inspect(op.get_bind()).has_table("quotations"):`。理由：更晚的
`f82ac951b473_intel_workstation_v1.py:661` 才 `create_table('quotations')`，而那份定义**已含这三列**
⇒ 空库上跳过不丢列语义。
**已知缺口（如实记）**：`idx_q_sku` **不在**那份 CREATE TABLE 的索引里 ⇒ **空库上这个索引会缺** ——
这是"链跑到 head ≠ 得到完整 schema"的第一个具体实例，也是后面主张"别再用跳过守卫堆下去"的依据。

**空库实测（临时 pgserver；环境依赖只在探针副本里中性化）**

| 阶段 | 结果 |
|---|---|
| task-18 之后 | 穿过 `feb821f0b9c0`，断在 `202605170001:279` |
| **改动 2 之后** | **穿过 `202605170001`** —— SQL 捕获见 `UPDATE alembic_version SET version_num='202605220001'`（该 revision 正常收尾），随后穿过 `202605220001` |
| 新断点 | `f82ac951b473_intel_workstation_v1.py:23` `op.create_table('customer_capabilities', …)` → **`psycopg.errors.DuplicateTable: relation "customer_capabilities" already exists`**（同一轮 SQL 捕获：#89 是 `feb821f0b9c0` 空库兜底建的表，#171 这里**又建一次**） |

**为什么这一处要停下（性质 = 结构性冲突，不是"同类守卫"）**

- 静态量化（`artifacts/task21_conflict_scan.py`，纯本地）：`f82ac951b473` **无条件 `create_table` 36 张**，
  其中 **30 张在链上更早的 revision 里已经建过**（`customers`、`users`、`conversations`、
  `wechat_bot_accounts`、`wechat_conversations`、`wechat_message_events`、`conversation_messages`、
  `channel_links`、`usage_events`、`user_customers`、`user_roles`、`product_categories`、
  `spec_attributes`、`spec_attribute_values`、`category_attribute_bindings`、`attribute_proposals`、
  `product_skus`、`product_sku_prices`、`product_sku_revisions`、`units`、`unit_groups`、`price_units`、
  `industry_templates`、`product_specs`、`text_knowledge`、`customer_*` …）。
- ⇒ 它在**任何**真实链路上**必然** `DuplicateTable`；这同时**反证**"这条链从未通过 alembic 跑到过 head"，
  与 §⑤「生产是 `create_all` + 版本标签」的结论**互相印证**。
- 要让它过，只能把这一次 revision 的**全部 36 处 `create_table` 改成"缺则建"**，并决定那 30 张表的
  **定义以谁为准**（更早的迁移 vs 这份 dump）—— 那是"改历史迁移语义 + 定 schema 真源"的**设计决策**，
  超出"最小守卫"的范畴 ⇒ 按本轮规则**停止硬修**。
- 顺带澄清一个**假阳性**（免得后来者误判）：`202605030002` 看着也"重复建 `events`/`events_archive_log`"，
  但它先 `DROP TABLE IF EXISTS events CASCADE`、另一张是 `CREATE TABLE IF NOT EXISTS` ⇒ 不是冲突
  （空库实测也确实穿过了它）。

**改动 2 的 A/B（"已有库"= `quotations` 表在）**：两个同构 fixture 库各**只预建** `quotations`
（**不**预建 `customers` —— 链自己在 `202605050001` 会建它，预建会先撞 `DuplicateTable`）；
`pre` 用还原成未打补丁的副本、`post` 用仓库当前版本，各跑**整链**到同一个断点：

- 语句 183 vs 184 条（差的 1 条 = `has_table` 的 introspection `SELECT`）；
  **剔除只读 catalog 查询后的 DDL/DML 序列逐条相同（174 = 174）**；
- **阳性对照**：两边都执行了 `sku_id` / `price_id` / `schema_version_v2` 三条 `ADD COLUMN`
  + `CREATE INDEX idx_q_sku`（= 守卫为真、走原路径）；
- 两次都在同一处（`f82ac951b473`）以**同一个错误**结束 ⇒ 差异与本次守卫无关。
（`feb821f0b9c0` 那处的真实 fixture A/B 见 §⑧。）

**环境依赖（不变）**：链要求 contrib `pg_trgm` + `btree_gist`（后者被 `excl_psp_overlap` 排他约束真正用到）；
本地打包的 pgserver 无 contrib ⇒ 只在**探针副本**里中性化 5 处语句，仓库迁移文件不为环境改语义。

**最终结论**：**仍跑不到 head**，边界 = `f82ac951b473`（**结构性**，非"表不存在 ⇒ 跳过"这类守卫可解）。
已修 2 处同类守卫（`feb821f0b9c0`、`202605170001`），两处都实测穿过、且 A/B 证明存量库行为不变。

**建议（单独排期，本线不做）**：若目标真是"空库 → 可用 schema"，正确做法是
**新增一个 bootstrap 迁移**（按 ORM 元数据把 create_all-only 的表补齐）+ 把 `f82ac951b473` 的
`create_table` 全部改成"缺则建"，并明确那 30 张表的定义真源；**不要再往历史迁移里逐个加跳过守卫**
（会把 schema 缺口越堆越多，例如 `idx_q_sku`）。

**复现**：`artifacts/task21_probe_build.py`（探针副本 + 环境中性化）、
`artifacts/task16_fresh_db_check.py`（空库整链，`ALEMBIC_INI` 指向探针）、
`artifacts/task21_ab_quotations.py`（改动 2 的 A/B）、
`artifacts/task21_conflict_scan.py`（重复建表量化）。

***

## 智能体团队收口（2026-10-12）—— **详细版另见，本节只放结论与入口**

> 本轮（用户指示"创建智能体团队提高效率"之后）**18 项任务**的完整收口见
> **`docs/archive/2026-10-20-closeout/SESSION_CLOSEOUT_2026-10-12.md`**（含设计要点、自证证据、专用文档索引）。
> 之所以另立：本文档当时**多写者**（另一条线在持续追加），为它连写两次补丁一败一成，
> 第三次读到尾部后又被追加 ⇒ 锚点移位。**按"不硬抢多写者文件"原则独立成文**，内容自洽。

**最终整套门禁（HEAD `6e8a04a`，Lead 在"无 e2e 在跑"时做的 build）**：
orchestrator **946** / worker **217** / `route-parity` **PASS** / `sync-shared -Check` **exit 0**（30/20/1）/
前端 `typecheck` **exit 0** / 前端 `test` **363** / `contracts:check` **PASS R0–R6** /
`NEXT_EXPORT=1 build` **exit 0（35/35 静态页）**。
⚠️ **该遍漏跑 `lint`**（命令漏写）—— 上次它是 exit 0，且此后只改了 `openapi.json`/`contracts-allowlist.txt`；
**但不把它算进"该轮验证通过"**。

**本轮新增的两道门禁（均双向棘轮）**：
- **R5.4**：`POST /admin/feature_flag` 的**请求体键集合**（前端实发 / 两端读取 / 必需键 ⇒
  `K⊄S` 或 `K⊄B` 即 FAIL —— 历史"点灰度开关 422"的形状）
- **R6**：`openapi.json` **新鲜度**（路径集合 / 方法集合 / `response_model`→`$ref` / 模型字段键集合；
  **基准两侧都取 HEAD** ⇒ 无环境依赖、CI 可跑）。上线即抓到 1 条真实陈旧并**已还清**：
  paths **171 → 172**（只新增、无删除、schemas 零变化）⇒ **R6 现 0 偏差**

**产品模块**：8 条裁决**全部闭环**（含 **Q6 的两层：工位人人可见，但用户创建的业务数据仅团队内可见**）；
`IMPL_PLAN` §8 已标"已裁决"并新增 **§8.1「哪一步随之改变」**；**首个可验证增量 `spec_delta.py`**
（528 行、**纯标准库**、42 条测试）已交付。

**尚未完成三项**（各有归属，非"未做"）：依赖漏洞（**已排期**）/
产品模块后续（**依赖数据库，但 `alembic --sql` 可离线验证 ⇒ 按增量继续**）/ 单证投产联调（**卡在生产 R2 密钥**）。

***

## ⚠️ 迁移线通告（2026-10-12，给正在定位 alembic 空库断点的同事）

> **（2026-10-17 更新：当前 head 是 `202610170004`）**
> 本节写于 2026-10-12，当时 head 从 `202610110018` 变为 `202610110019`（产品域团队隔离迁移）。
> 之后又新增 `202610120001`（password_reset_tokens）与 `202610170001`–`202610170004`，**单链**；
> 生产已于 2026-10-17 执行到 `202610170004`（见顶部交接）。
>
> 1. `alembic upgrade head --sql` 的终点**以 `alembic heads` 为准**（现为 `202610170004`）；
> 2. **不要硬编码 `down_revision`**：新建迁移前先跑
>    `cd backend/orchestrator && .venv/Scripts/python -m alembic heads`，把输出的**当前唯一 head**
>    写进 `down_revision`；写旧值会直接造出**双 head**，所有人的 `alembic upgrade head` 都会失败
>    （本项目为"双 head"取过一次证：`234a43c` 是假警报）。
> 3. 该迁移**只做了可安全做的部分**（详见下），**没有碰** `files.py` / `backend/worker/src/**`。
>
> 复核方式：`cd backend/orchestrator && .venv/Scripts/python -m alembic heads` ⇒ 现在应输出
> **一行** `202610170004 (head)`；`alembic branches` ⇒ 空（线性、无分叉）。

## 产品模块：P11 + P5/P6 已落地（**按增量推进，每条都能离线证明**）

### P11 共享内核「两把尺 + 三层可见性」（`8f3e615`）

- **Q1=B 三层**：定义人人可读 / 产品**相关信息一律团队私有（系统级不是例外）** / 历史 `team_id IS NULL` **仅管理员可见**
  —— 用**结构断言**钉住（签名里不许出现 `is_system`）
- **Q5 两把尺并存**：`is_same_team` 与 `is_team_admin` 并存，**名字不叫 `can_write`**（被客户域属主尺占用）；
  四类**仍须管理员**的端点（团队档位 / 团队·成员·订阅 / `is_system` 行 / `calculate-internal`·`verify`）写在 docstring
- **Q6 两层不压平**：该模块**只管数据可见性**，**不提供任何工位可见性函数或参数**（结构断言），工位那层属 **P15 契约**

### P5/P6 迁移 `202610110019`（`4ce9992`）—— **离线双证**

- `alembic upgrade 018:019 --sql` **exit 0**：3 张表加 `team_id BIGINT`（**可空**）+ FK→`teams`(`ON DELETE SET NULL`) + 索引；
  `uq_tenant_products_key` 与 `uq_file_primary` 均改为 **`(tenant_id, COALESCE(team_id, 0), …)`**（部分索引条件原样保留）
- `alembic downgrade 019:018 --sql` **exit 0**（**回滚不通的迁移等于没有回滚**）；
  `heads` = 单 `019`、`branches` = 空；**13 条 DB-free 迁移测试**（真跑、带 `pytestmark`）；
  `pytest -m unit` ⇒ **989 passed / 1 skipped / 324 deselected / exit 0**

**两个设计决定（有意为之，有用例双向钉住）**：
1. **`team_id` 不做 `NOT NULL`** —— 裁决是"**新写入强制 + 历史容忍 NULL**"，两者同时成立**只能靠写路径**强制
   （P7/P9 + 403 `NO_TEAM`）；库上 `NOT NULL` 会让历史行违反约束，或**被迫给历史行编一个 team**（D3/D4 不允许）
2. **唯一键用 `COALESCE(team_id, 0)` 而非裸列** —— Postgres 认为 **NULL 互不相等** ⇒ 裸列进唯一键会让同租户
   **出现多行无归属**；折叠成 0 才能表达"至多一行无归属" ⇒ 这才是"唯一键要容纳历史 NULL"的正确形态

### 明确留白（**不是"忘做"，是被禁碰文件卡住，附证据**）

改唯一键**必须同批**改调用方的 `ON CONFLICT`，否则那条 INSERT 报
`no unique or exclusion constraint matching the ON CONFLICT specification`：

| 留白项 | 被谁锁住 |
|---|---|
| `product_profiles` 主键 + `put_profile` 的 `ON CONFLICT` | `app/api/files.py:283`（**另一条任务正在改**）+ `backend/worker/src/ws_files.py:319`（禁碰） |
| `uq_tenant_ws_product` + worker 的 `ON CONFLICT` 与断言 | `backend/worker/src/ws_products.py:347` + `tests/test_ws_products_seals.py:149`（断言该字面量） |

⇒ 这两项**必须与两端代码同批**（P9 必做清单已写进 `archive/2026-10-20-closeout/PRODUCT_MODULE_IMPL_PLAN.md` §8.4）。
**如实记录的后果：P9 之前，两个团队仍不能各自持有同一 `product_key` 的基础信息**（Q1=B 还差这一步）。
（可安全改的两处已改：`uq_tenant_products_key` **无** `ON CONFLICT` 依赖 —— worker 用普通 INSERT + 捕获 `"duplicate key"` ⇒ 409 语义不变；
`uq_file_primary` 亦无依赖，主图靠 UPDATE 维护。）

**给 P13 的硬提醒**：`TenantProductLoader._fetch_tenant_product` 用 `scalar_one_or_none()` 且**不按团队过滤**
（`app/services/.../tenant_products.py:87-98`）⇒ 本轮放宽唯一键后，同租户同 key 的多团队行会让它抛 `MultipleResultsFound`
⇒ **接线前必须先补 team 过滤**（它现在无调用者 ⇒ 此刻无影响）。

***

## ⭐ 跨设备交接指引（2026-10-12 10:38）

> **在别的设备继续前，先读 [`docs/SESSION_CLOSEOUT_2026-10-12.md`](archive/2026-10-20-closeout/SESSION_CLOSEOUT_2026-10-12.md) 的
> 「跨设备交接记录」一节** —— 里面有：
>
> 1. ~~⚠️ 6 个文件的未提交改动不会转移~~ → 【10:44 更正：经 `git diff HEAD` 逐文件核实，
>    6 个工作树均 == HEAD，是**共享 index 滞留幻影**（规则 4 现象），归位后工作区已干净，
>    **跨设备无任何丢失**】；
> 2. 阻塞清单全部解除（`ws_docs_ext.py` / `trade_docs.py` 已释放；`main.py` / `dbjson.py` /
>    `products/page.tsx` 的"占用"经核实同为幻影）—— **`resolve_photo_refs` / `:3691` / `:829` /
>    可视化编辑器前端均已解封**；
> 3. 下一件该做的事（先补跑全套门禁 ⇒ `trade_docs.py:829` 谓词 ⇒ §8.5 / 编辑器接线）。
>
> 交接时 HEAD = `ff733f2`，**已核实与远程同步（领先/落后 = 0/0）** ✓

***

## （前端主线）P14 产品工位合并 · task-7 步1（2026-10-12）

> 由 fe-main 执行，按「每步一个小任务、一个提交」纪律推进。本节只记录**步1 已完成**，
> 步2（测试网补全）另起一节追加。

### 步1 做了什么

把 `/products`（产品素材：图片 + 基础信息）与 `/settings/tenant-products`（产品定义管理：
规格 JSONB）两页的内容搬进**一个工位两个 tab**，**不加任何新功能**：

- 新 `frontend/src/app/(app)/products/page.tsx` = tab 容器（`图片与基础信息` / `定义`），
  参照 `quotes/page.tsx` 的 `?tab=` 深链约定（默认 tab 不带参数）。
- 新 `frontend/src/app/(app)/products/tabs/products-media-tab.tsx` = 原 `/products` 页面主体
  逐字搬入（列表、选中、基础信息表单、上传/命名/分类/排序/主图/下线/直链）。
- 新 `frontend/src/app/(app)/products/tabs/products-definitions-tab.tsx` = 原
  `/settings/tenant-products/page.tsx` 主体逐字搬入（列表 + 表单编辑 + 新增/编辑/删除）。
- `frontend/src/app/(app)/settings/tenant-products/page.tsx` 改为**客户端 redirect**，
  送到 `/products?tab=definitions`（不删路由、不改契约）。

### 三条硬约束的落实

1. **不按 Axis 设计产品编辑器** ✓ —— JSON 文本框原样保留（`specJson` state +
   `JSON.parse(specJson || "{}")` 写入路径 + `<textarea value={specJson} rows={10}>` 全部
   逐字未动），新建时初始 JSON `{"key":"","name":"","axes":[],"variants":[]}` 也原样保留
   （含空 axes —— 搬家前的真实行为，P14 不做修正，留给 P16）。
2. **可见性两层不压平** ✓ —— 前端不加任何 `RouteGuard` / `adminOnly` 分支；工位可见性
   `adminOnly` 属 **P15 契约层**（`shared/contracts/workstations.ts` 里 `products` 与
   `tenant-products` 两条工位登记本步不动），数据可见性属后端团队过滤。
3. **旧路由书签不许 404** ✓ —— `/products`（本页）与 `/settings/tenant-products`
   （客户端 redirect）都保留可访问。redirect 用 `useRouter().replace` 而非
   `next.config.mjs` 的 `redirects()`，因为部署形态是**静态导出**
   （`NEXT_EXPORT=1` 时 `output: "export"`），Next 的 `redirects()` 在静态导出下不生效。

### tab 切换保留状态（顺带的行为说明）

两个 tab 内容都**始终挂载**（`hidden` 切换而非条件渲染）⇒ 切走再切回来，选中产品 /
编辑中的表单 / JSON 文本框内容都还在。搬家前两个独立页面各自保留本地 state（走浏览器
导航切换时 state 会丢），现在改成 tab 后**保留状态是改善**，不算违反"行为等价"。

### 门禁数字（2026-10-12 11:42，工作区静止时实测）

| 门禁 | 结果 |
|---|---|
| `typecheck`（`tsc --noEmit`） | **2 errors**，均在 `onboarding/page.tsx`（`:55` / `:80`），**已知历史遗留**（typedRoutes 把 `"/quotes?tab=…"` 字符串当非法 Route），按指令**如实报但不修**；本步新增/改动文件 **0 errors** |
| `lint`（`next lint`） | **exit 0**，8 warnings（其中 1 条在本步新建的 `products-media-tab.tsx:89` `react-hooks/exhaustive-deps`，系原 `/products` 页面同款写法逐字搬入，非本步引入的新问题） |
| `test`（`vitest run`） | **29 files / 373 tests passed**（exit 0） |

（构建验证由 Lead 统一跑，本步未触碰 `frontend/.next`。）

***

## （前端主线）P14 产品工位合并 · task-8 步2（2026-10-12）

> 紧接 task-7 步1。本步补前端测试网（`MERGE_PLAN §8` 列出的「products 无测试网」缺口），
> 不改任何产品代码（步1 已收口，本步纯加测试）。

### 步2 做了什么

在 `frontend/src/app/(app)/products/__tests__/` 下新建两份测试（**只新建自己的测试**，
不动既有 `lib/products/__tests__/use-products.test.ts`）：

| 文件 | 覆盖 | tests |
|---|---|---|
| `products-tabs-state.test.tsx` | ① tab 切换保留状态（两个 tab 都始终挂载、`hidden` 切换 ⇒ 切走再切回输入框内容还在）<br>② `?tab=definitions` 深链落到「定义」tab<br>③ `?tab=media` / 不带 `?tab=` 落到「图片与基础信息」tab（默认） | 3 |
| `products-redirect-and-definitions.test.tsx` | ④ 旧路由 `/settings/tenant-products` redirect 目标 = `/products?tab=definitions`（不是默认 media）<br>⑤ 定义 tab 读 `GET /tenant-products`（不读 `/products`）<br>⑥ 定义表单保存 → `PUT /tenant-products/{id}`，body 带 `spec`（`JSON.parse` 后，不是字符串）<br>⑦ 新增产品 → `POST /tenant-products`（不带 id），body 带 `spec`，初始 JSON 含 `"axes": []`（搬家前原样）<br>⑧ 删除 → `DELETE /tenant-products/{id}`（非 `is_system` 行）<br>⑨ `is_system` 行不渲染「编辑/删除」按钮（与搬家前一致） | 6 |

**范围说明**：产品列表/基础信息那侧的读写契约（`/products`、`PUT /products/{key}/profile`、
上传/排序/主图/下线）已由 `frontend/src/lib/products/__tests__/use-products.test.ts`
（13 tests）钉住；搬家**未改 `lib/products/use-products.ts` 一行** ⇒ 该文件的断言继续成立，
本步不重复。

**测试设计的两个坑（写进测试文件注释）**：
1. `vi.mock` 是 hoisted 全局的，做不到"同一模块某些用例用真身、某些用桩"
   ⇒ 拆成两份文件（tab 桩观察 state 保留 + 真组件观察读写契约）。
2. `lib/products/use-products.ts` 用 default 导入、`products-definitions-tab.tsx`
   用 named `apiClient` 导入 ⇒ mock 必须同时灌 default 与 named 两份，断言也要两边都查，
   否则会漏掉一半请求（实测漏掉 named 侧 ⇒ `expected [] to include '/tenant-products'`）。

### 门禁数字（2026-10-12 11:55，工作区静止时实测）

| 门禁 | 结果 |
|---|---|
| `typecheck`（`tsc --noEmit`） | **2 errors**，均在 `onboarding/page.tsx`（`:55` / `:80`），**已知历史遗留**（typedRoutes 把 `"/quotes?tab=…"` 字符串当非法 Route），按指令**如实报但不修**；本步新增测试文件 **0 errors** |
| `lint`（`next lint`） | **exit 0**，8 warnings（与步1 相同，均为历史遗留的 `react-hooks/exhaustive-deps` / `no-img-element`，本步新增测试文件 0 warnings） |
| `test`（`vitest run`） | **31 files / 382 tests passed**（exit 0；比步1 的 29/373 多 2 files / 9 tests，即本步新增的 9 条） |

（构建验证由 Lead 统一跑，本步未触碰 `frontend/.next`。）

---

## （后端主线）P13 账本接回 + P7/P8 团队谓词收尾（2026-10-12）

> **三步全部完成并推送 `main == origin/main`**。每步一个提交、跑完门禁后收口。

### 步1（task-4）`c217bc5` —— TenantProductLoader 团队谓词

**问题**：`_fetch_tenant_product`（`tenant_products.py:87`）用 `scalar_one_or_none()` 且不按团队过滤
⇒ 同租户多团队行会抛 `MultipleResultsFound`（迁移 `202610110019` 放宽唯一键后已可能）。

**修法**：按 `202610110019` 迁移口径补 team 过滤 —— 本团队行优先，无则回退历史 `team_id IS NULL` 行
（仅管理员可见）。判定**复用** `kaas_common/workstation/product_scope.py` 的 `is_same_team`，
不自创。`Loader.load` 新增 `team_id` / `role` 参数（当前零调用方，安全）；缓存 key 含 team_id。

**测试**：新建 `tests/test_tenant_product_loader.py`（8 用例：同租户两团队同 key + 历史 NULL 行 +
管理员兜底 + 缓存隔离 + `spec_from_dict` 形状回归）。

**数字**：orchestrator `pytest -m unit` **1158 passed / 3 failed**（3 条为队友 `spec_delta.py` 并发改动引入，
非本提交）；新测试 **8/8 passed**；route-parity **PASS**。

### 步2（task-5）`c11d426` —— `_effective_product` 走 TenantProductLoader

**问题**：`_effective_product`（`export_quote.py:802`）只查代码注册表，tenant_products 平行账本
进不了规格空间与算价。

**修法**：改为走 `TenantProductLoader`（租户级优先，回退 Python 定义），把 `auth.team_id` / `auth.role` /
`db` 传进去。顺序固定「产品定义 → 并入买家自加档位 → 套团队覆盖」不打乱。产品不存在仍返回 None。

**测试**：新建 `tests/test_team_scope_read.py`（8 用例：tenant_products 行优先 / 无行回退注册表 /
团队 B 不污染 A / 产品不存在 None / 历史 NULL 仅管理员）。

**数字**：orchestrator `pytest -m unit` **1169 passed / 0 failed / 1 skipped**；新测试 **8/8 passed**；
route-parity **PASS**。

### 步3（task-6）`988247a` —— 三处同构团队谓词补齐

**三处落点**：
1. `trade_docs.py:831` `_product_info_of`：SQL 只按 `tenant_id` 过滤 → 补团队谓词（复用 `product_info_access`）
2. `worker/src/main.py` `_product_info_of`（≈`:3684`）：同构补谓词
3. `worker/src/ws_files.py:747` `resolve_photo_refs`：补跨团队取图谓词 —— 把 `user` 传进来，
   按 `file_objects.team_id` 过滤（本团队取，别团队跳过不印坏图）；`user=None` 兼容旧调用方

⚠️ 避开 `main.py:3277` 注释记载的历史事故（镜像实现删除后调用点没改导致 NameError）——
本次同步更新所有调用点（`_apply_product_defaults` / `resolve_photo_refs` 调用处）。

**测试**：`tests/test_team_scope_read.py`（orchestrator `_product_info_of` 跨团队负例 6 用例）+
`worker/tests/test_ws_files_team_scope.py`（已知缺口测试改为「缺口已关闭」断言）。

**数字**：orchestrator `pytest -m unit` **1167 passed / 0 failed / 1 skipped**；
worker `pytest` **257 passed / 0 failed**；route-parity **PASS**。

### 汇总

| 步骤 | 提交 | orchestrator unit | worker | route-parity |
|---|---|---|---|---|
| task-4 | `c217bc5` | 1158 / 3 failed（队友） | — | PASS |
| task-5 | `c11d426` | 1169 / 0 | — | PASS |
| task-6 | `988247a` | 1167 / 0 | 257 / 0 | PASS |

**写入范围**：`tenant_products.py` / `export_quote.py` / `trade_docs.py` / `worker/src/main.py` /
`worker/src/ws_files.py` / 两个新测试文件 / `worker/tests/test_ws_files_team_scope.py` / 本文档。

## （忘记密码）邮箱绑定改密 —— 全链路落地（2026-10-12）

> **需求**：登录页「忘记密码」→ 通过绑定邮箱（`users.email` 已 unique）收重置链接 → 设置新密码。
> **发信渠道**：Resend（`send.powervoy.com` 已验证域名，`RESEND_API_KEY` 已配置到本地 `.env`，
> 真实发信已验证 200 返回 message id）。

### 设计口径（安全实践，用户已确认）

| 项 | 取值 |
|---|---|
| token | `secrets.token_urlsafe(32)`；库里只存 **SHA-256 hex**（`token_hash`，unique）——库泄露不足以重置 |
| 有效期 | **30 分钟**（`expires_at`） |
| 用后即废 | 改密成功置 `used_at`；同用户其它未用令牌一并作废（防旧链接重放） |
| 邮箱存在性 | `POST /auth/forgot-password` 无论邮箱是否存在都返回统一 `{ok:true, message:"如果该邮箱已注册，重置链接已发送"}` |
| 统一错误 | 令牌不存在/过期/已用/账号非激活 ⇒ 一律 400 `invalid_token`（不细分，防令牌探测） |
| 限速 | 复用全局 slowapi（IP 维度）；一次只保留一条有效链接（新建即作废旧的） |

### 落地清单

| 层 | 文件 | 内容 |
|---|---|---|
| 数据层 | `alembic/versions/202610120001_password_reset_tokens.py` + `db/models.py` | `password_reset_tokens` 表（`down_revision=202610110019`；当前 head 已到 `202610170004`） |
| orchestrator | `services/password_reset.py`（新） | 令牌生成/哈希/消费/作废 + Resend 发信 helper |
| orchestrator | `api/auth.py` | `POST /api/v1/auth/forgot-password` + `POST /api/v1/auth/reset-password` |
| worker | `src/main.py` | 同构两路由 + `_http_post_json`（js.fetch/urllib）+ `_hash_reset_token` |
| 前端 | `forgot-password/page.tsx` | 假延迟桩 → 真调 API，统一提示 |
| 前端 | `reset-password/page.tsx`（新） | 读 `?token=` → 新密码 + 确认 → 提交 → 成功跳登录 |
| 前端 | `middleware.ts` / `lib/api/client.ts` | 公开路径 + 免鉴权路径补 `reset-password` |
| 配置 | `app/config/settings.py` | `RESEND_API_KEY` / `RESET_FROM_EMAIL` / `FRONTEND_BASE_URL`（默认值安全） |

### 门禁（2026-10-12 实测，工作区静止）

| 门禁 | 结果 |
|---|---|
| orchestrator `pytest -m unit` | **1173 passed / 1 skipped**（324 deselected） |
| worker `pytest` | **261 passed** |
| 前端 `vitest` | **390 passed（33 files）**（含新增 8 条：forgot 3 + reset 5） |
| 前端 `lint` | exit 0（8 warnings 均历史遗留） |
| 前端 `typecheck` | 2 errors 均 `onboarding/page.tsx` 历史遗留 TS2322（如实报，不修） |
| `contracts:check` | **PASS R0–R6**（173 paths / 103 模型键集 / 29 response_model 一致） |
| `route-parity` | **PASS**（缺失 11 全登记 / 过期 0） |
| `sync-shared -Check` | **exit 0**（共享内核 31 / 报价引擎 21 / 枚举字典 1） |
| Resend 真实发信 | **200**，message id `01a12ea7-7e60-7894-b53f-8ad200996011` |

### 已知边界（如实记录）

- **改密不强制登出**：JWT 无状态（与 `/logout` 口径一致），已改密用户的旧 token 在其过期前仍有效。
  若要"改密即踢下线"，需要引入 token 版本/黑名单，属另一件事。
- **`RESEND_API_KEY` 是 send-only 受限密钥**（`/domains` 返回 401，`/emails` 正常）——这正是期望的最小权限，非缺陷。
- **本机无 Postgres**：迁移用离线 `alembic upgrade --sql` 验证 DDL，真实回填/建表语义待 CI `db-tests` 或生产执行后确认。


## （后端辅线）步2：产品合并前置取证（2026-10-12，task-10）

> 详见 `artifacts/product_merge_backfill_evidence.md`（离线静态核对，不连库）。要点：
> - `file_objects`：可回填（`uploaded_by→users.team_id`，上传时本就写 team_id）；
> - `product_profiles`：可回填（`updated_by→users.team_id`），无法归因行保留 NULL 仅管理员可见；
> - `tenant_products`：**无法自动回填**（无创建者列）⇒ 建议按 `is_system` 分流：true 不归团队、false 历史行保留 NULL。
> - 三张表唯一键均已按团队收敛（`uq_product_profiles_scope` / `uq_tenant_products_key` / `uq_file_primary`，见 `202610110019`）。
>
> **方法如实记录**：本机无 Postgres ⇒ 离线 `alembic upgrade --sql` 在 `feb821f0b9c0` 处因 `sa.inspect(MockConnection)`
> 不可用而失败（R82 已记录的已知限制）；改用逐迁移 DDL 文本 + models.py 元数据静态核对（等价证据，只是不验证全链跑通——
> 那需要真库，挂 CI `db-tests`）。

## （主线）P13 差异读路径纯逻辑层（2026-10-12，effective_spec.py）

> **定位**：P13 是 IMPL_PLAN 的"差异读路径接线"——把 P4 的"租户行整体遮蔽"改为**基线+差异**（不冻住）。
> 本步骤先交付**纯逻辑层**（`backend/orchestrator/app/services/export_quote/effective_spec.py`），
> 含 `resolve_effective_product(base_dict, delta_dict)` 与 `assert_base_hash_match`。
> 该文件**零三方依赖**（只用 `spec_delta` + `tenant_products.spec_from_dict`），
> sync-shared.ps1 已同步进 worker 镜像（22/22），两端同源。
>
> **当前状态**：纯逻辑层 + 10 条测试已验证通过（1183 passed / 0 failed）。
> **待做**：`_effective_product`（export_quote.py）的接线点——等 `tenant_products` 表加上 `override` 列（S5 迁移）
> 后，只需从行里读出 delta dict 传给 `resolve_effective_product`，这里直接生效。
> **当前 tenant_products 无 delta 列** ⇒ 基线原样返回（"未设差异的团队跟着变"），
> 已用测试钉住"上游改了跟着变"语义。

***

## 公开仓库安全审计（2026-10-17）

> **背景**：仓库 2026-10-17 由 private 改为 **public**（原为解除 GitHub Actions 私有仓库计费；
> 见顶部交接）。以下为公开后的泄露审计结论与处置。审计范围：`main` 全历史、当前树、
> 远端全部分支、已跟踪文件；**未**对生产做任何越权探测（不拿泄露凭据去连库/登录）。

### 一、已确认的泄露

| 级别 | 内容 | 位置 | 现状 | 处置 |
|---|---|---|---|---|
| **P0** | Neon 生产库口令（用户 `neondb_owner`，16 位） | `main` 历史：`backend/.tools/*.py` 等 13 个文件，2026-09-18 起；`fbced67`（10-12）已从**当前树**清除 | **历史仍可读，且与现用口令相同**（SHA256 已比对，未打印明文） | **待轮换**；轮换后历史值即失效 |
| **P0** | 同一 DSN 出现在**远端分支** `feat/trade-doc-templates` tip（`4fc5a6e`）的 `backend/.tools/*` | 该分支树（不需要翻历史就能看到） | **已处置**：2026-10-17 删除该远端分支；它落后 `main` 279 提交且**是 main 的祖先**（无独有提交），删除无内容损失 | 仍需轮换口令（历史仍含） |
| **P1** | 管理员 `david@powervoy.com` 的初始口令（8 位弱口令，字典级） | `main` 历史 4 个提交的交接文档（`ff9aa73`…`bb5276e`），`fbced67` 已从当前树删除 | 历史仍可读；**未**尝试登录验证 | 建议改密（走登录页「忘记密码」邮件重置即可） |
| **P1** | 业务数据：`docs/archive/stowage_raw.json` 含真实姓名、企业微信 userid、产品级成本/售价/利润率；`archive/2026-09-trade-doc-xprime-python/sample_docs/*` 含公司名/联系人/电话/邮箱/报价 | 已跟踪文件，公开可见 | 公开 | 待业务方确认是否属商业秘密；若是，需从当前树移除（历史仍在） |
| **P2** | orchestrator `app/config/settings.py` 的 `jwt_secret` **默认值仍是公开串** | 源码 | 仅当部署时漏配 `JWT_SECRET` 才可被利用；worker 侧已是「缺失即 503」 | 建议删除默认值；如担心历史泄露可顺带轮换 `JWT_SECRET`（会让所有在线用户重新登录） |
| **P3** | 根 `.gitignore` 未覆盖 `.dev.vars`（仅 `backend/worker/.gitignore` 覆盖本目录） | `.gitignore` | 未发生（未被跟踪） | 根目录补 `.dev.vars` / `*.dev.vars` |
| **P3** | `frontend-ci.yml` 在 `pull_request` 上注入 `SENTRY_AUTH_TOKEN` | workflow | 同仓分支可拿 secrets，fork 拿不到 | 加 `permissions: contents: read`，token 仅 push 时注入 |

### 二、未发现（全历史 0 命中）

- Resend `re_…`、Sentry `sntrys_…`/DSN、GitHub `ghp_`/`github_pat_`、OpenAI `sk-…`、AWS `AKIA…`
  （唯一命中是测试文件里的假 MinIO 值）、私钥块、Slack/Bearer/JWT 形态串。
- `.env` / `.dev.vars` **从未被跟踪**；`frontend/.env.production` 虽被跟踪，但 Sentry 两项在**所有版本**都是空值。
- `deploy.yml` 仅 `push:main` + `workflow_dispatch`，secret 只经 `env:` 传给 wrangler，无回显；
  其余 workflow 无 `secrets.` 引用、无 `pull_request_target`。
- 本地 `refs/dsh-time-machine/*`、`refs/agents/*`（118 个仅本地提交）**未推送**；`git ls-remote` 仅 `main`。

### 三、处置清单

- [x] 删除远端分支 `feat/trade-doc-templates`（2026-10-17，关闭"当前可读"入口）
- [ ] **轮换 Neon 口令**（Neon Console → 项目 `falling-salad-31662168` → `production` → Roles →
      `neondb_owner` → Reset password；`dev` 分支角色需单独重置），随后：
      更新 Cloudflare Hyperdrive `f53fed49705043008737032e4bfa2b8e` 的连接串
      （`npx wrangler hyperdrive update … --connection-string …`，更新后需重新部署 Worker 生效）
      + 本地 `backend/orchestrator/.env` 的 `DATABASE_URL` + `KAAS_DSN`。
- [ ] 管理员 `david@powervoy.com` 改密（忘记密码邮件重置）
- [ ] 评估 `docs/archive` 中的业务数据是否可公开
- [x] 根 `.gitignore` 补 `.dev.vars` / `*.dev.vars`（2026-10-17，`git check-ignore` 已验证）
- [x] `frontend-ci.yml`：加 `permissions: contents: read`；`SENTRY_AUTH_TOKEN` 只在 `push` 事件注入
      （`github.event_name == 'push'`），PR/含 fork 时为空（2026-10-17）
- [ ] （可选）历史重写 `git filter-repo`：420 commits / 8.8MB / 0 fork，代价是所有 clone 失效、
      PR 断链，且**不能替代轮换**（GitHub 缓存/直链/第三方镜像可能仍在）

> **用户裁决（2026-10-17）**：Neon 口令**暂不轮换**、管理员口令**暂不改**；
> 用户将在本次部署完成后把仓库**改回 private**（作为止血手段）。
> ⚠️ 注意两点：① 公开窗口期内可能已被抓取，"改回 private"不能收回已泄露内容；
> ② 改回 private 后**私有仓库 Actions 分钟额度问题会回归**——push 可能再次被挡在任务启动前，
> 届时需要支付额度、保持 public，或改用 self-hosted runner。

> **口径**：**先轮换（治本）+ 删分支（止血）**；历史重写可排后。
> 若"公开"并非本意，改回 private 能立刻停止继续索引，但**已被抓取的内容不可撤回**，不能因此跳过轮换。

### 四、QA 测试账号（生产，2026-10-17）

为验收生产功能，在生产库创建了 **QA 测试账号**（此前生产只有 1 个管理员、0 个团队，无法演练带登录链路）：

| 项 | 值 |
|---|---|
| 邮箱 | `qa.test@powervoy.com`（`users.id=5`） |
| 类型/角色 | `internal` / `system_admin` |
| 团队 | 「QA 测试团队」（`teams.id=2`，`created_by=5`），已开通 `full_chain` |
| 口令 | **不写入仓库**（仅会话交付；bcrypt 落库，已验证可登录） |

> 用途：生产功能验收（登录、页面、带鉴权 API）。**用完可按需停用**（`PATCH /api/v1/admin/accounts/5`
> 或直接改库 `status='disabled'`），不要把它当成长期管理员。

***

## 管理后台三个页面：**当前无实际用途**（2026-10-17 用户裁决）

用户原话：「把灰度发布、属性沉淀提案和仪表盘指标这个记录到说明文档里，现在确实没什么用」。
以下三处**保留代码但不投入实现/不追求生产可用**，避免后续误当成"漏做的功能"：

### 1. 灰度发布页 `/admin/gray-release`

- **是什么**：平台管理员的功能开关控制台 —— 按租户逐个开/关 `use_v2`（新版功能灰度），
  下方是「近 7 天变更历史」。
- **依赖**：`/admin/tenants`（可用）、`/admin/feature_flag`（2026-10-17 已修到 200）、
  `/admin/deployment_audit`（**生产 404，有意不暴露**）。
- **现状**：开关本身可用；变更历史列表拉不到。**当前无实际用途**（没有按租户灰度的发布节奏）。
- **若将来要用**：先定义「按什么维度灰度（租户/团队/账号）、谁来审批、如何回滚」，
  再决定是否把 `deployment_audit` 迁进 Worker 并暴露。

### 2. 属性沉淀提案页 `/admin/spec-proposals`

- **是什么**：规格属性治理工具 —— 把报价/规格使用中发现的候选属性作为"提案"收集，
  管理员逐条 **批准 / 拒绝 / 合并**，批准后才进入正式规格库。
- **依赖**：`/admin/spec/attribute-proposals`、`/recommended`、`PATCH /{id}`
  （**生产 404，allowlist 标注为开发期治理功能**）；`attribute_proposals` 表当前 **0 行**。
- **现状**：生产打开页面会空/报错。**当前无实际用途**（规格体系仍在演进，没有稳定的提案-评审流程）。
- **若将来要用**：先把提案入口接到真实使用场景（例如报价时"这个属性库里没有"一键提交），
  再迁端点进 Worker。

### 3. 仪表盘指标 `/admin/metrics/summary`

- **是什么**：管理员仪表盘指标，当前实现只返回 `active_sessions`（当前会话数），
  数据来自 orchestrator 的**进程内内存** `session_store`，并映射到 Prometheus
  `kaas_active_sessions` gauge。
- **为什么生产没有**：Worker 是无状态、每请求连接，**没有这个内存 session store**；
  生产也没有 Prometheus 抓取端 ⇒ allowlist 标注「本地运行时采集，线上不暴露」。
- **现状**：**当前无实际用途**（不是业务功能，也不是客户可见指标）。
- **若将来要用**：先定义"要看什么指标（活跃团队/报价量/错误率）、数据存哪（DB/日志）、谁来看"，
  再用 DB/日志重新实现，而不是把内存 session_store 搬进 Worker。

> **口径**：这三处不是"待修 bug"，是**当前不需要的能力**。后续排期时不要把它们列为阻塞项；
> 若产品确实要启用，先补「用途定义 + 数据来源 + 权限边界」三件事再动手。

***

## 2026-10-17 客户/报价/汇率：修复与阶段自动化

### 1. 新建客户 500（已修，生产已验证）

- **根因**：`customers.plan` / `status` 是 `NOT NULL`，但只有 ORM 层默认值、**没有 server_default**；
  Worker 用裸 SQL 插入且没写这两列 ⇒ 约束失败 → 500（浏览器侧还表现为无 CORS 头）。
- **修复**：显式写 `plan='free'` / `status='active'`；同时按用户口径支持
  **「公司名称与联系人至少填一个」**（都为空 → 422 `CUSTOMER_IDENTITY_REQUIRED`）；
  只填联系人时用联系人名做展示名，并落一条主联系人（`cust_contacts.is_primary=true`）。
- **验证**：公司 only → 201；联系人 only → 201；两者皆无 → 422 带可读错误；测试数据已软删除。

### 2. 报价汇率：实时拉取（已上线）

- **原状**：`fx_rates` 长期 0 行、`/fx-rates/latest` 恒 404；注释提到的 `scripts/fetch_fx_rates.py` 实际不存在。
- **方案**：Worker **读时刷新** —— 数据超过 6 小时就调 `https://open.er-api.com/v6/latest/{base}`
  并 upsert 到 `fx_rates`；外部源失败降级到缓存（`is_stale=true`），完全无数据才 503。
  前端 `useLatestFxRate()` 在报价工作台**自动带入**（本地已存手填值则优先手填）。
- **验证**：`/api/v1/fx-rates/latest` 返回 `{"rate":6.698464,"source":"open.er-api.com","is_stale":false}`。
  另留管理员调试端点 `/api/v1/fx-rates/_debug`（直接打一次源，返回结果或异常）。
- **口径**：免费源**每日更新**，属"当日最新"而非盘中级实时；要分钟级需接商业/银行 API。
  排查记录：Pyodide 下 `js.fetch` 传 options（自定义 headers）会崩成裸 500，改成最小 `fetch(url)` 后正常。

### 3. Excel 导入模板：前端生成（已上线）

- Worker 装不了 openpyxl（C 扩展），`/import/template?format=xlsx` 按设计 501；
  现改为**前端 exceljs 懒加载生成带样式 xlsx**（数据表 + 填写说明：表头原样、必填底色/批注、
  冻结首行、列宽、下拉候选），CSV 保留备用。
- **边界**：线上**上传**仍只接受 CSV（`_reject_spreadsheet`）；要「下载 xlsx → 上传」闭环需 Worker 放开上传。

### 4. 客户阶段：由订单状态推导 + 手动兜底（2026-10-17 用户口径修正）

> ⚠️ **2026-10-18 已被取代**：客户阶段与订单阶段分离为两层。客户阶段只有
> **活跃 / 沉寂 / 已下单** 三种；「已下单」由开启中的订单推导；手动活跃/沉寂不再被
> 覆盖；30/90 天自动规则与询盘/报价联动已删除；「流失」归属订单阶段，
> 客户阶段不再有 `lost`。**现行口径见 `docs/archive/2026-10-20-closeout/HANDOVER_2026-10-18.md` 与
> `docs/WORKSTATION_DESIGN.md §6.4`**，以下 10-17 记录仅作历史。
> 同段中的「写后 60s 旧读（Hyperdrive 查询缓存）」为真实现象，处置见新交接文档。

- **设计原则（用户 2026-10-17 修正）**：影响阶段的操作大多针对**某张订单** ⇒ 那些操作只改
  **订单状态**；**客户阶段是汇总视图**，由该客户的订单/报价/询盘推导，不再被单个操作直接写死。
- **阶段**：`lead 线索 → inquiry 询盘 → quoted 报价 → won 成交 → lost 流失 / inactive 沉寂`；
  **删除【洽谈中】**（`CUSTOMER_STAGE`、共享规则、前端标签、mocks 同步）。
- **推导规则**（`_recompute_customer_stage`，辅助逻辑失败不阻断主业务）：
  - 有未取消订单且任一处于 `confirmed/producing/shipped/completed` ⇒ **won**；
  - 有未取消订单但都还是 `pending` ⇒ **quoted**（已报价，待买家确认/定金）；
  - 无有效订单：有报价单 ⇒ **quoted**；有询盘 ⇒ **inquiry**；否则 **lead**；
  - 手动 `lost` / 自动 `inactive` 为终态，自动推导不覆盖（手动 PATCH 仍是兜底）。
- **触发点**：建询盘、建报价、建订单、**订单状态流转**（`POST /orders/{id}/status`）后重新推导；
  **收款/定金本身不改客户阶段**（它属于订单动作；订单 `confirmed` 后自然推导为 won）。
- **手动维护保留为兜底**：`PATCH /customers/{id}/stage` 与页面阶段选择仍在。
- **时间兜底**：读取客户列表时，30 天无更新 → `lost`（`won` 除外）；90 天无活动 → `inactive`。
- **生产实测**（2026-10-17）：客户 9 → 建报价 ⇒ `quoted`；建订单（pending）⇒ 仍 `quoted`；
  `POST /orders/2/status {confirmed}` ⇒ DB 客户阶段 `won`，`cust_stage_log` 有
  「按订单/报价/询盘推导：quoted → won」。测试客户已软删除。
- **已知现象**：写后立刻 GET 可能读到旧阶段约 60 秒（Hyperdrive 查询缓存），刷新/稍后再读即正确。
  若要强一致，需在 Hyperdrive 配置关闭/缩短查询缓存（`caching` 设置）。
- **流失的拒绝文件（2026-10-17 已实现并生产验证）**：
  - 新增 `POST /api/v1/file-objects/upload`（multipart 通用上传）——字节落点
    **S3 预签名 → R2 binding（`FILES`）→ inline 回退**，行内如实记录 `storage`。
    **生产实测 `storage:"s3"`（R2），且 `GET /file-objects/{id}/content` 200、字节数一致**。
  - `PATCH /customers/{id}/stage` 当 `target=lost` 时**强制** `rejection_file_id`：
    无文件 → 422 `REJECTION_FILE_REQUIRED`；文件不属于该客户 → 422 `INVALID_REJECTION_FILE`
    （校验 `owner_type='customer' AND owner_id=<customer_id>`）；文件 id 写进 `cust_stage_log.reason`。
  - 前端「更新阶段」弹窗选「流失」时显示**必填**文件选择（PDF/图片），先上传再改阶段。
  - **R2 踩坑与修复（重要，后续文件功能都会遇到）**：
    ① Python Workers 的绑定**不在 `js` 全局**（`from js import FILES` → ImportError），
       要从 `request.scope["env"].FILES` 取；
    ② `obj.arrayBuffer()` 在 Pyodide 里返回的是 **memoryview**（没有 `.to_py()`），
       旧代码 `bytes(buf.to_py())` 抛 AttributeError 被吞 → 文件读回 404；
       已抽 `_to_bytes()` 兼容 memoryview / 旧 JsProxy。
  - 诊断端点（管理员）：`GET /api/v1/file-objects/_r2_debug?key=...`（binding/put/get 真实错误）、
    `GET /api/v1/fx-rates/_debug`（汇率源）；排查完可删。
- **待办**：① **定时任务（Cron Trigger / 外部调度）触发 30/90 天兜底** ——
  用户 2026-10-17 明确「定时任务可以加待办放说明文档，先不做」；目前仍是**读客户列表时触发**。
  ② 若要求写后立即一致，需在 Hyperdrive 配置关闭/缩短查询缓存（当前约 60 秒旧读）。

### 5. 已知的其它 CI 红（非本轮引入）

- `Frontend CI` 的 `pnpm test` / `e2e` 在 `use-products` 用例上失败：
  `TypeError: Failed to execute 'digest' on 'SubtleCrypto'` —— 与 Node/jsdom 的
  `crypto.subtle.digest` 入参类型有关，属**既有问题**，需单独修（与本轮客户/汇率/模板改动无关）。
- `backend:test`、`deploy`、`contracts:check` 在 `c025c67` 上均**绿**。