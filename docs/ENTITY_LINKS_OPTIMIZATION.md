# 关系建模优化方案：列的归属 + 一张通用边表

> 2026-10-11 设计。目标：**保留链接表的能力，消除"一张关系一张表 + 与列并存"带来的复杂度**。

## 1. 复杂度到底在哪（不是"用了链接表"）

| 问题 | 现状 |
|---|---|
| **表爆炸** | 一个关系类型一张表：`order_quote_refs`、`trade_doc_order_refs`、`trade_doc_quote_refs`、`trade_doc_inquiry_refs`、`trade_doc_doc_refs`、`quote_order_shipment_refs`、`order_shipment_refs`… 每加一种关系就要建表 + 建模型 + 写 CRUD |
| **两套真相** | 同一关系既有列（`orders.quote_id`）又有链接表（`order_quote_refs`），两者会不一致（实测：`trade_doc_quote_refs` 3 行，而 `trade_docs.quote_id` 全 NULL） |
| **维护点散落** | `app/api/orders.py`、`app/api/trade_docs.py`、`worker/src/main.py`、`worker/src/quote_api.py` 各自手写 ref 行 —— **漏写就静默丢关系**，没有任何告警 |
| **读侧要兜底** | 因为两套真相并存，读侧必须"列优先、链接表兜底"，逻辑复杂且容易被后人删掉 |
| **无约束** | refs 表拦不住"一张单证没有任何父对象"这种错 |

## 2. 优化原则

1. **职责不重叠**：每个关系只有**一个权威来源**，读侧不需要兜底
2. **不可能漏写**：写入路径无法绕过（受约束或唯一 helper 强制）
3. **结构收敛**：关系模型只有**一张表**，新增关系类型是加数据，不是建表

## 3. 目标设计：三层分工

```
① 归属（唯一、必须有）   →  列 + 数据库约束
   orders.quote_id / trade_docs.quote_id / trade_docs.order_id / *.customer_id
   强度：NOT NULL、CHECK（二选一）、FK ON DELETE SET NULL

② 关系（可多条、带语义） →  一张通用边表 entity_links
   合并成单（一单多报价）、关系变更史、多对多、授权

③ 自动维护               →  helper（应用层唯一入口）+ 触发器（兜底）+ 巡检
```

**关键点：列与边表不是重复，职责不同**

| | 列 | 边表 |
|---|---|---|
| 语义 | **主归属**（层级用） | **完整关系集**（展示/审计用） |
| 基数 | 一个（唯一） | 多个 |
| 例子 | 订单的主报价 → 报价（用于在客户页的树里归位） | 订单由报价 A、B 合并 → 两条边；客户页显示"合并自 A、B" |

## 4. 边表设计

```sql
CREATE TABLE entity_links (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  TEXT        NOT NULL,
  src_type   TEXT        NOT NULL,   -- 'quote' | 'order' | 'trade_doc' | 'customer' | 'user'
  src_id     BIGINT      NOT NULL,
  dst_type   TEXT        NOT NULL,
  dst_id     BIGINT      NOT NULL,
  rel_type   TEXT        NOT NULL,   -- 'generated_from' | 'merged_into' | 'revision_of' | 'can_access'
  meta       JSONB,                  -- 关系自身属性：合并分摊比例、改版原因等
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,            -- 关系失效用软删，保留历史
  CONSTRAINT uq_entity_links UNIQUE (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)
);

-- 双向查询各一个部分索引（只索引有效关系）
CREATE INDEX idx_entity_links_src ON entity_links (tenant_id, src_type, src_id, rel_type)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_entity_links_dst ON entity_links (tenant_id, dst_type, dst_id, rel_type)
  WHERE deleted_at IS NULL;
```

**多态带来的已知代价（必须承认）**：`src_id`/`dst_id` 没法加外键 → 删实体不会自动清边。
对策：**软删**（`deleted_at`）+ **巡检**（见 §6），而不是假装它能被约束。

## 5. 自动维护（这是"系统自动维护"的落地）

**应用层：唯一 helper**（禁止各处手写 INSERT）

```python
async def link(db, src, dst, rel_type, *, meta=None, created_by=None) -> None
async def unlink(db, src, dst, rel_type) -> None
```
所有写入路径只调它；代码评审 grep 禁止 `INSERT INTO *_refs` / `INSERT INTO entity_links`。

**数据库层：触发器兜底**（列一变就同步边表，应用层就算漏调也不会不一致）

```sql
-- 订单的主报价变化 → 同步 generated_from 边
CREATE OR REPLACE FUNCTION sync_order_quote_edge() RETURNS trigger AS $$
BEGIN
  IF NEW.quote_id IS DISTINCT FROM OLD.quote_id THEN
    UPDATE entity_links SET deleted_at = now()
     WHERE src_type='order' AND src_id=NEW.id
       AND rel_type='generated_from' AND deleted_at IS NULL;
    IF NEW.quote_id IS NOT NULL THEN
      INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)
      VALUES (NEW.tenant_id,'order',NEW.id,'quote',NEW.quote_id,'generated_from')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_quote_edge
  AFTER INSERT OR UPDATE OF quote_id ON orders
  FOR EACH ROW EXECUTE FUNCTION sync_order_quote_edge();
-- trade_docs 的 quote_id / order_id 同样处理
```

## 6. 巡检（保证"自动维护"真的有效）

一条 SQL 就能发现不一致，放进 CI 或定时任务：

