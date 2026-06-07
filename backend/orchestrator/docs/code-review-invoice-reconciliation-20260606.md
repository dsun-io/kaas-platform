# 代码审查报告 — 发票工位 & 电商对账模块

| 项目 | 内容 |
|---|---|
| **审查日期** | 2026-06-06 |
| **审查范围** | commit `93ab661` + 未提交的工作区变更 |
| **审查方法** | 7 独立角度扫描 × 6 候选/角度 → 1 轮验证 (recall-biased) |
| **涉及文件** | 17 个新增文件 + 3 个修改文件（419 files, +64,320 / -1,019 行） |
| **审查结论** | 🔴 **有条件通过** — 10 个发现项，其中 2 个阻塞启动（P0），3 个阻塞发布（P1） |

---

> ## ⚠️ 分支拆分更新（2026-06-07）
> 
> 原混合分支 `feature/ecommerce-reconciliation` 已拆分为两个独立分支：
> - `feature/financial-workstation-clean` — 仅含发票工位（7 模型、1 API、1 Service、1 Schema、1 迁移）
> - `feature/ecommerce-reconciliation-clean` — 仅含电商对账（6 模型、1 API、1 Service、1 Schema、1 迁移）
> 
> 原混合分支已归档（commit `93ab661`），新分支已推送远程。
> **拆分未修复任何 bug**，10 个发现项分散在两个新分支中，详见下方各分支发现清单。

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [审查范围](#2-审查范围)
3. [发现项总览](#3-发现项总览)
4. [P0 — 阻塞启动](#4-p0--阻塞启动)
5. [P1 — 阻塞发布](#5-p1--阻塞发布)
6. [P2 — 需在下个迭代修复](#6-p2--需在下个迭代修复)
7. [P3 — 建议改进](#7-p3--建议改进)
8. [风险矩阵](#8-风险矩阵)
9. [修复计划](#9-修复计划)
10. [附录 A — 审查方法论](#附录-a--审查方法论)
11. [附录 B — 逐文件影响清单](#附录-b--逐文件影响清单)

---

## 1. 执行摘要

本次审查覆盖 `feature/ecommerce-reconciliation` 分支上新增的**发票工位（Financial Workstation）**和**电商对账（E-commerce Reconciliation）**两个模块。审查采用 7 独立角度（逐行扫描、删除行为审计、跨文件追踪、复用检查、简化检查、效率检查、架构深度检查），共产出约 35 个候选发现，经去重和一轮验证后保留 **10 个确认发现**。

**核心结论**:

- 🔴 **2 个 P0 问题**会导致应用无法启动（断裂导入 + 语法错误）
- 🟠 **3 个 P1 问题**会导致运行时数据丢失或错误码篡改
- 🟡 **2 个 P2 问题**涉及安全纵深防御缺失
- 🟢 **3 个 P3 问题**为代码质量和合规改进建议

**当前工作区状态**: 有 3 个文件的未提交变更（`models.py` 删除 632 行、`main.py` 删除路由注册、`sidebar.tsx` 删除导航），这些变更导致了最严重的 P0 问题 — 模型类被删除但依赖文件未清理。

---

## 2. 审查范围

### 2.1 变更清单

| 类型 | 文件 | 行数 | 说明 |
|---|---|---|---|
| **API 路由** | `app/api/invoice.py` | 342 | 发票工位 REST API（16 个端点） |
| **API 路由** | `app/api/reconciliation.py` | 224 | 电商对账 REST API（11 个端点） |
| **Service** | `app/services/invoice_service.py` | 719 | 发票业务逻辑（状态机 + 审计） |
| **Service** | `app/services/reconciliation_service.py` | 431 | 对账匹配引擎 |
| **Schema** | `app/schemas/invoice.py` | 360 | 发票 Pydantic 模型（14 个 schema） |
| **Schema** | `app/schemas/reconciliation.py` | 200 | 对账 Pydantic 模型（10 个 schema） |
| **Model** | `app/db/models.py` | +632→-632 | 13 个 ORM 模型（已从工作区删除） |
| **Migration** | `alembic/versions/202605230001_*` | 268 | 发票工位表 + 触发器 |
| **Migration** | `alembic/versions/202605230002_*` | 182 | 对账表 |
| **Frontend** | `frontend/src/app/(app)/invoice/*` | 5 页面 | 发票工位前端页面 |
| **Frontend** | `frontend/src/app/(app)/reconciliation/*` | 1 页面 | 对账前端页面 |
| **Frontend** | `frontend/src/components/layout/sidebar.tsx` | +26→-26 | 侧边栏导航（已从工作区删除） |

### 2.2 审查方法

采用 7 个独立审查角度，每个角度产出最多 6 个候选发现：

| 角度 | 目标 | 方法 |
|---|---|---|
| A. 逐行扫描 | 逻辑错误 | 逐行读 diff + 包围函数 |
| B. 删除行为审计 | 被删除的保护机制 | 对比删除行与新代码 |
| C. 跨文件追踪 | 接口断裂 | 追踪导入链、调用链 |
| D. 复用检查 | 重复实现 | Grep 已有工具函数 |
| E. 简化检查 | 不必要的复杂度 | 识别死代码、冗余逻辑 |
| F. 效率检查 | 性能浪费 | N+1、内存、索引 |
| G. 架构深度 | 抽象层级 | 状态机、策略模式、迁移 |

所有候选发现经过一轮验证（CONFIRMED / PLAUSIBLE / REFUTED），仅保留 CONFIRMED 和 PLAUSIBLE。

---

## 3. 发现项总览

| # | 优先级 | 发现 | 文件 | 行 | 安全 | 数据 | 可用性 |
|---|---|---|---|---|---|---|---|
| 1 | 🔴 P0 | 孤儿文件断裂导入 | 4 文件 | — | — | — | 🔴 |
| 2 | 🔴 P0 | `list_templates` 语法错误 | invoice_service.py | 593 | — | — | 🔴 |
| 3 | 🟠 P1 | `except Exception` 吞掉 HTTPException | reconciliation_service.py | 332→374 | — | 🟠 | 🟠 |
| 4 | 🟠 P1 | 字段名不匹配 | invoice_service.py / schemas/invoice.py | 292 / 68 | — | 🟠 | — |
| 5 | 🟠 P1 | 类型不匹配 List vs Dict | reconciliation_service.py / schemas/reconciliation.py | 206 / 116 | — | 🟠 | — |
| 6 | 🟡 P2 | 租户隔离无纵深防御 | invoice.py / tenant.py | 18 / 53 | 🟡 | 🟡 | — |
| 7 | 🟡 P2 | LIKE 通配符未转义 | invoice_service.py | 605 | 🟡 | — | — |
| 8 | 🟡 P2 | 模型删除无 drop migration | models.py / alembic/ | — | — | 🟡 | — |
| 9 | 🟢 P3 | 对账差异解决无审计日志 | reconciliation_service.py | 409 | — | 🟢 | — |
| 10 | 🟢 P3 | 死代码 | invoice_service.py | 593-637 | — | — | 🟢 |

---

## 4. P0 — 阻塞启动

### 发现 #1：孤儿文件断裂导入

**严重程度**: 🔴 P0 — 应用无法启动
**验证状态**: ✅ CONFIRMED
**影响文件**:

| 文件 | 断裂点 |
|---|---|
| `app/services/invoice_service.py:24-31` | 导入 7 个已删除的模型类 |
| `app/services/reconciliation_service.py:18-25` | 导入 6 个已删除的模型类 |
| `app/api/invoice.py:37` | 导入 `InvoiceService`（间接触发上述断裂） |
| `app/api/reconciliation.py:34` | 导入 `ReconciliationService`（间接触发上述断裂） |

**根因**: 未提交的工作区变更删除了 `models.py` 中 13 个 ORM 模型类和 `main.py` 中的路由注册，但未清理上述 4 个依赖文件。

**错误表现**:
```
ImportError: cannot import name 'InvoiceRequest' from 'app.db.models'
```

**当前状态**: 由于 `main.py` 不再导入这些路由模块，**正常启动路径不受影响**。但任何触及这些模块的操作（测试、lint、脚本、未来重新注册路由）将立即崩溃。

**证据**:
```python
# invoice_service.py:24-31 — 导入已删除的类
from app.db.models import (
    InvoiceRequest,          # ← models.py 中不存在
    InvoiceRecord,           # ← models.py 中不存在
    CustomerInvoiceHeader,   # ← models.py 中不存在
    InvoicePlatformConfig,   # ← models.py 中不存在
    InvoiceTemplate,         # ← models.py 中不存在
    FinancialWorkstationSession,  # ← models.py 中不存在
    InvoiceAuditLog,         # ← models.py 中不存在
)
```

```python
# models.py 当前内容（824 行）以 AttributeProposal 结束
# 以下类全部已删除：InvoiceRequest, InvoiceRecord, CustomerInvoiceHeader,
# InvoicePlatformConfig, InvoiceTemplate, FinancialWorkstationSession,
# InvoiceAuditLog, ReconciliationReport, ReconciliationDiff,
# EcommercePlatformConfig, LogisticsProviderConfig,
# PlatformOrderStaging, LogisticsBillStaging
```

**修复方案**: 见 [修复计划 §9.1](#91-发现-1--孤儿文件)

---

### 发现 #2：`list_templates` 语法错误

**严重程度**: 🔴 P0 — 模块无法加载
**验证状态**: ✅ CONFIRMED
**影响文件**: `app/services/invoice_service.py:593-601`

**根因**: `and_()` 表达式后跟一个悬空的 `.`，链入注释行，形成无效 Python 语法。

**证据**:
```python
# invoice_service.py:592-608
if q:
    stmt = stmt.where(
        and_(                                          # ← 表达式开始
            InvoiceTemplate.tenant_id == tenant_id,
            InvoiceTemplate.status == "active",
        ).                                             # ← 悬空的 `.` — 语法错误
        # 简单搜索：nickname / tax_code_name / synonyms  ← 注释不能被属性访问
        # 更复杂的搜索应使用 PostgreSQL tsvector
        # 这里用 OR 条件简化
    )                                                  # ← and_() 表达式未闭合
    from sqlalchemy import or_                         # ← 内联导入（应在文件顶部）
    stmt = stmt.where(
        or_(
            InvoiceTemplate.nickname.ilike(f"%{q}%"),  # ← 未转义 LIKE 通配符（见 #7）
            InvoiceTemplate.tax_code_name.ilike(f"%{q}%"),
        )
    )
```

**额外问题**:
- `and_()` 块（lines 594-601）是死代码 — `tenant_id` 和 `status` 已在 lines 586-588 过滤
- `synonyms` 字段在注释中提及但未包含在 `or_()` 搜索中
- `or_` 的内联导入违反 PEP 8

**修复方案**: 见 [修复计划 §9.2](#92-发现-2--语法错误)

---

## 5. P1 — 阻塞发布

### 发现 #3：`except Exception` 吞掉 HTTPException

**严重程度**: 🟠 P1 — 错误码篡改 + 状态腐蚀
**验证状态**: ✅ CONFIRMED
**影响文件**: `app/services/reconciliation_service.py:271-378`

**根因**: `run_reconciliation` 方法的 `try` 块中（line 271），对不支持的匹配策略抛出 `HTTPException(400)`（line 332），但外层 `except Exception`（line 374）捕获所有异常，将其转为 `HTTPException(500)`。

**错误链**:
```
客户端请求 matching_strategy="fuzzy"
  → line 332: raise HTTPException(400, "not implemented")
    → line 374: except Exception 捕获
      → line 375: report.status = "failed"  ← 状态被永久腐蚀
      → line 376: await self.db.commit()    ← 写入数据库
      → line 378: raise HTTPException(500)  ← 状态码被篡改
```

**影响**:
1. 客户端收到 500 而非 400 — 违反 HTTP 语义
2. 报告状态被永久设为 `failed`，无法重试（line 265 只阻止 `running`，不阻止 `failed`）
3. 500 响应的 `detail` 泄露内部错误信息：`f"Reconciliation failed: {str(e)}"`

**修复方案**: 见 [修复计划 §9.3](#93-发现-3--异常处理)

---

### 发现 #4：字段名不匹配 — 平台配置 ID 永久丢失

**严重程度**: 🟠 P1 — 数据丢失
**验证状态**: ✅ CONFIRMED
**影响文件**:
- `app/services/invoice_service.py:292`（写入端）
- `app/schemas/invoice.py:68`（读取端）
- `app/db/models.py:884`（ORM 列定义）

**根因**: ORM 模型列名是 `invoice_platform_config_id`，service 写入时使用了错误的属性名 `platform_config_id`。

**证据**:
```python
# models.py:884 — ORM 列名
invoice_platform_config_id = Column(BigInteger, ForeignKey("invoice_platform_configs.id"))

# invoice_service.py:292 — 错误的属性名
req.platform_config_id = data.platform_config_id  # ← 不是 ORM 映射列

# schemas/invoice.py:68 — 使用正确的 ORM 列名
invoice_platform_config_id: Optional[int]  # ← 从 ORM 读取
```

**影响**: SQLAlchemy 允许在 ORM 实例上设置任意 Python 属性（不报错），但 `platform_config_id` 不是映射列，不会被持久化到数据库。通过 API 读取时，`InvoiceRequestOut`（`from_attributes=True`）查找 `invoice_platform_config_id`，该列始终为 `None`。

**修复方案**: 见 [修复计划 §9.4](#94-发现-4--字段名不匹配)

---

### 发现 #5：类型不匹配 — List vs Dict

**严重程度**: 🟠 P1 — 序列化失败
**验证状态**: ⚠️ PLAUSIBLE（取决于 Pydantic 严格模式配置）
**影响文件**:
- `app/services/reconciliation_service.py:191-206`（构建端）
- `app/schemas/reconciliation.py:116-118`（声明端）

**根因**: Service 将 `platform_config_snapshot` 构建为 `List[dict]`，但 schema 声明为 `Optional[Dict[str, Any]]`。

**证据**:
```python
# reconciliation_service.py:191-194 — 构建为 list
platform_snapshot = [
    {"id": p.id, "name": p.platform_name, "display_name": p.platform_display_name}
    for p in platforms
]

# schemas/reconciliation.py:116 — 声明为 dict
platform_config_snapshot: Optional[Dict[str, Any]]  # ← list 无法通过验证
```

**影响**: JSONB 列存储 list 无问题，但 Pydantic v2 序列化时（`from_attributes=True`）读取到 Python `list`，尝试验证为 `Dict` 类型。在 strict mode 下抛出 500；在 lax mode 下可能静默截断数据。

**修复方案**: 见 [修复计划 §9.5](#95-发现-5--类型不匹配)

---

## 6. P2 — 需在下个迭代修复

### 发现 #6：租户隔离无纵深防御

**严重程度**: 🟡 P2 — 安全风险
**验证状态**: ✅ CONFIRMED
**影响文件**:
- `app/api/invoice.py:18`（导入但未调用）
- `app/api/reconciliation.py`（同上）
- `app/middleware/tenant.py:53-55`（内部用户跳过验证）

**根因**: `require_tenant_access` 在两个 API 文件中被导入但从未调用（零调用点）。租户隔离完全依赖 `TenantContextMiddleware`，但该中间件对 `internal` 用户跳过验证。

**攻击路径**:
```
1. 攻击者获取有效的 internal 用户 token
2. 发送请求头 X-Tenant-Id: target-tenant
3. TenantContextMiddleware 检测到 is_internal() → 跳过验证
4. request.state.tenant_id = "target-tenant"（来自请求头，未校验）
5. 端点信任 request.state.tenant_id，写入 target-tenant 的数据
```

**证据**:
```python
# tenant.py:53-55 — internal 用户跳过
if hasattr(request.state, "auth") and request.state.auth.is_internal():
    return await call_next(request)  # ← 直接放行，不校验 tenant_id

# invoice.py:18 — 导入但未调用
from app.core.auth_utils import require_tenant_access, require_internal
# grep 确认: require_tenant_access 在 invoice.py 中零调用点
```

**修复方案**: 见 [修复计划 §9.6](#96-发现-6--租户隔离)

---

### 发现 #7：LIKE 通配符未转义

**严重程度**: 🟡 P2 — 数据泄露
**验证状态**: ✅ CONFIRMED
**影响文件**: `app/services/invoice_service.py:605-606`

**根因**: 用户输入 `q` 直接插入 `ilike(f"%{q}%")`，未转义 `%`、`_`、`\` 字符。

**攻击示例**:
| 输入 `q` | 实际模式 | 效果 |
|---|---|---|
| `%` | `%%` → 匹配所有 | 返回该租户全部模板 |
| `_` | `%_%` → 任意单字符 | 返回几乎所有模板 |
| `\%` | `%\%%` → 字面 `%` | 正常（但未转义时 `\` 也被解释） |

**影响**: 不是 SQL 注入（SQLAlchemy 参数化），但绕过了搜索过滤，泄露租户范围内的全部数据。

**修复方案**: 见 [修复计划 §9.7](#97-发现-7--like-通配符)

---

### 发现 #8：模型删除无 drop migration

**严重程度**: 🟡 P2 — 架构不一致
**验证状态**: ✅ CONFIRMED
**影响文件**:
- `app/db/models.py`（13 个模型类已删除）
- `alembic/versions/`（无对应的 drop 迁移）

**根因**: 未提交的工作区变更删除了 13 个 ORM 模型类，但没有 Alembic 迁移来删除对应的数据库表。

**影响**:
1. 部署后数据库保留 13 张孤儿表（`invoice_requests`、`reconciliation_reports` 等）
2. `alembic upgrade head` 不会删除这些表
3. 未来的 `alembic downgrade` 可能尝试重建已存在的表，导致冲突
4. ORM 元数据与数据库 schema 不一致

**修复方案**: 见 [修复计划 §9.8](#98-发现-8--drop-migration)

---

## 7. P3 — 建议改进

### 发现 #9：对账差异解决无审计日志

**严重程度**: 🟢 P3 — 合规缺口
**验证状态**: ✅ CONFIRMED
**影响文件**: `app/services/reconciliation_service.py:409-431`

**根因**: `resolve_diff` 方法修改 `resolution_status`、`resolved_by_user_id`、`resolved_at`、`resolution_notes` 后直接 commit，无任何审计日志写入。

**对比**: 同项目的 `invoice_service.py` 实现了完整的哈希链审计日志（`_audit` 方法，line 130），在 8 个业务操作点写入审计记录。

**影响**: 对账差异的解决是财务关键操作。无审计日志意味着无法追溯"谁在什么时间将什么差异标记为已解决"，不满足 SOX/合规要求。

**修复方案**: 见 [修复计划 §9.9](#99-发现-9--审计日志)

---

### 发现 #10：死代码

**严重程度**: 🟢 P3 — 维护误导
**验证状态**: ✅ CONFIRMED
**影响文件**: `app/services/invoice_service.py`

**子问题**:

| 位置 | 问题 |
|---|---|
| `lines 593-601` | `and_()` 构建冗余 WHERE 条件（已在 lines 586-588 过滤），从未应用到查询 |
| `line 634` | `now = datetime.now(timezone.utc)` 赋值后未使用 |
| `line 622` | `auth: AuthContext` 参数接受后未使用 |
| `lines 635-637` | `for item in items: pass` — 循环体为空操作 |

**影响**: 开发者阅读代码时误以为超时检查已实现（注释声称"懒检查超时"），实际未执行任何逻辑。`get_todo_list` 返回的待办列表可能包含已过期的工位分配。

**修复方案**: 见 [修复计划 §9.10](#910-发现-10--死代码)

---

## 8. 风险矩阵

```
影响 ↑
     │
  严重 │  #6 租户隔离    #1 断裂导入
     │                 #2 语法错误
     │
  高   │  #7 LIKE转义    #3 异常吞掉
     │                 #4 字段名不匹配
     │                 #5 类型不匹配
     │
  中   │  #8 无drop迁移
     │
  低   │  #9 无审计日志  #10 死代码
     │
     └──────────────────────────────────→ 发生概率
          低          中          高
```

**综合评估**:
- 当前工作区状态下，#1 和 #2 为 **确定性触发**（概率=1），但正常启动路径因路由未注册而暂时不受影响
- #3 在用户请求不支持的匹配策略时 **确定触发**
- #4 在每次确认发票请求时 **确定触发**（平台配置 ID 永久丢失）
- #6 需要攻击者获取 internal token，概率中等但影响严重

---

## 9. 分支级发现清单（拆分后）

### `feature/financial-workstation-clean`（发票工位）

| # | 优先级 | 发现 | 文件 | 行 |
|---|---|---|---|---|
| 2 | 🔴 P0 | `list_templates` 语法错误 | `invoice_service.py` | 593 |
| 4 | 🟠 P1 | 字段名不匹配（`platform_config_id` → `invoice_platform_config_id`） | `invoice_service.py` | 292 |
| 7 | 🟡 P2 | LIKE 通配符未转义 | `invoice_service.py` | 605 |
| 6 | 🟡 P2 | 租户隔离无纵深防御（`require_tenant_access` 零调用） | `api/invoice.py` | 全部端点 |
| 10 | 🟢 P3 | 死代码（`and_()` 死块、未使用变量、空循环） | `invoice_service.py` | 593-637 |

### `feature/ecommerce-reconciliation-clean`（电商对账）

| # | 优先级 | 发现 | 文件 | 行 |
|---|---|---|---|---|
| 3 | 🟠 P1 | `except Exception` 吞掉 HTTPException | `reconciliation_service.py` | 371 |
| 5 | 🟠 P1 | 类型不匹配（List[dict] → Dict） | `reconciliation_service.py` / `schemas/reconciliation.py` | 191 / 116 |
| 6 | 🟡 P2 | 租户隔离无纵深防御（未导入 `require_tenant_access`） | `api/reconciliation.py` | 全部端点 |
| 9 | 🟢 P3 | 对账差异解决无审计日志 | `reconciliation_service.py` | 423 |

### 已消失的问题（拆分后不再适用）

| # | 原因 |
|---|---|
| #1 孤儿文件断裂导入 | 拆分后各分支模型与依赖文件一致，无断裂 |
| #8 模型删除无 drop migration | 拆分后未删除任何模型，该问题不适用 |

---

## 9. 修复计划

### 9.1 发现 #1 — 孤儿文件

**方案 A（推荐）: 完成回退，删除所有孤儿文件**

```bash
# 后端
rm backend/orchestrator/app/services/invoice_service.py
rm backend/orchestrator/app/services/reconciliation_service.py
rm backend/orchestrator/app/api/invoice.py
rm backend/orchestrator/app/api/reconciliation.py
rm backend/orchestrator/app/schemas/invoice.py
rm backend/orchestrator/app/schemas/reconciliation.py

# 前端
rm -rf frontend/src/app/\(app\)/invoice/
rm -rf frontend/src/app/\(app\)/reconciliation/
```

**方案 B: 保留功能，恢复模型**

```python
# models.py 末尾重新添加 13 个模型类
# main.py 恢复路由注册
from app.api.invoice import router as invoice_router
from app.api.reconciliation import router as reconciliation_router
app.include_router(invoice_router)
app.include_router(reconciliation_router)
# sidebar.tsx 恢复导航组
```

**验证**:
```bash
# 确认无残留引用
grep -r "invoice_service\|reconciliation_service" \
  backend/orchestrator/app/ --include="*.py" | grep -v __pycache__
# 预期: 无输出（方案 A）或仅路由文件引用（方案 B）

# 确认可启动
cd backend/orchestrator && python -c "from app.main import app; print('OK')"
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

### 9.2 发现 #2 — 语法错误

**修复代码**:
```python
# invoice_service.py — 替换 lines 592-608
if q:
    from sqlalchemy import or_
    stmt = stmt.where(
        or_(
            InvoiceTemplate.nickname.ilike(f"%{escape_like(q)}%", escape="\\"),
            InvoiceTemplate.tax_code_name.ilike(f"%{escape_like(q)}%", escape="\\"),
            InvoiceTemplate.synonyms.any(escape_like(q)),
        )
    )
```

**依赖**: 需先实现 `escape_like` 函数（见 §9.7）。

**验证**:
```bash
cd backend/orchestrator
python -c "from app.services.invoice_service import InvoiceService; print('OK')"
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

### 9.3 发现 #3 — 异常处理

**修复代码**:
```python
# reconciliation_service.py — 替换 lines 374-378
except HTTPException:
    raise  # 透传已知业务异常，不篡改状态码
except Exception as e:
    report.status = "failed"
    await self.db.commit()
    logger.error("reconciliation_failed", report_id=report_id, error=str(e))
    raise HTTPException(status_code=500, detail="Reconciliation failed: internal error")
```

**验证**:
```python
# 测试用例
async def test_unimplemented_strategy_returns_400():
    response = await client.post("/api/v1/reconciliation/reports/1/run",
        json={"matching_strategy": "fuzzy"})
    assert response.status_code == 400  # 之前返回 500
    assert "not implemented" in response.json()["detail"]
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

### 9.4 发现 #4 — 字段名不匹配

**修复代码**:
```python
# invoice_service.py:292 — 修正属性名
req.invoice_platform_config_id = data.platform_config_id  # 匹配 ORM 列名
```

**验证**:
```bash
# 创建确认请求后读取
curl -X GET /api/v1/invoice/requests/{id} | jq '.invoice_platform_config_id'
# 预期: 非 null（之前为 null）
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

### 9.5 发现 #5 — 类型不匹配

**修复代码**（方案 A — 修改 schema）:
```python
# schemas/reconciliation.py:116-118
platform_config_snapshot: Optional[List[Dict[str, Any]]]   # list 而非 dict
logistics_config_snapshot: Optional[List[Dict[str, Any]]]  # list 而非 dict
```

**验证**:
```bash
curl -X GET /api/v1/reconciliation/reports/{id} | jq '.platform_config_snapshot | type'
# 预期: "array"（之前报 500 或返回 null）
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

### 9.6 发现 #6 — 租户隔离

**修复代码**:

1. 在 `app/api/deps.py` 中新增依赖项:
```python
from fastapi import Request, HTTPException, Depends
from app.core.auth import AuthContext, get_auth_context
from app.core.auth_utils import require_tenant_access

async def get_tenant_id(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> str:
    """提取并校验 tenant_id — 替代手动提取 + require_tenant_access 调用。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=401, detail="tenant_id missing")
    require_tenant_access(auth, tenant_id)  # 纵深防御
    return tenant_id
```

2. 替换所有端点中的手动提取（27 处）:
```python
# 之前:
tenant_id = getattr(request.state, "tenant_id", None)
if not tenant_id:
    raise HTTPException(status_code=400, detail="tenant_id missing")

# 之后:
async def create_invoice_request(
    data: InvoiceRequestCreate,
    tenant_id: str = Depends(get_tenant_id),  # 自动提取 + 校验
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
```

**验证**:
```python
# 测试 internal 用户无法伪造 tenant_id
async def test_internal_user_cannot_spoof_tenant():
    headers = {"Authorization": f"Bearer {internal_token}", "X-Tenant-Id": "evil-tenant"}
    response = await client.post("/api/v1/invoice/requests", headers=headers, json={...})
    assert response.status_code == 403  # require_tenant_access 拒绝
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

### 9.7 发现 #7 — LIKE 通配符

**修复代码**:

1. 在 `app/core/sanitizer.py` 中新增:
```python
def escape_like(value: str) -> str:
    """转义 SQL LIKE 通配符 % _ 和转义符 \\。"""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
```

2. 在 `invoice_service.py` 中使用:
```python
from app.core.sanitizer import escape_like

InvoiceTemplate.nickname.ilike(f"%{escape_like(q)}%", escape="\\"),
InvoiceTemplate.tax_code_name.ilike(f"%{escape_like(q)}%", escape="\\"),
```

**验证**:
```python
async def test_like_wildcard_escaped():
    # 创建模板 "test%item"
    response = await client.get("/api/v1/invoice/templates?q=%")
    # 应返回空结果（而非全部模板）
    assert len(response.json()["items"]) == 0
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

### 9.8 发现 #8 — Drop Migration

**修复代码**:

```bash
cd backend/orchestrator
alembic revision --autogenerate -m "drop_financial_and_reconciliation_tables"
```

如果 autogenerate 无法检测（模型已删除），手动编写:
```python
"""drop financial and reconciliation tables

Revision ID: <auto>
Revises: 202605230002
"""
from alembic import op

revision = "<auto>"
down_revision = "202605230002"

def upgrade():
    # 按外键依赖顺序删除
    for table in [
        "invoice_audit_logs",
        "financial_workstation_sessions",
        "invoice_templates",
        "invoice_records",
        "invoice_requests",
        "customer_invoice_headers",
        "invoice_platform_configs",
        "reconciliation_diffs",
        "platform_order_staging",
        "logistics_bill_staging",
        "reconciliation_reports",
        "ecommerce_platform_configs",
        "logistics_provider_configs",
    ]:
        op.drop_table(table)

    # 删除触发器和函数
    op.execute("DROP TRIGGER IF EXISTS trg_invoice_record_immutable ON invoice_records")
    op.execute("DROP FUNCTION IF EXISTS prevent_invoice_record_mutation()")

def downgrade():
    # 调用 202605230001 和 202605230002 的 upgrade 逻辑重建表
    pass  # 根据实际需求实现
```

**验证**:
```bash
alembic upgrade head     # 确认表被删除
alembic downgrade -1     # 确认表被重建
psql -c "\dt" | grep invoice  # 确认无残留
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

### 9.9 发现 #9 — 审计日志

**修复代码**:
```python
# reconciliation_service.py:resolve_diff 方法中添加审计写入
async def resolve_diff(self, tenant_id, diff_id, data, auth):
    ...
    previous_status = diff.resolution_status

    diff.resolution_status = data.resolution_status
    diff.resolved_by_user_id = auth.user_id
    diff.resolved_at = datetime.now(timezone.utc)
    diff.resolution_notes = data.resolution_notes

    # 审计日志（复用 events 基础设施）
    from app.repositories.events import insert_event
    await insert_event(
        self.db,
        tenant_id=tenant_id,
        event_type="reconciliation_diff_resolved",
        payload={
            "diff_id": diff_id,
            "previous_status": previous_status,
            "new_status": data.resolution_status,
            "resolved_by": auth.user_id,
            "notes": data.resolution_notes,
        },
    )

    await self.db.commit()
    return diff
```

**验证**:
```bash
# 解决差异后检查事件表
psql -c "SELECT * FROM events WHERE event_type='reconciliation_diff_resolved' ORDER BY created_at DESC LIMIT 5"
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

### 9.10 发现 #10 — 死代码

**修复代码**:
```python
# invoice_service.py — 删除 lines 593-601 的死 and_() 块（见 §9.2）

# invoice_service.py — 清理 get_todo_list
async def get_todo_list(
    self,
    tenant_id: str,
    status: str,
) -> dict:
    """获取工位待办列表。

    TODO: 实现超时检查 — 查询 workstation_session 表过滤过期分配。
    当前返回全部匹配状态的请求，不含超时过滤。
    """
    q = select(InvoiceRequest).where(
        InvoiceRequest.tenant_id == tenant_id,
        InvoiceRequest.status == status,
    ).order_by(desc(InvoiceRequest.created_at))

    result = await self.db.execute(q)
    items = result.scalars().all()
    return {"items": items, "total": len(items)}
```

**负责人**: _____ &nbsp;&nbsp; **截止日期**: _____

---

## 附录 A — 审查方法论

### A.1 审查角度详细说明

| 角度 | 扫描目标 | 典型发现 |
|---|---|---|
| **A. 逐行扫描** | 每行代码的输入/状态/时序/平台依赖 | 反转条件、off-by-one、空引用、缺少 await、错误变量拷贝 |
| **B. 删除行为审计** | diff 删除的每一行所保护的不变量 | 被移除的守卫、收窄的验证、删除的测试覆盖 |
| **C. 跨文件追踪** | 被改函数的所有调用者和被调用者 | 新前置条件、返回形状变更、新增异常 |
| **D. 复用检查** | 新代码是否重新实现了已有功能 | 已有工具函数、共享 schema、通用模式 |
| **E. 简化检查** | 不必要的复杂度 | 冗余状态、拷贝粘贴、深层嵌套、死代码 |
| **F. 效率检查** | 浪费的计算或 I/O | N+1 查询、冗余计算、缺失索引、顺序执行的独立操作 |
| **G. 架构深度** | 变更是否在正确的抽象层级实现 | 状态机完整性、策略模式、迁移完备性 |

### A.2 验证标准

| 判定 | 含义 | 条件 |
|---|---|---|
| **CONFIRMED** | 确定存在 | 从代码中可构造出触发路径 |
| **PLAUSIBLE** | 可能存在 | 依赖运行时状态，但状态现实可达 |
| **REFUTED** | 确定不存在 | 事实性错误、已被处理、纯风格无可观测影响 |

### A.3 统计

- 候选发现总数: ~35
- 去重后: 22
- 验证后保留: 10（CONFIRMED 9 + PLAUSIBLE 1）
- 验证后淘汰: 12（REFUTED 5 + 合并 7）

---

## 附录 B — 逐文件影响清单

| 文件 | 发现 # | 修复优先级 |
|---|---|---|
| `app/services/invoice_service.py` | 1, 2, 4, 7, 10 | P0, P0, P1, P2, P3 |
| `app/services/reconciliation_service.py` | 1, 3, 5, 9 | P0, P1, P1, P3 |
| `app/api/invoice.py` | 1, 6 | P0, P2 |
| `app/api/reconciliation.py` | 1, 6 | P0, P2 |
| `app/schemas/invoice.py` | 4 | P1 |
| `app/schemas/reconciliation.py` | 5 | P1 |
| `app/db/models.py` | 8 | P2 |
| `app/core/sanitizer.py` | 7（新增函数） | P2 |
| `app/api/deps.py` | 6（新增依赖项） | P2 |
| `alembic/versions/` | 8（新增迁移） | P2 |

---

## 签署

| 角色 | 姓名 | 日期 | 签署 |
|---|---|---|---|
| 审查人 | | | |
| 开发负责人 | | | |
| 安全审核 | | | |
| 项目经理 | | | |
