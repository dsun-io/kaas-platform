# 优化执行计划（2026-10-21）· **已收口**

> ✅ **2026-10-21 收口**：W1–W4 全部完成（含历史密钥清理、两层架构切流）；W5（对外 MCP+REST）仅完成设计，
> 待用户立项后实施。当前交接见 `HANDOVER_2026-10-21_CUTOVER.md`；窗口后事项见其 §3。

> **本计划 = 三条线合并**：① 用户拍板的 **TS Worker 全量迁移**（不折中）；② 另一任务交接的
> **结构性债务批**（`STRUCTURAL_DEBT.md` S-1~S-6 + G-9~G-11）；③ 性能体检遗留
> （见 [`PROD_PERFORMANCE_AUDIT_2026-10-21.md`](./PROD_PERFORMANCE_AUDIT_2026-10-21.md)）。
> **已变决策（2026-10-21，本会话）**：G-10 冷启动路径 = **全量迁 TS Worker**（原登记「先不动」作废）；
> G-11 地理迁移 = **已完成**（迁至新加坡 aws-ap-southeast-1，RTT 245→75ms；Neon 免费档无东京）。

## 0. 工作流总览（按依赖排序）

| # | 工作流 | 内容 | 预估 | 前置 |
|---|---|---|---|---|
| W1 | 性能收尾快赢 | 静态资产缓存规则、登录 429 排查、迁库后观察 | 0.5–1 天 | CF 权限 ✅ 已有 |
| W2 | 结构性债务批 ✅ 全批完成 | S-3/S-6/S-4①（P0）；S-4② except 收敛 86 处（e6778c3）/S-5 流程约束/S-7 建档 | 完成 | — |
| W3 | **TS 门面 + Python 内核分层迁移（修订版，§2.0）** | UI 面迁 Hono；引擎/AI/cron 留 Python | **2–3 周** | W2 的 S-6 ADR 先行 |
| W5 | 对外能力：MCP + REST 双暴露 | TS 门面挂 MCP Server + REST 规整（复用鉴权） | 1 周 | W3 Phase 2 后 |
| W4 | 收尾退役 | Python worker 下线、文档收口、门禁迁移 | 2–3 天 | W3 |

**W2 与 W3 的关系（重要）**：原 P1 批「S-1/S-2（Python 巨石拆分 + 循环依赖消除，3–5 天）」
**被 W3 取代**——Python 拆分做了也是退役前 throwaway。**改投**：把这部分时间换成
「金标对照测试资产建设」（§2 Phase 0），它直接决定 W3 的迁移质量。S-1/S-2 在
`STRUCTURAL_DEBT.md` 保持登记、状态改 ⛔（被 W3 取代），不再投入。

---

## 1. W1 性能收尾快赢（性能体检遗留）

> **免费版优化项对账（用户清单 2026-10-21）**：前端 P0 ✅（d84ce81）；限流 ✅（CF 免费规则，已放宽 5/10s）；
> R2 存量 ✅（10GB 免费，现用量 <1%，无需动作）；表/索引优化 ✅（体检证库健康无需动，结论在审计报告 §1.3）；
> 三环境隔离 ✅（已落地）；迁移链治理 ✅（alembic 唯一真源 + 3 个 schema 门禁并 CI）。

| 项 | 动作 | 验收 |
|---|---|---|
| P3a 静态资产边缘缓存 | ✅ **已完成**：`frontend/public/_headers`（Workers Assets `_headers` 机制；注意 Next 静态导出不应用 next.config headers）+ CF 缓存规则（ruleset `c5f56989`；注意 CF API 表达式 `starts_with` 函数式会 400，wildcard/infix 才合法）；部署 `f8171937` 实测返回 immutable | 已达成 |
| P3b 登录 429 + 26s | ✅ **已完成**：根因=zone 限流规则（2026-10-20 U-S4，auth 端点 2 次/10 秒/IP；worker 源码 0 处 429）。已放宽至 **5 次/10 秒**（用户弹窗批准，防共享出口 NAT 误伤），mitigation 10s 不变。26s 样本=冷启动+被拦叠加，随 W3 根治 | 已达成 |
| 迁库后观察 | 部署后 24–48h 观察 cron（*/15 replied 扫描等）写库正常、无 5xx 尖峰 | cron 日志正常 |
| 旧 Neon 项目清理 | **2026-10-28 提醒已设**（schedule-3cc18076）：复查后弹窗请用户确认删除 falling-salad-31662168 + 旧 Hyperdrive f53fed…（破坏性，必须确认） | 用户确认后执行并销账 |

