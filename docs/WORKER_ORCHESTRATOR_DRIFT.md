# 漂移审计报告：orchestrator（开发版） vs Worker（线上版）

> ⚠️ **本文数字口径已过期**：当时 `route-parity-audit.py` 只读 `worker/src/main.py`
> 一个文件，worker 现已拆成 18 个模块，故"A 类 33 / 线上 65"等数字失真
> （修正后：线上坏 6、反向漂移 8）。检查器已修复，结论以
> [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) 与
> `python scripts/route-parity.py` 为准。

> 审计日期：2026-09-26 ｜ 方法：静态路由比对（`scripts/route-parity-audit.py`，可复现）
> 触发原因：单证工位开发中发现"模板与渲染接口线上不存在"，遂做全量核对。
> 处置方案见：`docs/DUAL_BACKEND_CONVERGENCE.md`（双后端收敛方案）

---

## 一、结论摘要

| 指标 | 数值 |
|---|---|
| 开发版（orchestrator）接口 | **135** |
| 线上（worker/main.py）接口 | **65** |
| 前端实际调用点 | 86 |
| **开发版有、线上没有** | **80**（占开发版 **59%**） |
| **其中：前端正在调用 → 线上就是坏的** | **33** |
| **反向漂移：线上有、开发版没有** | **10**（代码只在单文件里，不在版本主线） |
| 前端调了、两个后端都没有 | 6（另有 8 项因前端用变量拼接路径无法静态判定） |

**一句话**：线上不是"开发版的一个子集"那么简单，而是**两边各自演化**——
开发版有一半功能上不去，线上又有 10 个功能在主线上不存在。**部署是自动的，代码同步是手工的。**

---

## 二、【A 类·最严重】前端在调、线上没有 → 用户点进去就是 404

**33 个**。这些不是"未上线的功能"，而是**前端入口已在、后端路由不在**的状态。

### A1. 认证相关（影响面最大）

| 接口 | 说明 |
|---|---|
| `POST /api/v1/auth/register` | 注册 |
| `POST /api/v1/auth/logout` | 登出 |

### A2. 整个工位不可用

| 域 | 接口数 | 明细 |
|---|---|---|
| **拓客 Leadgen** | 9 | `GET /leadgen/regions`·`/leadgen/runs`·`/leads`·`/leads/{}`、`POST /leadgen/runs`·`/leadgen/validate`·`/leads/scan-replied`、`PATCH /leads/{}` |
| **触达 Outreach** | 11 | `GET /outreach/campaigns`·`/outreach/mailboxes`·`/outreach/messages`·`/outreach/messages/{}`、`POST /outreach/campaigns`·`/outreach/campaigns/{}/send`·`/outreach/generate`·`/outreach/mailboxes`·`/outreach/mailboxes/{}/test`·`/outreach/messages/{}/retry`、`PATCH /outreach/mailboxes/{}` |
| **AI 配置** | 7 | `GET /ai/providers`·`/ai/tasks`·`/ai/usage`·`/ai/task-bindings`、`PUT /ai/providers/{}`·`/ai/task-bindings/{}`、`POST /ai/providers/{}/test` |

### A3. 影响其他链路的单点

| 接口 | 影响 |
|---|---|
| `POST /api/v1/oss/presign` | **事件上报的文件上传**（`lib/events/client.ts` 在调）→ 事件系统的附件能力可能是坏的 |
| `GET /api/v1/product-specs` | 规格数据页 |
| `GET /api/v1/admin/deployment_audit` | 灰度发布页 |
| `GET /api/v1/admin/spec/attribute-proposals/recommended`<br>`PATCH /api/v1/admin/spec/attribute-proposals/{}` | 规格提案审批页 |

> **判定要求**：A 类里有一部分可能"业务上尚未启用"（如拓客/触达仍在开发）。
> 那正确的处理不是补后端，而是**先摘掉前端入口或加灰发开关**，避免用户点进去报错。
> **需要 David 按业务状态标注 A1–A3 中哪些是"已启用"**（已启用的 = 真事故，优先修）。

---

## 三、【B 类·危险】反向漂移：线上在跑，但开发版主线没有

**10 个**。含义：**这些代码只存在于 `worker/src/main.py` 这个单文件里**。
一旦有人用开发版重新生成/覆盖 Worker，这些功能会**直接消失**。

