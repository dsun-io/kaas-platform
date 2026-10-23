# 历史订单批量导入（C29）· 设计 + 执行方案

> **状态**：2026-10-23 设计定稿，本轮施工（内核 + 门面 + 前端）。
> **关联**：`TODO.md` C29 / C19 / G-10；`API_RESERVED_LIST.md` C29；`PROBLEM_STATUS_2026-10-11.md` 顶部摘要。
> **入口**：订单页「导入已有数据」（原占位骨架，本轮接线）。

## 0. 背景与目标

- 现状：前端 `components/import-existing-data-dialog.tsx` 是占位骨架（选客户 + 选 CSV + 提交只弹提示），
  **后端没有批量导入接口**；订单/单证两页的入口此前因"空按钮"被移除（C29）。
- 目标：把系统外已有的**历史订单**一次录进系统，归属所选客户，**保留原始订单号**。
- 不在本轮：单证导入（依赖订单/文件/单证类型三要素，留 backlog）、XLSX（本次 CSV）。

## 1. 口径裁决（本轮落定，可复核）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 资源 = **仅订单**；单证导入登记后续 | 单证必须挂订单 + 类型 + 文件，超出"历史数据导入"最小闭环 |
| 2 | 文件 = **CSV（UTF-8，含表头）**，兼容 Excel 导出的 UTF-8-BOM | 前端骨架本来只收 CSV；内核有 `export_quote/xlsx.py` 可后续扩展 |
| 3 | 客户 = 表单**必选**；`source_type='direct'`、`inquiry_id=NULL` | DB CHECK `ck_orders_source_type`；历史单本来就没有询盘父对象 |
| 4 | **保留 CSV 的 `order_no`**（不走 `_next_customer_doc_no`） | 历史单号是业务事实；导入后客户/对账仍按原号 |
| 5 | 状态**如实选**（D-5），缺省 `pending`；枚举 = `ORDER_STATUS` | 线下补录不得伪造进度 |
| 6 | 币种：缺省 USD，必须在 `CURRENCY` 白名单 | 与既有枚举校验一致 |
| 7 | 金额 `total_amount`：可选 Decimal ≥ 0，缺省 **NULL（不伪造 0）** | 历史单可能只有单号 |
| 8 | **原子性：全有或全无**（单事务）；预览**零写入** | 避免半截导入无法收拾 |
| 9 | 权限：登录用户即可（与 `POST /orders` 一致）；API token 未声明 scope ⇒ 403（有意） | `/api/v1/imports` 不登记 token scope |

## 2. CSV 列（表头归一：去首尾空格、大小写不敏感）

| 列 | 必填 | 校验 |
|---|---|---|
| `order_no` | ✅ | 非空、≤64；**文件内唯一** + **库内（tenant）不存在** |
| `order_date` | ✅ | ISO `YYYY-MM-DD`（沿用 `parse_date`） |
| `status` | — | `ORDER_STATUS` 枚举，缺省 `pending` |
| `currency` | — | `CURRENCY` 枚举，缺省 `USD` |
| `total_amount` | — | Decimal ≥ 0，缺省 NULL |
| `notes` | — | 文本（≤2000） |

未知列：**忽略 + warning**（不阻断）。空文件 / 缺表头 / 缺必填列 ⇒ 422。

## 3. API 契约

### `POST /api/v1/imports/orders/preview`（multipart/form-data）

字段：`file`（CSV）、`customer_id`（int）。

```json
200 {
  "customer": {"id": 3, "name": "ACME"},
  "columns": ["order_no", "order_date", "status", "currency", "total_amount", "notes"],
  "rows": [
    {"index": 1, "ok": true,  "data": {"order_no": "SO-001", "order_date": "2026-05-01", "status": "completed", "currency": "USD", "total_amount": 1200.5, "notes": null}, "errors": []},
    {"index": 2, "ok": false, "data": null, "errors": ["order_no 已存在于本租户"]}
  ],
  "summary": {"total": 2, "ok": 1, "error": 1, "existing_order_nos": ["SO-009"]}
}
```

- 客户不存在 ⇒ 404；文件空/无表头 ⇒ 422；**不写任何库**。

### `POST /api/v1/imports/orders`（multipart/form-data）

同参。成功 ⇒ `201 {"created": N, "ids": [...], "order_nos": [...]}`，单事务提交。

- 任一错误行 ⇒ **422** `{"error":"validation","code":"IMPORT_HAS_ERRORS","rows":[{index,errors}]}`（零写入）
- `order_no` 撞库 ⇒ **409** `{"error":"conflict","code":"IMPORT_DUPLICATE_ORDER_NO","order_nos":[...]}`（整批回滚）
- 错误信封沿用既有 `{error, code, ...}`；detail 里的 message 可读

## 4. 分层落点

| 层 | 落点 | 要点 |
|---|---|---|
| 内核 | `backend/worker/src/imports_api.py`（新卫星模块，参照 `ws_products.py` 的注册方式） | 复用 `validate_enum`/`parse_date`/`_doc_customer`/`DEFAULT_TENANT`；stdlib `csv`（`utf-8-sig`）；单事务 INSERT `orders`（列见 main.py:4308-4316），`created_by=user.id`、`owner_scope='private'`、`team_id=customer.team_id` |
| 门面 | `backend/ts-worker/src/routes/imports.ts`（新） | 2 条路由**显式注册 + `forwardKernelRequest` 原样透传**（multipart 不解析、不重写）；`src/index.ts` 注册；route-surface 计数 277→**279** 业务（+4 内置 = **283**） |
| 前端 | `components/import-existing-data-dialog.tsx` 接线 + `orders/hooks/use-import-orders.ts` + 订单页入口 | 选客户 + CSV → **预览表**（错误行标红、原因可见）→ 全绿才可「确认导入」→ 成功 toast + invalidate 订单查询；失败展示后端原因（422/409 原样） |
| 文档 | TODO / API_RESERVED_LIST / PROBLEM_STATUS | C29 销账 + 新路由数登记 |

## 5. 验收（DoD）

- **内核**：预览（正常 / 缺列 / 空文件 / 坏日期 / 坏枚举 / 重复单号 / 不存在客户）、提交（成功 / 有错行 422 / 撞库 409 回滚 / 事务性）——≥ 12 条测试
- **门面**：新路由存在 + multipart 原样透传 + 未登录 401；路由面 **279 = 193+86**（+4 内置 = 283）；openapi/scope-map 同步
- **前端**：预览/错误行/全绿提交/取消/失败可见/客户必选 —— 组件测试 + mocks 契约测试；`mocks:check` 通过
- **全量门禁**：worker pytest、ts-worker typecheck/test、前端 typecheck/lint/test/contracts/mocks/ui:patterns/ui:contrast、e2e 不回归

## 6. 明确不做（登记，避免误判为欠账）

- 单证导入（`trade_docs` 依赖订单/类型/文件）→ backlog
- XLSX 导入（内核已有 `kaas_common/export_quote/xlsx.py` 可复用）→ 后续
- 导入触发询盘阶段推进 / 审批通知 / 业务事件（历史补录不产生新业务流水）
- 批量撤销导入（回滚 = 删除对应订单；不提供接口）
