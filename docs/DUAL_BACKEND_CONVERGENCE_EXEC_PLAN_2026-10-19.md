# 双后端收敛执行计划（2026-10-19 · 已定方向，待集中推进）

> 🔄 **已被方案 B 取代（2026-10-19 晚场，已确认）**：双后端优化的最终方向是**方案 B**
> （单 Worker + 全 asyncpg + 一份 app 双入口，评估结论 B-可行 + 三项已确认修正），
> 本计划的 A′/C 子集路线与 Phase 2（预览环境，按 README §2 三环境矩阵重新定义）**停止按本文执行**；
> 其中 **Phase 1（P1 迁库）随决策 1 废弃**（放弃 PPg 回 Neon）。POC 结论（Phase 0）仍然有效。
> **当前唯一权威：[README.md](../README.md)（主交接文档）§3 / §5 / §9。**

> **状态：计划已获方向性批准，本轮只写文档，未动代码。** 执行时按 Phase 逐个推进，
> 每个 Phase 完成必须更新 [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md)
> 交接摘要 + 本文打勾。
> 方向裁决（2026-10-19 用户）：**合并（路线 A）+ 恢复三层环境模型**。理由链：
> 双后端时代 orchestator 天然充当"准预览"，行为差异有第二实现兜底；**单后端时代
> push 即上生产，预览环境从可有可无变成唯一安全网** ⇒ 合并与三层模型是同一决策。
> 评估依据与 POC 清单见 [DUAL_BACKEND_CONVERGENCE_2026-10-19.md](./DUAL_BACKEND_CONVERGENCE_2026-10-19.md)。
> 环境模型裁决见 [PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md](./PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md) §0 晚场记录。

---

## 0. 目标态（验收时的样子）

```
                 同一份 FastAPI 应用源码（SQLAlchemy 数据访问）
                /              |                    \
开发环境          预览环境              生产环境
本地 Docker PG17   CF 预览部署           push main → CI
(PG17 对齐)        → Neon dev 分支        → Worker + Hyperdrive → PPG(PG17)

迁移：alembic（唯一入口，不变，跑在本地/CI，指向目标库）
防线：shared/contracts（zod）保留；route-parity 退役（没有第二个后端可比了）
```

**验收总标准**：同一业务逻辑只有一份实现；行为面漂移（默认值/约束/事务）结构性归零；
三个环境共用一份代码，仅靠部署目标 + 环境配置区分；预览环境可公开访问、连隔离预览库。

---

## Phase 0 · POC（0.5–1 天）——决定路线 A 生死

验证清单（完整版见评估文档 §5，逐条打勾）：

- [ ] Worker 内 `import sqlalchemy` + `greenlet` + `asyncpg`：可部署、可 import
- [ ] `/health` 加 SQLAlchemy 查询探针，部署后冒烟 200
- [ ] 冷启动对比（DEPLOY.md §0.2 口径）：加 SQLAlchemy 后增幅 <1s 量级
- [ ] 连续 20 次冷启动无 isolate 启动失败（间歇 5xx 探针）
- [ ] 依赖切分方案确认：worker 包不含 oss2/minio/openpyxl/apscheduler/otel/psycopg2/alembic

**出口判定**：全过 → 进入 Phase 2；冷启动或兼容性不过 → 转路线 A′（只收敛数据访问层，
见评估文档 §3.2），本计划 §3 的收敛步骤按 A′ 裁剪。

## Phase 1 · 生产库迁移（Neon → PPG，半天）

完全按 [PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md](./PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md)
§2 执行（10 步清单 + 备份链）。本文只约定两件事：

- **先做 P0 再做 P1**：P0 若推翻路线 A，`session.py` 的 SSL 通用化仍要做（P1 Step 2），
  不浪费。
- P1 期间**不改任何业务代码**（除 Step 2 的连接小改），保证迁库可独立归因、独立回滚。

## Phase 2 · 预览环境（1 天，放在收敛之前，作为收敛期的安全网）

> 顺序理由：收敛（Phase 3）是最长的高风险窗口，此期间每次 push 都直接上生产；
> 必须先把安全网搭好，而不是收敛完再补。

- [x] **前置实测①：CF 预览部署免费档可用性**——✅ **2026-10-19 用户确认：预览部署在免费计划可用**。
      剩余待实测（执行 P2 时）：可绑自定义域名与否、额度/并发限制、预览 URL 形态
