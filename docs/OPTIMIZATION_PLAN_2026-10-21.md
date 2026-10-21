# 优化执行计划（2026-10-21）

> **本计划 = 三条线合并**：① 用户拍板的 **TS Worker 全量迁移**（不折中）；② 另一任务交接的
> **结构性债务批**（`STRUCTURAL_DEBT.md` S-1~S-6 + G-9~G-11）；③ 性能体检遗留
> （见 [`PROD_PERFORMANCE_AUDIT_2026-10-21.md`](./PROD_PERFORMANCE_AUDIT_2026-10-21.md)）。
> **已变决策（2026-10-21，本会话）**：G-10 冷启动路径 = **全量迁 TS Worker**（原登记「先不动」作废）；
> G-11 地理迁移 = **已完成**（迁至新加坡 aws-ap-southeast-1，RTT 245→75ms；Neon 免费档无东京）。

## 0. 工作流总览（按依赖排序）

| # | 工作流 | 内容 | 预估 | 前置 |
|---|---|---|---|---|
| W1 | 性能收尾快赢 | 静态资产缓存规则、登录 429 排查、迁库后观察 | 0.5–1 天 | CF 权限 ✅ 已有 |
| W2 | 结构性债务批 | S-3/S-6/S-4①/§6.4 防再犯（P0 批）；S-4②/S-5（P2 批） | 1.5–2.5 天 | 无 |
| W3 | **TS Worker 全量迁移** | 见 §2 分阶段 | **3–5 周** | W2 的 S-6 ADR 先行 |
| W4 | 收尾退役 | Python worker 下线、文档收口、门禁迁移 | 2–3 天 | W3 |

**W2 与 W3 的关系（重要）**：原 P1 批「S-1/S-2（Python 巨石拆分 + 循环依赖消除，3–5 天）」
**被 W3 取代**——Python 拆分做了也是退役前 throwaway。**改投**：把这部分时间换成
「金标对照测试资产建设」（§2 Phase 0），它直接决定 W3 的迁移质量。S-1/S-2 在
`STRUCTURAL_DEBT.md` 保持登记、状态改 ⛔（被 W3 取代），不再投入。

---

## 1. W1 性能收尾快赢（性能体检遗留）

| 项 | 动作 | 验收 |
|---|---|---|
| P3a 静态资产边缘缓存 | CF Cache Rule：`/_next/static/*` + `/_next/image/*` 长 TTL（immutable 指纹文件名，安全）；`Cache-Control` 已由 Next 导出带 immutable，规则补边缘强制 | 资产重复请求 <100ms、`cf-cache-status: HIT` |
| P3b 登录 429 + 26s | 查 zone WAF/Rate Limiting 事件日志，定位 429 来源规则；误伤则调阈值或加 skip | 正常登录不再 429；登录 P95 <3s |
| 迁库后观察 | 部署后 24–48h 观察 cron（*/15 replied 扫描等）写库正常、无 5xx 尖峰 | cron 日志正常 |
| 旧 Neon 项目清理 | **2026-10-28 提醒已设**（schedule-3cc18076）：复查后弹窗请用户确认删除 falling-salad-31662168 + 旧 Hyperdrive f53fed…（破坏性，必须确认） | 用户确认后执行并销账 |

## 2. W3 TS Worker 全量迁移（主工程）

### Phase 0 · 基线与金标（1–2 天，先行）
1. 导出 **253 条路由清单**（method / path / 鉴权依赖 / DB 读写），作为迁移 checklist 与进度看板。
2. **金标对照 harness**：同库并行起 Python worker（本地 local_run）与 TS worker，
   对每条路由回放请求、diff 响应体（忽略时间戳等不稳定字段）。这是迁移的质量主门禁
   ——比「翻译 1565 条 pytest」更准且快。
3. 从 1565 条 pytest 中筛 HTTP 层用例 → 生成 TS 侧 conformance 套件（优先鉴权/报价/单证）。

### Phase 1 · TS 骨架（2–3 天）
- 框架 **Hono**（见 §4 决策点 D1）；运行时 Node.js（Workers 官方一等公民）。
- Binding 封装：Hyperdrive（postgres.js 驱动，连接串即 Hyperdrive 暴露的 `postgresql://`）、R2、Browser Rendering、S3 预签名（aws4fetch 直译现有 SigV4 逻辑）。
- 中间件：CORS（现有双中间件语义对齐）、env 注入（AsyncLocalStorage 等价现 ContextVar）。
- **兼容性铁约束**：bcrypt 哈希 `$2b$` 互通（bcryptjs）；JWT HS256 互通（jose）；已有用户密码哈希零迁移成本。
- CI 门禁：typecheck / lint / test / bundle 体积断言（对照现 11.7MB，TS 侧预期 <3MB）。

### Phase 2 · 按域迁移（2–3 周，每域独立可交付）
顺序原则：**读多写少、低耦合的先切**；引擎重的后切。
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

### Phase 4 · 切换与退役（2–3 天）
- 全量切流（单一 TS Worker，域名/绑定不动）；Python 版本保留 2 周可回滚（wrangler versions）。
- 文档收口：根 README / HANDOVER / AGENTS 技术栈基线改 TS 口径；`check-worker-bundle.py` 等门禁改 TS 侧；`STRUCTURAL_DEBT.md` 销账 S-1/S-2（以「被 W3 解决」销账）。
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

## 4. 待用户拍板（一次给全）

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| D1 | TS 框架 | ① Hono（生态/类型/中间件模型最接近 FastAPI）② itty-router（极简） | ① Hono |
| D2 | 引擎移植方式 | ① TS 直译（可控、可测）② WASM 编译 Python 内核（保留 Python 语义但包大、调试难） | ① 直译 |
| D3 | S-1/S-2 Python 拆分 | ① 跳过（被 W3 取代）② 仍先做（若担心 W3 中途叫停想留更好维护的 Python） | ① 跳过 |
| D4 | 历史密钥清理（G-9/§6） | 维持 2026-10-20 裁决（不清理）；或重启 B/C 路径 | 维持原裁决（与 W3 无关） |

---

*计划创建：lead（DSH AI），2026-10-21。执行顺序：W1 → W2(P0) → W3 Phase 0 起。*
*每完成一项按 AGENTS.md 规则 1 更新文档（PROBLEM_STATUS 交接摘要 + 本文销账）并推送。*