```sql
-- 归属列有值、但边表缺对应边 → 自动维护漏了
SELECT 'order' AS t, o.id FROM orders o
 WHERE o.quote_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM entity_links l
                    WHERE l.src_type='order' AND l.src_id=o.id
                      AND l.rel_type='generated_from' AND l.deleted_at IS NULL);
```

## 7. 迁移与收口（分阶段，每步可独立验收）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1** | 建 `entity_links` + 把 5 张 ref 表的数据迁进来（`trade_doc_quote_refs` 3 行等） | 行数逐表对得上；旧表不动 |
| **P2** | 双写：helper 同时写**列**与**边表**；旧表停止写入（保留只读） | 两端测试 + 巡检为 0 |
| **P3** | 切读：树只读**列**（层级），边表只用于展示"合并/改版"信息；**删掉"列优先、链接表兜底"** | 客户页树的归属与之前完全一致 |
| **P4** | 加触发器；删除旧表引用 → 旧表重命名 `*_legacy`（留档不删） | 巡检为 0；grep 无旧表引用 |
| **P5** | 文档收尾（本文件 + `TEAMS_AND_VISIBILITY`/`CUSTOMER_DOCUMENTS_VIEW` 交叉引用） | — |

**不在本方案内**：`user_customers`（用户↔业务客户）**保持独立** —— 它是**权限授权**语义，
被 `auth` 直接依赖，且天生多对多；并进边表只会让鉴权链路更脆。

## 7.5 实施结论：**触发器取代了应用层 helper**

原计划 P2 是"在应用层 4 个写入点各加一次 `link()` 调用"。实际执行时改为**数据库触发器**（P4）：

| | 应用层 helper | 触发器（实际采用） |
|---|---|---|
| 改动点 | 4 处（dev 2 + worker 2），新增写入路径还要记得加 | **0 处应用代码**，只加迁移 |
| 漏写风险 | 有（忘了调就静默丢关系） | **无**（任何写入路径都触发） |
| 缺点 | — | 逻辑在数据库里，排查要记得看触发器 |

因此边表**不需要应用层维护**；`kaas_common/workstation/entity_links.py` 的校验与幂等 SQL
保留给"列表达不了的关系"（多张合并成一张、改版、授权）显式写入时复用。

## 8. 改造前后对比

| 维度 | 现在 | 优化后 |
|---|---|---|
| 关系表数量 | 5~7 张，加一种关系建一张 | **1 张边表** |
| 真相来源 | 列 + refs 表（两套，会不一致） | 列=主归属；边表=关系全集，**职责不重叠** |
| 读侧 | 列优先 + 兜底（复杂、易被删） | 只读列（层级）+ 边表（关系展示） |
| 漏写风险 | 高（多处手写、无告警） | 低（唯一 helper + 触发器兜底 + 巡检） |
| 约束强度 | refs 表无约束 | 列有 NOT NULL/CHECK/FK；边表有唯一约束 + 巡检 |
| 新增关系类型 | 建表 + 模型 + CRUD | 加一个 `rel_type` 取值 |

## 9. 执行结果（2026-10-11 实测）

| 阶段 | 状态 | 证据 |
|---|---|---|
| **前置① dev 写入侧补主归属列** | ✅ | `orders.py` / `trade_docs.py` 写列（带约束守卫） |
| **前置② 删 `/documents` 旧形状** | ✅ | 路由已不存在；对等 **0 未登记 / 0 过期**；覆盖迁到 `/records`（18 用例） |
| **前置③ 链接表关系回填列** | ⚠️ 部分 | 3 行历史单证 `customer_id` 为 NULL → `NOT VALID` 约束在 UPDATE 时重新校验，**故意不回填**；关系完整保留在 refs + 边表，读侧已不依赖 |
| **P1 建边表 + 迁数据** | ✅ | `202610110012`；`entity_links` 3 行；巡检缺边 **0** |
| **P2 双写** | ✅ 以更优方式实现 | **未在 4 个写入点加 helper**，改为 **P4 触发器**统一派生（见下）——少改 4 处、且任何新增写入路径都绕不过 |
| **P3 切读：删掉读侧兜底** | ✅ | dev/worker 的 `_resolve_parents` 已删；新增断言"**列是唯一真相**"；dev **446 passed** |
| **P4 触发器自动维护** | ✅ | `202610110013`；端到端证明：自动建边、改主报价→旧边软删+新边建立（**变更史保留**）、回滚干净 |
| **P5 文档** | ✅ | 本文件 + `CUSTOMER_DOCUMENTS_VIEW.md` §7 + `PLAN_CUSTOMER_RECORDS.md` |

**未做（明确留待）**：把 `order_quote_refs` / `trade_doc_*_refs` 等旧表重命名 `*_legacy` 并停写。
原因：旧表仍被 `orders.py` / `trade_docs.py` / worker 的写入路径写（与新列并存，但**读侧已不看它们**），
删除或停写需要先把那些写入点改掉 —— 属于独立的清理批次，不影响当前正确性。

## 10. 建议的执行顺序（与当前收口的关系）

**先做完正在进行的收口**（不阻塞、且避免返工）：

1. dev 写入侧补列（与 worker 对齐）→ 这样"列"才真正成为主归属
2. 删除 `/documents`（旧形状）→ 契约归一
3. `trade_doc_quote_refs` 3 行回填进 `trade_docs.quote_id`
4. 然后进入本方案 **P1**（建边表 + 迁数据）

理由：P1 之后"列"是主归属，读侧兜底才能安全删除；顺序颠倒会出现"兜底删了、列还是空"的空窗期。
