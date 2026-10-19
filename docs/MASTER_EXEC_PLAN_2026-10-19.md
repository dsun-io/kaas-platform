# 总执行计划清单（2026-10-19 · 工作区全面盘点后汇总）

> **状态：已排定执行顺序，批次 0 开工中。** 本文是全工作区待办的唯一执行入口：
> 两份审计（状态类 36 处 + 计划类全量文档）交叉验证去重后的结果 + 今日新定计划。
> 每个批次完成必须：勾选本文 + 更新 [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md)
> 交接摘要 + 推送 `main`（项目规则 1）。
> 专项细节仍在各自文档，本文只管"做什么、什么顺序、谁做、依赖谁"。

---

## 0. 执行顺序总览

```
批次 0  即时小修（代码 5 项 + 文档收口 4 项）      ← 现在开工，2 个 teammate 并行
批次 U  用户操作包（dashboard/GitHub/业务配置 4 项） ← 不阻塞开发，随时可做
批次 1  收敛 P0：POC（0.5–1 天）                    ← 批次 0 收尾后启动
批次 2  收敛 P1：生产库迁 Neon→PPG（半天）          ← 含 Hyperdrive 缓存关闭、生产数据清理
批次 3  收敛 P2：预览环境（1 天）                    ← 免费档已确认可用
批次 4  收敛 P3：双后端全量收敛（3–5 天）            ← 按业务域 5 步迁移
批次 5  收敛 P4：观察期（1 周）
批次 6  技术栈安全债（Next 15+/16、Node 22、ESLint 10、TS 6）← 硬性串行排在收敛之后
批次 7  独立排期项（见 §5，按依赖与拍板情况插入）
```

硬性规则：批次 1–5 严格按序（见收敛执行计划的风险 R5：大变更不可叠加归因）；
批次 0 与 U 与之并行不悖；批次 6 不与收敛交叉。

---

## 1. 批次 0 · 即时小修（现在开工）

> ✅ **已完成（2026-10-19）**：B0-1~B0-4（提交 `846d4ab`，门禁 typecheck/lint/test 全绿）；
> B0-5/B0-6（提交 `1350c87`，orchestrator 1200 passed / worker 303 passed / route-parity PASS）。
> 印花税口径变更（定义删除并入杂税 3%，fixed/ratio 生效）已按用户裁决落地，详见 PROBLEM_STATUS
> 交接摘要。D0-1~4 文档收口已推送（`dbf2b54`）。

| ID | 事项 | 证据 | 负责 | 写范围 |
|---|---|---|---|---|
| B0-1 | 前端 `crypto.subtle.digest` 加 jsdom/CI 兜底（Frontend CI 红） | `frontend/src/hooks/use-products.ts:110` 裸调 | teammate A | `frontend/src/hooks/use-products.ts` + 测试 |
| B0-2 | 货代询价文案补 DAP/DDP 费用项说明 | `frontend/src/app/(app)/quotes/freight-panel.tsx:189` 仍只列五项 | teammate A | `freight-panel.tsx` |
| B0-3 | 报价「定价数据」tab 改名「成本历史/产品历史成本价」（用户裁决 #10） | `frontend/src/app/(app)/quotes/page.tsx:41` | teammate A | `quotes/page.tsx`（+ 相关 test） |
| B0-4 | 报价产品下拉过滤已停用产品 | quotes 前端无 inactive 过滤 | teammate A | quotes 产品下拉组件 + test |
| B0-5 | 印花税 fixed/ratio 遗留模式归并 | `pricing.py:115-157` 仍有 `fixed_per_unit/fixed_total/fixed`（`6437646` 明确"待归并"） | teammate B | `backend/orchestrator/app/services/export_quote/pricing.py` + 单测；⚠️ 算价逻辑，改完跑全量报价测试 |
| B0-6 | 诊断端点收敛（`_r2_debug`、`fx-rates/_debug` 移除或加保护） | `ws_files.py:890`、`ws_extras.py:196`；route-parity 白名单同步删项 | teammate B | orchestrator + worker 两侧 + `route-parity` 白名单文件；改完必须跑 `route-parity.py` |

### 批次 0 · 文档收口（lead 自己做）

| ID | 事项 |
|---|---|
| D0-1 | `DEPLOYMENT_PLAN_2026-10-18.md` §9 执行清单 11 个 `[ ]` 打勾 + 加注执行时间（10-18 22:00） |
| D0-2 | `HANDOVER_2026-10-18.md` §0/§7、`PROBLEM_STATUS` L102-122 旧"尚未部署"段落加删除线 |
| D0-3 | `CONTRACT_AND_MOCK_DECISIONS.md` 归档（S1–S3 步骤被收敛方案取代，保留为决策记录） |
| D0-4 | `PLATFORM_UPGRADE_PLAN.md` 文末状态行改为"主体已收口" |

## 2. 批次 U · 用户操作包（需用户动手，不阻塞任何开发）

| ID | 事项 | 位置 |
|---|---|---|
| U-1 | R2 `S3_ACCESS_KEY` 重建 32 位（dashboard 操作） | `PRODUCT_MEDIA_STORAGE_PLAN §5.3` |
| U-2 | 生产 `product_tax_rates` 配置数据（0 条则批量报价不放行） | DEPLOY_PLAN 顶部 |
| U-3 | 仓库改回 private + 确认 Actions billing | GitHub 设置 |
| U-4 | 智能表格 21 行缺失输入补全（业务动作） | `SHEET_CALC_VERIFICATION §4-5` |