## 2. W3 TS 门面 + Python 内核分层迁移（主工程）


### 2.0.1 Phase 2 执行口径：门面移植 vs 内核透传（2026-10-21）

- **门面移植 ≈163 条**：auth/customers/teams/orders/files/outreach/admin/workstations/intel/dashboard/meta。
- **内核透传 ≈86 条**：quotes/trade-docs/ai/cron —— 门面只做鉴权+协议转换+错误归一，转发 `KERNEL.fetch`，
  **不逐端点重写**（禁止第二份实现）。详见 `backend/ts-migration/route-classification.md`。
- 收益：Phase 2 工作量大幅收敛；迁移收益不变（所有 UI 请求先过门面，冷启动 ~50ms）。
### 2.0 架构修订（2026-10-21 用户拍板，取代原「全量迁 TS」）

**原 W3（全量迁 TS）作废原因**：用户指出系统定位=智能制造业务管理 + 工位化能力 + 未来 AI +
对外 MCP/API——Python 在 AI/数据/业务规则生态上占优，且金标资产最厚的 `kaas_common` 引擎是
Python；全量重写牺牲生态、风险最大。**修订为永久两层架构（非临时折中）**：

```
外部调用(脚本/agent/MCP/REST)
        │
┌───────▼──────────────┐   Service Binding（同账号 Worker 互调，免费档可用，零新基础设施）
│ TS Worker (Hono)      │ ───────────────────────────────────────┐
│ · 全部 UI 面路由(迁出)  │                                         │
│ · 鉴权/会话/CRUD/文件    │                                ┌─────────▼────────┐
│ · 对外 MCP + REST 网关  │                                │ Python Worker     │
│ · 冷启动 ~50ms ✅       │                                │ · 报价/单证引擎     │
└───────────────────────┘                                │ · 未来 AI/数据能力  │
        │                                                │ · cron 定时任务     │
        └──────────────► Hyperdrive ◄────────────────────└───────────────────┘
                          Neon（新加坡）
```

- **体感速度 = TS 门面给**（UI 路由冷启动 ~50ms）；引擎/AI 端点在 Python 侧（本就以秒计，
  界面 loading 呈现），其冷启动不再影响体感。
- **Phase 3「引擎 TS 直译」作废**（原 D2 决策一并作废）：引擎零重写，Python 内核经
  Service Binding 被 TS 门面调用；契约=内部 JSON 接口 + 金标对照。
- 路由清单按 **门面（迁 TS）/ 内核（留 Python）** 两类标注（ts-scout Phase 0 产物扩展一列）。
- 域名切分：生产自定义域名指 TS 门面；Python Worker 保留独立访问域（内部/调试/cron 自有触发器）。
- 新增 **W5 对外能力**：MCP Server + REST 规整双暴露，建在 TS 门面（一等公民）。
- 风险变化：引擎行为漂移风险归零（不重写）；新增风险=service binding 契约漂移 ⇒ 金标对照覆盖。

原 Phase 0/1/2/4 框架保留适用（域顺序按新分类调整），下文中「全量」「引擎移植」字样以本节为准。

### Phase 0 · 基线与金标（1–2 天，先行）
1. 导出 **253 条路由清单**（method / path / 鉴权依赖 / DB 读写），作为迁移 checklist 与进度看板。
2. **金标对照 harness**：同库并行起 Python worker（本地 local_run）与 TS worker，
   对每条路由回放请求、diff 响应体（忽略时间戳等不稳定字段）。这是迁移的质量主门禁
   ——比「翻译 1565 条 pytest」更准且快。
3. 从 1565 条 pytest 中筛 HTTP 层用例 → 生成 TS 侧 conformance 套件（优先鉴权/报价/单证）。

