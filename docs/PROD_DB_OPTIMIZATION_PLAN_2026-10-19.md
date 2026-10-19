# 生产优化方案：Neon→PPG 迁移 + 链路性能（2026-10-19）

> **状态：方案已定稿待执行，本轮不动手。** 执行顺序与触发时机见 §7，执行前需用户拍板。
> **性质**：只含设计与决策记录，不含代码改动。执行时每一步都按本文清单打勾，并同步更新
> [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) 交接摘要。

---

## 0. 决策记录（用户裁决链，防回退时丢上下文）

| 日期 | 裁决 | 结论 |
|---|---|---|
| 2026-10-19 | 开发库迁 "Ghost" | ❌ **否决**——Ghost 是发布平台（Node.js+MySQL），不是数据库，无法承接业务表 |
| 2026-10-19 | 生产库迁 Prisma Postgres | ✅ **成立**，且最佳时机**就是现在**：生产尚未投入使用（数据量小、无停写窗口、迁移分钟级）；投入使用后再迁才有真实代价 |
| 2026-10-19 | 三层模型（本地 Docker=开发 / Neon=预览 / PPG=生产） | ⚠️ **降级为两层**：个人阶段不做正式 preview 环境，发布沿用"备份+两段迁移+冒烟"轻流程 |
| 2026-10-19 | 是否为 Neon 付费 | ❌ **不付费**——生产因此不能长期压 Neon 免费档（190 CU-hours/月硬顶，用完停摆） |
| 2026-10-19 | 本地 Docker 角色 | **不变**——日常开发主环境；升 PG17 做三环境版本对齐 |
| 2026-10-19 | 性能优化诉求（更快+承载更多用户） | 接受，但与"迁库"解耦：迁库≠性能升级，性能瓶颈另有清单（§3–§5） |
| 2026-10-19 | 本轮范围 | **只写本文档，暂不动手** |

## 1. 目标架构（最终态）

```
开发：  本地 Docker Postgres 17（日常开发主环境，不变）
       Neon dev 分支（云端开发辅助：Hyperdrive 本地模拟 / .tools 脚本；分支能力归位）
生产：  Worker "kaas"（不变）→ Hyperdrive（双 config，见 §3）→ Prisma Postgres（免费档，PG17）
备份：  pg_dump -Fc → R2（发布前必做 + 可选每日 cron）
```

三条纪律：
1. **版本三对齐**：本地 Docker = Neon dev = PPG 生产 = **PG17**。Docker 镜像 `postgres:16-alpine` → `postgres:17-alpine`。
2. **Neon 不再承载生产**；生产备份不依赖任何"分支快照"能力（那是 Neon 专有）。
3. 迁移后 `DEPLOYMENT_PLAN` 的"发布前 Neon 分支快照"环节永久退役，替换为 §2 Step 7 的 pg_dump 流程。

## 2. Part 1：生产库 Neon → Prisma Postgres 迁移

### 2.0 执行前测量（先取证，缺一项不动手）

- [ ] 生产库当前大小（Neon Console → Storage；预期远小于 2GB 免费档上限）
- [ ] Neon 项目的 Postgres 大版本（决定 dev/Docker 对齐目标）
- [ ] PPG 免费档"20 万 ops/月"的计量口径（官方文档/console 实测，登记到本文）

### 2.1 步骤

| Step | 动作 | 要点 |
|---|---|---|
| 1 | PPG Console 建生产库（免费档），生成凭证 | 记录 direct connection（`db.prisma.io` 主机）与 pooled 两种串；**免费档无自动备份**（风险 R1） |
| 2 | 代码小改：[session.py:22](../backend/orchestrator/app/db/session.py) SSL 判定 | 从 `"neon.tech" in url.host` 改为通用（按 `ssl` query 参数/驱动默认）；[alembic/env.py](../backend/orchestrator/alembic/env.py) 的 Neon 专用 DSN 处理同步复核 |
| 3 | 全量迁移 | `pg_dump -Fc`（**PG17 客户端工具**）→ `pg_restore --no-owner --no-privileges` 走 direct connection |
| 4 | 一致性校验 | 关键表行数对比 + `alembic_version` 一致 + 建一个测试客户往返写读 |
| 5 | 停写检查 | 生产未投入使用，理论无写流量；执行时仍先确认（`SELECT count(*) FROM customers` 前后对比兜底） |
| 6 | Hyperdrive 新建 config 指向 PPG（direct connection，剥掉 query 参数）→ `wrangler.jsonc` 换 id → 部署 Worker | Hyperdrive 本地模拟连接串**继续指 Neon dev 分支**（开发路径不变） |
| 7 | 生产冒烟 | `/health` JSON、`/api/v1/*` 401、`/login` 200 + 关键业务页往返；冒烟脚本带重试（DEPLOY.md §0.2 冷启动窗口） |
| 8 | 备份链落地（见 §2.2） | 迁移完成不等于结束，备份链是常驻机制 |
| 9 | Neon 降级 dev-only | 旧 production 分支改名 `kaas-prod-neon-legacy` **保留 30 天**作冷备份，到期删除；dev 分支保留 |
| 10 | 文档同步 | 本文 §8 清单 + PROBLEM_STATUS 交接摘要 |