## 3. 批次 1–5 · 双后端收敛 + 迁库（主链）

> ⚠️ **2026-10-19 POC 结论：路线 A（worker 跑统一 SQLAlchemy async app）不可行 as-is**
> （greenlet 无 wasm wheel ⇒ `sqlalchemy.ext.asyncio` ImportError；冷启动 +1854ms 超线）。
> 见 [POC_WORKER_SQLALCHEMY_2026-10-19.md](./POC_WORKER_SQLALCHEMY_2026-10-19.md)。
> **执行方向改为：P3 从"全量收敛"降级为"路线 A′（数据访问层同源）+ C 子集（worker 真 PG
> 测试）"**；P0–P2、P4 不变。原"单后端合并"目标改为"行为面漂移收敛到可测试、可审计"。

严格按 [DUAL_BACKEND_CONVERGENCE_EXEC_PLAN_2026-10-19.md](./DUAL_BACKEND_CONVERGENCE_EXEC_PLAN_2026-10-19.md) 执行：
**P0 POC（✅ 已完成：路线 A 否决，转 A′）→ P1 迁库（半天，含 Hyperdrive `--caching-disabled` +
生产测试数据清理 U 确认）→ P2 预览环境（1 天，workers.dev 自动 URL，免费档可用性已确认）→
P3（A′ + C 子集：SQL/DDL 内核同源 + worker 写入路径真 PG 测试）→ P4 观察期（1 周）**。

批次 2（迁库）额外并入：`Hyperdrive 查询缓存关闭`（审计 #1，与迁库同窗口）、
`生产测试数据/拒绝文件历史清理`（审计 #14，数据删除须用户确认后执行）。

批次 4 顺带评估项（A′ 改造 worker 模块时一并处理，不单独立项）：
- `订阅门禁两套口径`（`chain.py _require_sub` 仍查 `tenant_subscriptions` → A′ 时统一）
- `Excel xlsx 上传闭环`（`_reject_spreadsheet`）——POC 证实 **in-Worker 运行纯 Python 包
  无硬阻塞**（sqlalchemy 同步 Core 可 import；Pyodide 索引有 openpyxl 依赖链需复核），
  在批次 4 重估：能跑则实现 xlsx 闭环，否则维持 CSV 收口并文档固化裁决。

## 4. 批次 6 · 技术栈安全债（收敛完成后串行）

按 [TECH_STACK_UPGRADE_2026-10-17.md](./TECH_STACK_UPGRADE_2026-10-17.md) 批次 B：
Next 14.2→15.5+/16（2 critical RCE，修复只发 ≥15.5.24）、CI Node 20→22+、ESLint 8→10、TS→6。
前置：执行前重跑该文档 §1 复现命令（版本继续前进，数字会过期）。
理由：同为前端大改，与收敛交叉会无法归因（收敛动打包链，升级动构建链）。

## 5. 批次 7 · 独立排期项（等待拍板或触发条件）

| ID | 事项 | 卡点 |
|---|---|---|
| I-1 | 「流失」拒绝文件链路迁订单阶段（订单阶段新增 `lost`） | 业务设计先行 + 用户拍板口径 |
| I-2 | 单证加固 P1/P2（事实层/一致性引擎/收款容差等 5 项） | 5 项口径待用户拍板（`UNCERTAIN.md`） |
| I-3 | 文件存储收尾 3 项（真实 DB 用例 / 公章 PI 视觉 QA / 排序过滤测试） | 依赖 U-1 完成后验证更完整 |
| I-4 | PDF 归档尾巴（端到端一次 / 定时调度 / "已变更"标识） | 低优先，可穿插 |
| I-5 | Cloudflare agent 接入 | 无依赖但价值未明，待用户排优先级 |
| I-6 | 单证指纹批量对账定时调度 | 暂缓（测试钉死"无定时调度"，接线需改测试） |
| I-7 | P3 暂缓五项（30/90 自动沉寂、MSW 刷新、e2e 数据层、租户级产品配置化等） | 维持触发条件制 |

## 6. 智能体团队分工

| 成员 | 职责 | 写范围 |
|---|---|---|
| **lead**（我） | 总控、批次调度、文档收口、生产操作窗口、门禁复跑裁决 | `docs/`（收口项） |
| **fixer-frontend**（teammate A） | 批次 0 前端 4 项 | `frontend/src/hooks/use-products.ts`、`quotes/` 下相关文件 |
| **fixer-backend**（teammate B） | 批次 0 后端 2 项 | `pricing.py`、orchestrator/worker 诊断端点 + route-parity 白名单 |
| （后续按需 spawn） | POC 验证 / 收敛分域迁移 | 每 Phase 启动时定义 |

纪律：所有 teammate 遵守 [AGENTS.md](../AGENTS.md) 规则 4（私有 index 提交、自证、归位）；
批次 0 两条线写范围不相交，可并行；任何人不得跨范围改动。

## 7. 已完成/过时总账（审计结论，不再跟进）

**全部落地可收口的方案**：QUOTE 22 项（残留 3 个小尾巴已入批次 0）、TAX-01~07、
BATCH_QUOTE B1~B6、PDF 归档三链、SHEET_CALC §6、PLATFORM_UPGRADE 主体。
**过时不再适用**：30/90 自动沉寂（用户裁决"先手动"）、CONTRACT_AND_MOCK 的 S1–S3 步骤、
PROBLEM 更早的四条历史待拍板（已被 10-17 决策 #17–#20 覆盖）。