### Phase 1 · TS 骨架 ✅ 已完成（2026-10-21，commit db5810f）
- 框架 **Hono**（见 §4 决策点 D1）；运行时 Node.js（Workers 官方一等公民）。
- Binding 封装：Hyperdrive（postgres.js 驱动，连接串即 Hyperdrive 暴露的 `postgresql://`）、R2、Browser Rendering、S3 预签名（aws4fetch 直译现有 SigV4 逻辑）。
- 中间件：CORS（现有双中间件语义对齐）、env 注入（AsyncLocalStorage 等价现 ContextVar）。
- **兼容性铁约束**：bcrypt 哈希 `$2b$` 互通（bcryptjs）；JWT HS256 互通（jose）；已有用户密码哈希零迁移成本。
- CI 门禁：typecheck / lint / test / bundle 体积断言（对照现 11.7MB，TS 侧预期 <3MB）。

### Phase 2 · 按域迁移（2–3 周，每域独立可交付）

> **进度（2026-10-21）**：波 A ✅（auth 9 / customers 20 / teams 15 = 44 条，commit `c80f894`；
> 45 测全绿、typecheck 0）+ 引擎域透传层 ✅（`src/proxy.ts`：quotes/trade-docs/ai → KERNEL.fetch，
> 鉴权纵深/4xx 原样/5xx 归一/不可达 502，7 条单测）；波 B 进行中（orders/files/outreach/admin 48 条）。
> 波 C ✅（workstations 35 / intel 34 / dashboard 1 = 70 条，meta 的 /health 已存在；commit `efb6cbc`）。
> **Phase 2 全部完成**：249 业务路由 = **163 直接注册 + 86 前缀透传**，机检 0 缺失/0 多余
> （`tests/route-surface.test.ts`，归一 `{id}`/`:id` 后 method+path 全等）；97 测全绿、typecheck 0。
> 本地金标双跑（门面 vs 生产 Python）：可验证 10 条全部一致，4 条差异全为预期（/health 身份 + 本地无
> service binding 的 3 条 proxy）——报告归档 `backend/ts-migration/golden/local-edge-vs-prod.report.md`。

顺序原则：**读多写少、低耦合的先切**；引擎域不移植、走透传（见 §2.0.1）。
1. auth/users/teams（含登录/注册/bootstrap）
2. customers / inquiries（cust_*）
3. orders / quotes API 壳（不含引擎计算）
4. files / seals（R2/S3 路径，签名逻辑直译后重点回归）
5. intel / leadgen / research / market
6. admin / events / cron（ws_cron 三条 CronTrigger 语义逐字符对齐，有测试锁死）
7. trade-docs API 壳（渲染/指纹对账 cron 保留 Python 期间继续跑也可）

每域 Definition of Done：金标 diff 全绿 + TS 单测覆盖新增逻辑 + 生产灰度（按域切流或整体双跑）。

### Phase 3 · kaas_common 引擎移植（与 Phase 2 并行启动，专人）
- 重头：`export_quote/` 报价引擎 + 单证 facts/render 内核 + number_rules/numbering。
- 策略：**TS 直译**（见 §4 决策点 D2），对照 Python 版做**同输入同输出**属性测试
  （金标单据集已有——2026-10-21 执行批 8 的 3 份真实单据 + FX 金标可直接复用）。
- 引擎双跑期：Python 引擎留原 worker 专门跑计算端点（内部分流），验证 TS 引擎输出 100% 一致后再切。

### Phase 4 · 切换与退役 ✅ 已执行（2026-10-21，用户批准直接切流）—— 详细步骤见 [`W4_CUTOVER_RUNBOOK_2026-10-21.md`](./W4_CUTOVER_RUNBOOK_2026-10-21.md)
- 全量切流（单一 TS Worker，域名/绑定不动）；Python 版本保留 2 周可回滚（wrangler versions）。
- 文档收口：根 README / HANDOVER / AGENTS 技术栈基线改 TS 口径；`check-worker-bundle.py` 等门禁改 TS 侧；`STRUCTURAL_DEBT.md` 销账 S-1/S-2（以「被 W3 解决」销账）。
- **Python 内核瘦身**：迁出的 UI 路由代码从 main.py/ws_* 删除后，main.py 应收至内核规模（目标 ≤3000 行），
  `check-structural-debt.py` 阈值同步收紧（4000→3000）；noqa:E402 随挂载模式消解复测。
- 1565 条 pytest 中未被金标覆盖的部分：归档说明（退役不是删除历史）。