### 2.2 备份链（替代 Neon 分支快照，常驻机制）

- **发布前必做**：`pg_dump -Fc` → 上传 R2（建议新桶 `kaas-backups` 或 `kaas-files/backups/` 前缀），文件名带时间戳；发布流程（DEPLOYMENT_PLAN）加一步勾选项。
- **可选增强**：Workers Cron Trigger 每日低峰自动 dump（同一套 SigV4 代码已就绪，R2 有 binding）。
- **回滚预案**：生产故障 → `pg_restore` 最近 dump 到新 PPG 库（或切回 Neon legacy 分支 + 旧 Hyperdrive config 应急，30 天窗口内）。

### 2.3 Part 1 风险表

| # | 风险 | 对策 |
|---|---|---|
| R1 | PPG 免费档无自动备份 | §2.2 备份链；并把"每日 dump"列入待办 |
| R2 | 免费档超限（存储>2GB / ops>20 万） | 监控；真超限那天说明业务长大了，升级付费档或回到"读副本"讨论（Neon 有、PPG 无） |
| R3 | 两家 serverless 行为差异（Neon 休眠 vs PPG unikernel 暂停） | 版本对齐 + 发布后冒烟；已知坑（Hyperdrive 缓存）不属于库差异 |
| R4 | 迁移窗口数据漂移 | Step 5 停写检查；生产空库阶段执行，风险≈0 |

## 3. Part 2：Hyperdrive 缓存精调（双 binding 方案）

### 3.1 现状与欠账

- 单一 `HYPERDRIVE` binding，默认开查询缓存（max_age 60s）⇒ **写后读不一致**（客户新建后刷新消失，根因已锁定，见 [HANDOVER_2026-10-18](./HANDOVER_2026-10-18.md) §1.2）。
- 处置欠账：`npx wrangler hyperdrive update f53fed49705043008737032e4bfa2b8e --caching-disabled` **尚未执行**（部署延期）。

### 3.2 设计：两个 Hyperdrive config，按查询路由

```
HYPERDRIVE        → PPG（caching disabled）→ 所有业务读写（默认）
HYPERDRIVE_CACHE  → PPG（caching enabled，TTL 默认）→ 白名单纯读查询
```

- Worker 增加第二个 binding；`_acquire(request)` / [platform/db.py](../backend/worker/src/platform/db.py) 增加 `cache: bool = False` 参数（orchestrator 侧对应封装）。
- **白名单**（可缓存查询，变更容忍度 ≥ TTL）：
  - 汇率（`open.er-api.com` 后端，本就有自身缓存语义）
  - 税率字典 / rate sets
  - 产品注册表 / spec 字典
  - 其他纯静态字典
- **默认 nocache**：任何业务表（customers/quotes/orders/trade_docs/file_objects…）一律走 `HYPERDRIVE`。
- 纪律：新查询**默认 nocache**；进白名单需评审并在代码注释登记理由（防止后人把列表查询塞进缓存白名单重演 10-18 事故）。

### 3.3 验收

- e2e/手测：客户新建 → 列表**立即可见**（nocache 路径）；
- 字典类查询命中缓存（Hyperdrive analytics 可见命中率）；
- 缓存 binding 只挂白名单调用点，`grep` 审查无越界。

## 4. Part 3：Worker 启动优化第二刀