| 接口 | 备注 |
|---|---|
| `GET /api/v1/market/name-lookup` | 市场名称映射 |
| `GET /api/v1/market/ports` | 港口库 |
| `GET /api/v1/market/regions` | 地区 |
| `GET /api/v1/market/regions/{}/products` | 地区产品 |
| `GET /api/v1/market/usages` | 用途 |
| `POST /api/v1/market/name-mappings` | 新增名称映射 |
| `GET /api/v1/spec/categories` | 规格分类 |
| `GET /api/v1/subscriptions` | 订阅 |
| `GET /api/v1/subscriptions/bundles` | 订阅套餐 |
| `PATCH /api/v1/customers/{}/stage` | ⚠️ **方法不一致**：开发版是 `POST`，线上是 `PATCH` |

> `customers/{}/stage` 这一条是**明确的契约分叉**：同一语义两个方法。
> 前端用哪个即决定哪边是"对的"——需核对（见 §六 待核项）。

---

## 四、【C 类】前端调了、两个后端都没有（死链）

**6 个**（已剔除解析瑕疵）：

| 接口 | 说明 |
|---|---|
| `GET /api/v1/research/stats`·`/research/categories`·`/research/products`·`/research/runs` | **市场调研工位整体没有后端** |
| `POST /api/v1/research/from-leadgen` | 同上 |
| `PATCH /api/v1/research/products/{}` | 同上 |
| `POST /api/v1/leads/crawl-batch`·`/leads/{}/crawl` | 爬取功能无后端 |
| `POST /api/v1/quote`（单数） | 疑似旧接口/笔误，待核 |

> 另有 8 项因前端用变量拼接路径（如 `` apiClient.get(`${base}/products`) ``）**静态分析拿不到真值**，
> 需运行时或人工核对：`/export-quote/products`、`/export-quote/rate-sets`、
> `/export-quote/import/preview|calculate`、`/export-quote/products/{}/import-template` 等。
> **据代码结构判断，`export-quote`（出口报价引擎 9 个接口）线上同样缺失**，
> 若「智能报价」页已开放，则该工位在线上不可用——**建议实测确认**（`GET /api/v1/export-quote/products` 返回 404 即证实）。

---

## 五、【D 类】开发版有、线上没有、前端未调用

约 **47 个**：`admin/metrics`、`enums`、`quotes`（旧报价 CRUD 5 个）、`shipments`（4 个）、
`spec/*`（attributes/skus/templates 若干）、`intel/collect/comtrade`、`health/deep|ready`、
`trade-doc-templates` + `trade-docs/{id}/render`（本次单证工位新增 3 个）等。

这类属于**正常的"未上线功能"**，按产品路线图排队即可，不是事故。

---

## 六、根因与待核项

### 根因（三层，缺一不可）

1. **运行时不兼容**：线上是 Pyodide（Python on WASM），`psycopg2`/`oss2`/`minio`/`openpyxl`
   等 C 扩展或重库**进不去**；Worker 还有**启动 CPU 限额**，依赖越多冷启动越久、超限会让 isolate
   启动失败 → 间歇 5xx（`ecf50ad` 修过此类问题）。
2. **没有共享层**：既没抽公共业务内核，也没有生成机制，于是每个接口都**手写两遍**
   （orchestrator 用 SQLAlchemy，worker 用裸 asyncpg）。
3. **没有门禁**：CI 只做部署，**不做一致性校验**，漂移无人拦截。

### 待核项（需实测/人工确认）

| # | 待核 | 判定方法 |
|---|---|---|
| 1 | `customers/{}/stage` 前端用 POST 还是 PATCH | 读前端调用点 → 决定哪边改 |
| 2 | `export-quote/*` 线上是否真缺失、智能报价页是否已开放 | `curl -s -o NUL -w "%{http_code}" https://api.kaas.powervoy.com/api/v1/export-quote/products`（404=缺失） |
| 3 | A 类 33 项中哪些"业务已启用" | 业务确认（非技术判断） |
| 4 | Worker 打包能否直接引用仓库内共享包 | 见联合方案 §3.1 前提验证 |

---

## 七、复现方式

```powershell
$py = "C:\Users\76516\AppData\Local\Programs\Python\Python312\python.exe"
cd d:\MyProject\kaas-platform
& $py scripts\route-parity-audit.py
```

脚本纯静态分析（只读源码，不连网、不碰数据库），可随时重跑做回归。
下一步会把它**转正为 CI 门禁**（见联合优化方案）。