### 风险登记
| 风险 | 缓解 |
|---|---|
| 引擎行为漂移（算钱算税） | 金标对照 + 真实单据回归；引擎最后切，双跑期可秒回滚 |
| Python↔TS 边界类型差异（Decimal/日期/JSONB 键序） | 金标 diff 白名单显式登记，不静默放过 |
| 并发工作区（多任务线同时写） | 私有 index 提交纪律不变；W3 期间建议冻结 Python 业务面大改 |
| 周期比预估长 | 每 Phase 结束可交付中间态（双跑期生产已在 TS 上跑部分流量，收益提前兑现） |

## 3. W2 结构性债务批（交接自 STRUCTURAL_DEBT.md）

| 项 | 动作 | 口径 |
|---|---|---|
| S-3 TODO 锚点纪律 | 52 处 TODO/FIXME 注释统一格式 + 反查索引 | P0，0.5 天 |
| S-6 ADR 补录 | 新建 `docs/ARCH_DECISIONS.md`，补 6–8 条（raw asyncpg/无 Redis/R2 兜底/Python Worker 选型等）——**先于 W3 Phase 1**（W3 本身是最大新选型，必须先有 ADR 纪律） | P0，0.5 天 |
| S-4 第一步 | 清 `print()`（18 处→阈值内宽松） | P0，0.5 天 |
| §6.4 防再犯四项 | 零成本落地（inventory 命名核查纪律等） | P0，随 S-6 |
| 门禁并 CI | `check-structural-debt.py --allow-known` 并入 backend-test.yml | P0，0.5 天 |
| S-4 第二步 / S-5 | except 收敛（88 处逐处判断）、流程约束清单 | P2，随后 |
| **S-1/S-2** | **⛔ 被 W3 取代**（见 §0），不投入 Python 拆分 | 用户确认（决策点 D3） |


### 4.1 免费版额度评估（2026-10-21，用户最关注项）

**结论：迁 TS 后免费版不但撑得住，余量反而比现在大。** 逐项对照：

| 配额项 | 免费档上限 | 现状（Python） | 迁 TS 后 | 判定 |
|---|---|---|---|---|
| Workers 请求数 | 10 万次/天 | 低频 B2B 工具，估计数千/天 | 不变（±0，接口数量不变） | ✅ 充裕 |
| **Workers CPU 时间** | 10ms/请求 | **紧张**：Pyodide 解释执行，FastAPI 单请求 CPU 常达数 ms，重接口逼近上限 | **极宽裕**：V8 原生，同接口 CPU 约降到 1/10–1/50（等 DB 的网络时间不计 CPU） | ✅ **改善最大的项** |
| Workers 内存 | 128MB/isolate | Python 运行时 + 11.7MB bundle，占用高 | bundle <3MB，运行时几乎不占 | ✅ 改善 |
| 冷启动 | — | 0.4–10s（用户体验问题） | ~50ms | ✅ 根治 |
| 子请求数 | 50/请求 | 每请求 1 次 DB（Hyperdrive 不计子请求） | 不变 | ✅ |
| Browser Rendering（PDF） | 10 分钟/天、3 并发 | 单证 PDF 出档用，现状未超 | 用法不变 | ✅ 持平（用量增长才是付费触发器，与迁移无关） |
| Neon Free | 0.5GB 存储 / 免费算力 | 全库 ~42MB（新加坡） | 不变 | ✅ |
| R2 Free | 10GB / A+B 类操作额度 | 文件存储，现状未超 | 不变 | ✅ |
| GitHub Actions | 公开仓库免费 | CI 现有多 job | TS 侧加 typecheck/lint/test job | ✅ 公开仓免费 |

**付费触发器（与本次迁移无关，登记观察）**：①请求数持续逼近 10 万/天；
②Browser Rendering 月需求超免费分钟数（单证 PDF 量起来后）；③Neon 存储超 0.5GB 或算力档位不够。
任一触发再议 Workers Paid（$5/月）/ Neon 付费档，届时单独弹窗。

**框架问题的直接回答**：是的——FastAPI（Python 框架）在 W3 终态被 **Hono（TS）整体替换**，
这就是根治冷启动的那把刀；但「架构」的其余部分（单 Worker 伺服前端+API、Hyperdrive、R2、
域名/部署纪律）原样不动。免费版评估见上表：迁移方向与免费版兼容，不存在「迁移倒逼付费」。

## 4. 决策记录（含 2026-10-21 两次修订，取代初版表）

