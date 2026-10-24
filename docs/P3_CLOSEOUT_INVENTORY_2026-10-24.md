# P3 收尾清单：内核摘除 DB/鉴权依赖的剩余工作盘点（2026-10-24 20:30）

> 依据：docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §10 P3；本清单由 Lead 用 grep 全量盘点内核各模块得出。
> 结论先行：**P3 的"删依赖"必须放在最后** —— 在剩余端点全部迁走（或登记为方案 A 例外）之前，
> 删 `platform/db.py`/`get_current_user` 会让内核所有路由 500。

## 1. 全量盘点（2026-10-24，HEAD=811e6a6）

| 模块 | 路由数 | DB 调用 | auth 依赖 | 处置 |
|---|---|---|---|---|
| main.py | 83 | 149 | 77 | 大部分属 trade-docs 域：读已迁 render-data；其余读需切片，写属方案 A |
| chain.py | 41 | 38 | 41 | AI/leadgen/research 域：「保持 Python」（抓取/AI 推理）为主 |
| ws_files.py | 22 | 30 | 21 | 文件字节/元数据：读已迁 3 条；字节类「保持 Python」（R2/PDF） |
| quote_api.py | 19 | 18 | 18 | 6 条读已迁；剩余写（POST/PATCH/batch）属方案 A |
| ws_teams.py | 12 | 13 | 12 | 团队管理 CRUD：**门面已直连**（phase-2 波 a）—— 待核对这些是否已删内核版 |
| ws_extras.py | 12 | 11 | 12 | external-docs 列表/下载已修隔离；fx-rates 待拍板 |
| ws_docs_hardening.py | 11 | 3 | 11 | 单证确认/签发闸门：写为主，方案 A |
| ws_approvals.py | 11 | 15 | 11 | 审批中心：GET 列表已迁；写动作（approve/reject）方案 A |
| ws_products.py | 8 | 9 | 8 | 产品矩阵：写为主 |
| ws_docs_ext.py | 8 | 15 | 8 | render-data 等：已迁 render-data；其余读待切片 |
| tax_archives.py | 8 | 14 | 8 | GET 已迁 + 写已迁（暂未放量） |
| ws_workstations.py | 7 | 9 | 7 | 工位/订阅：门面已有大量直连（teams 域） |
| ws_seals.py | 6 | 7 | 5 | 公章：PNG 校验「保持 Python」 |
| ws_join_applications.py | 6 | 7 | 5 | 团队加入：门面已有部分 |
| ws_crm_ext.py | 6 | 11 | 6 | 询盘 3 读已迁；写（PATCH）方案 A |
| engine_api.py | 6 | 0 | 0 | **已是纯 RPC 入口（不连库）** —— 目标形态的样板 |
| ws_shipments.py | 4 | 10 | 4 | 门面已直连（phase-2 波 c）—— 待核对这些是否已删内核版 |
| ws_clause_templates.py | 4 | ? | 4 | GET 有懒种子写（P2 §9 #5）—— 语义待定 |
| imports_api.py | 2 | 3 | 2 | CSV 批量导入：multipart 透传，引擎校验 |
| 其余小模块 | 9 | ~10 | 6 | ws_quote_ext(1)/ws_enums(1)/ws_customer_records(1)/ws_option_overrides(2)/ws_admin_*(5) |
| **合计** | **~318** | **~389** | **~269** | |

## 2. 关键发现

1. **engine_api.py 已经是零 DB 的目标形态**（6 条 RPC 全部只做纯算/纯装配）—— 证明"供数→纯算"模式能落地；
2. **已迁移的路由仍保留内核实现作为 off 回退** —— 所以即使全部迁完，删依赖前还需一个"删回退"步骤：
   迁完 → 白名单默认 on → 观察 → **删内核旧 handler** → 才能删 db.py/get_current_user；
3. **两块结构性例外**（方案 A 已定）：
   - **15 条写事务**（取号+状态机+多表同事务，见 P2 §7）：永久保留内核 DB；
   - **保持 Python**（字节/PDF/AI 抓取与推理）：不迁；
   ⇒ **P3 的终点是"内核只保留：RPC 入口 + 方案 A 写事务 + 保持 Python 的端点 + cron"，DB 连接只在例外清单里出现**；
4. **待核对项**：ws_teams/ws_shipments 等域门面已有直连实现 —— 内核是否还有对应路由在浪费维护（双份漂移风险）？
   下一步应该做一轮"**已直连域的内核路由删除**"（先于新迁移，消双份）。

## 3. 修订后的 P3 路线（务实版）

| 步骤 | 内容 | 状态 |
|---|---|---|
| P3-a | 已直连域（teams/shipments/customers/orders 等 phase-2 已直连的）**删除内核重复 handler**，消双份 | **待做（下一轮候选）** |
| P3-b | 剩余只读端点继续按批迁移（quotes 列表/详情切片进行中；fx-rates 待拍板） | 进行中 |
| P3-c | 方案 A 写事务 + 保持 Python 端点 → 登记**例外清单**（长期保留内核 DB） | 待做 |
| P3-d | 迁完后：白名单默认 on → 删透传 mount → 删内核已迁 handler → 删 `platform/db.py`/`get_current_user` | 依赖 P3-a/b/c |

## 4. 本轮新增的 P3-a 候选（先消双份，再做新迁移）

按"门面已直连 + 内核还有实现"筛出的域（需逐条核对 routes.json 与门面注册面）：
- ws_teams.py（12 条）/ ws_shipments.py（4 条）/ ws_customer_records.py（1 条）
- main.py 里可能已被门面移植的散条

**核对方法**：门面 `src/routes/*.ts` 的注册面（route-surface 机检已锁 193 直接）∩ 内核 @app 装饰器 —— 交集即双份。