- **目标**：降低 `Worker Startup Time`（`pywrangler deploy` 报告口径，曾观测 ~2.8s），压缩发布后间歇 5xx 窗口（[DEPLOY.md](../DEPLOY.md) §0.2）。
- **先测量**：import 计时脚本打各模块加载耗时，按数据排序（不猜）。
- **手段（候选，按测量结果取舍）**：
  1. 懒加载重模块：导出/S3 SigV4/openpyxl/PDF 渲染等非热路径模块移入函数内 import；
  2. `pyproject.toml` 依赖裁剪复核（508 模块那轮之后有无新增重依赖）；
  3. 非热路径路由模块延迟注册。
- **门禁**：worker `pytest` 全绿 + 部署冒烟 + Startup Time 前后对比**记录进本文**。
- 注意：不得触碰请求期热路径的首次延迟（懒加载只是把成本搬家，冷端点首请求会变慢——可接受，登记即可）。

## 5. Part 4：API 响应压缩 + 前端请求治理（先测量后动手）

> 原则：**§3 未落地前不动本组**（缓存关了之后链路变真，测量才有意义）。

1. **API 压缩**：为大数据量 JSON 端点（列表/导出）评估 FastAPI `GZipMiddleware`（设 `minimum_size` 阈值，小响应不压，避免 CPU 税）。判据：先确认哪些端点响应体 > 阈值。
2. **前端请求治理**：审计 `lib/api` 调用点——同页多组件重复拉字典/产品注册表的场景做 in-flight 去重。判据：Network 面板或服务端日志确认"打水漂"请求存在再动手；**没有证据不动**。

## 6. 暂缓项（本次明确不做，防范围蔓延）

| 项 | 原因 | 触发条件 |
|---|---|---|
| Neon 付费档 / 读副本 | 用户裁决不付费；未来"更多用户"时再议 | 生产撞免费档限制 |
| 换运行时（Cloudflare Containers 等） | 存档方案未获批；个人阶段无必要 | Worker 吞吐成真实瓶颈 |
| preview/staging 环境 | 个人低频发布，备份+两段迁移够用 | 多团队真实使用、发布变频繁 |
| Ghost 等 CMS | 已否决 | —— |
| Neon 生产大版本升级 | 生产迁走后 Neon 仅 dev，dev 项目直接选 17 即可 | —— |

## 7. 执行顺序与门禁

```
① ~~放行 2026-10-18 部署批次~~ —— **已完成，无需再做**（2026-10-19 核实：DEPLOYMENT_PLAN 执行记录 +
   提交祖先链，生产已于 10-18 22:00 部署至迁移 `202610180010`，10-19 注册修复已随 push 自动上线；
   先前"待放行"口径过时，相关文档已同步更正）。真正遗留两件小事：**Hyperdrive 缓存关闭**
   （§3.1，大概率未执行，验证法=生产新建客户立即刷新）与 **R2 S3 密钥重建**（13→32 位，
   待用户在 dashboard 操作，见 PRODUCT_MEDIA_STORAGE_PLAN §5.3）
② Part 1 迁移（§2，含测量 Step 0）→ 门禁：生产冒烟全绿
③ Part 2 双 binding（§3）→ 门禁：worker pytest + 手测写后读
④ Part 3 第二刀（§4）→ 门禁：worker pytest + Startup Time 对比
⑤ Part 4（§5）→ 测量后择机
每步完成：文档同步 + 提交推送 main（项目规则 1）
```

## 8. 执行时的文档同步清单

- [ ] [DEPLOY.md](../DEPLOY.md)：架构图、Hyperdrive 连接串、回滚章节（分支快照 → pg_dump）
- [ ] [DEPLOYMENT_PLAN_2026-10-18.md](./DEPLOYMENT_PLAN_2026-10-18.md)：后续发布流程引用新备份机制
- [ ] [HANDOVER](../docs/HANDOVER_2026-10-18.md)（或新交接）：PPG 凭证位置、双 binding 路由说明
- [ ] [README.md](../README.md) §1 架构图
- [ ] [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md)：交接摘要登记执行结果
- [ ] 本文：每个 Step 打勾 + 实测数字回填（Step 0 三项测量、Startup Time 对比）

---

_最后更新：2026-10-19 · 方案定稿待执行 · 本轮零代码改动_