| # | 决策点 | 终态（2026-10-21） | 备注 |
|---|---|---|---|
| D1 | TS 框架 | ✅ **Hono** | 已落地（Phase 1 骨架） |
| D2 | 引擎移植方式 | ~~TS 直译~~ → **作废**：引擎**零重写**，留 Python 内核经 Service Binding 调用 | 架构修订（§2.0）取代；原直译方案不再执行 |
| D3 | S-1/S-2 Python 拆分 | ✅ **跳过**（被 W3 取代；路由迁出 + W4 内核瘦身自然消解） | STRUCTURAL_DEBT 已注记 |
| D4 | 历史密钥清理 | ✅ **新裁决（2026-10-21）：清理**——重写 git 历史清除明文泄露 + 轮换仍有效的泄露凭据 | 推翻 2026-10-20「接受风险」；执行记录见 STRUCTURAL_DEBT §6 |
| D5 | 架构形态 | ✅ **TS 门面 + Python 内核两层**（不折中、不全量 TS） | ADR-008 |
| D6 | 对外能力形态 | ✅ **MCP + REST 双暴露**（建在 TS 门面） | W5 |

> 开工范围：W1+W2 快赢批先行，W3 Phase 0 并行启动（均已执行）。
> 免费版额度评估（用户最关注项）：见 §4.1。

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| D1 | TS 框架 | ✅ **已定（2026-10-21）：Hono** | — |
| D2 | 引擎移植方式 | ✅ **已定（2026-10-21）：TS 直译**（金标属性测试兜底） | — |
| D3 | S-1/S-2 Python 拆分 | ✅ **已定（2026-10-21）：跳过**（⛔ 被 W3 取代，STRUCTURAL_DEBT 已注记） | — |
| D4 | 历史密钥清理（G-9/§6） | 维持 2026-10-20 裁决（不清理）；或重启 B/C 路径 | 维持原裁决（与 W3 无关） |

---

*计划创建：lead（DSH AI），2026-10-21。执行顺序：W1 → W2(P0) → W3 Phase 0 起。*
*每完成一项按 AGENTS.md 规则 1 更新文档（PROBLEM_STATUS 交接摘要 + 本文销账）并推送。*

## 5. Goal 持久化副本（防长会话失忆；goal 本体因自动续轮限制待用户直接发言时同步）

```text
KaaS 平台优化全计划执行（唯一权威文档=本文档，每轮先读核对进度再动手）。

[最终架构 2026-10-21 拍板] TS 门面 + Python 内核两层：
- TS Worker(Hono) = 对外唯一门面：UI 面路由迁出 + MCP/REST 双暴露 + 鉴权/CRUD/文件；冷启动 ~50ms。
- Python Worker = 内核：kaas_common 引擎 + 未来 AI/数据 + cron(3条)；Service Binding 被门面调用；引擎零重写。
- 铁纪律：业务规则只在 Python 内核一处；TS 门面只做鉴权/校验/协议转换；zod schema 从 pydantic 生成；金标 harness 常态化。
- 域名 kaas/api→TS 门面；Python 留内部域；DB=Neon 新加坡+Hyperdrive(68304207…776e)。

[进度] W1 ✅；W2 P0 ✅(P2 批=except 收敛+S-5 低优先)；W3 Phase 0 ✅；下一步=W3 Phase 1 Hono 骨架。
待拍板小项：/openapi.json 生产现返回 text/html，Phase 1 Hono 显式服务 JSON 并登记金标差异。

[决策] D1 Hono；D3 跳过 S-1/S-2；分层架构；MCP+REST；D4/G-9 密钥维持不清理。

[运维坑] wrangler OAuth 过期→部署须 $env:CLOUDFLARE_API_TOKEN(User 作用域)；PYTHONUTF8=1 跑含 emoji 脚本；
CF 表达式用 wildcard/infix(函数式 400)；静态 immutable 靠 public/_headers；auth 限流 5 次/10 秒/IP；
PATH 的 python 坏→用各 .venv；uv 需 UV_CACHE_DIR=D:\tools\uv-cache。

[纪律] 私有 index 提交+归位；完成一项即更新 PROBLEM_STATUS+本文销账+推 main；
旧 Neon 删除等 2026-10-28 提醒弹窗确认；生产变更先取证、要确认的弹窗。
```