- [ ] **前置实测②**：Neon 免费档承载预览库的预计用量（190 CU-hours/月硬顶）
- [ ] 预览部署链：从非 main 分支 push → 自动产出预览 URL（`.github/workflows` 加
      preview job，或 wrangler 侧配置）
- [ ] 预览环境配置：预览部署读 Neon dev 分支连接串（Hyperdrive 预览 config 或直连）；
      **绝不指向 PPG 生产**
- [ ] 预览库初始化：`alembic upgrade head` 指向 Neon dev + 种子数据脚本
- [ ] 验收：预览 URL 可公开访问、登录/关键业务页往返、写数据只落在 Neon dev
- [ ] 前端预览（可选后置）：静态导出的预览产物与 API 预览配对

## Phase 3 · 全量收敛（路线 A，3–5 天，最大变更）

### 3.1 应用源码合并

- [ ] 以 orchestrator 的 SQLAlchemy 实现为**唯一业务实现**；worker 的裸 asyncpg 路由
      逐模块退役（不是删文件，是把 handler 切到统一 app 的路由）
- [ ] 打包链改造：`pywrangler deploy` 改打统一应用 + Workers 适配层
      （入口、静态资产、Hyperdrive binding、js.fetch 出站等保留 worker 侧适配）
- [ ] 依赖切分落地：`pyproject.toml` 分 worker / local-only 两组；打包产物清单审计
      （不得混入 local-only 依赖）
- [ ] orchestrator 角色归位：迁移工具 + 本地开发壳（`uvicorn` 起的就是生产同一份 app）

### 3.2 逐模块迁移顺序（每步可独立提交、独立冒烟）

按业务域从**依赖最少、在线流量最小**的开始（建议顺序，执行时可调整）：

1. 基础设施（health、auth、accounts）→ 先验证整条链
2. 客户/询盘/线索池（CRM 域）
3. 报价/订单（算价域，金额逻辑最重，放在中间——前面已有回归信心）
4. 单证/出运/税务（文档域）
5. 情报/市场调研/AI/触达（集成域，出站依赖多，最后）

### 3.3 每步的出口条件

- [ ] 该域全部路由走统一实现，`route-parity.py` 中对应白名单项**删除**（只减不增）
- [ ] 全部门禁绿：orchestrator/worker pytest、前端三件套、`contracts:check`（注意
      先提交产物再复跑的顺序）、`sync-shared.ps1 -Check`、`NEXT_EXPORT=1 pnpm build`
- [ ] 部署生产冒烟：DEPLOY.md §0.2 流程 + 该域关键 API 往返
- [ ] 文档同步：本文打勾 + PROBLEM_STATUS 摘要

### 3.4 收尾

- [ ] 全部模块收敛后：`route-parity.py` 与 `WORKER_ORCHESTRATOR_DRIFT.md` 退役
      （归档并注明原因"已无第二后端"）；`kaas_common` 内核的去留重新评估
      （统一实现后它可能只是"app 的一部分"而非"两端的共享"）
- [ ] `contracts:check` 保留（前后端契约仍有意义），但 R2 工位镜像检查口径复核

## Phase 4 · 观察期（1 周）

- [ ] 生产冷启动、5xx 率、延迟对比基线（P0 测的数据）
- [ ] 注册/登录/算价/单证生成四类关键路径回归
- [ ] 成本盘点：新功能只写一遍的实际提效；门禁排障时间变化

---

## 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| R1 | P0 失败：SQLAlchemy/greenlet 在 Workers runtime 不可用或冷启动超标 | 转路线 A′（评估文档 §3.2），损失仅 0.5–1 天 |
| R2 | 收敛中途生产故障且无预览兜底 | Phase 2 强制在 Phase 3 之前完成 |
| R3 | 依赖切分不干净，local-only 包混入 worker 包导致部署炸 | 3.1 产物清单审计 + 部署后 import 探针 |
| R4 | 预览环境用量打爆 Neon 免费档 | Phase 2 前置实测；预览库可定期 reset/用最少数据 |
| R5 | 大变更叠加无法归因 | 硬性分批：P0→P1→P2→P3 各自独立提交链、独立冒烟，**禁止跨 Phase 混合提交** |

## 执行纪律

- 每个 Phase 开始前重跑其"前置实测/出口条件"清单，过期数据重测。
- 执行顺序若需调整（如 Phase 1 与 Phase 2 并行），先在本文件 §0 后追加变更记录并说明理由。
- 任何 Phase 失败不可跳过继续下一个 Phase；失败的 Phase 先出复盘记录。
