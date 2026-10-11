# 路由对等报告（orchestrator ↔ Worker · 2026-10-10）

> ⚠️ **数字已更新**：缺口 24 → 22，待补 13 → 11，worker 独有 12 → 8；
> `quote-profiles` 路径不一致与 `/auth/logout` 缺失均已修复。
> 当前问题状态以 [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) 为准。

> **结论**：Worker（生产）仍缺 orchestrator 的 24 条路由，但**客户 / 订单 / 报价 / 单证
> 四域中「前端会调用」的缺口已全部补齐** —— 本次共新增 25 条线上路由。
> 顺带修掉 3 个**已在生产会导致 500** 的既有缺陷（见下）。

## 为什么会有这个问题

生产 API 就是 Worker：`backend/worker/wrangler.jsonc` 把 `kaas.powervoy.com` 与
`api.kaas.powervoy.com` 都指向同一个 Worker，`deploy.yml` 的冒烟测试也打
`https://api.kaas.powervoy.com`。而开发在 orchestrator 里做，两边是**两套代码**。

`scripts/sync-shared.ps1 -Check` 只保证 **`kaas_common` 共享内核**一致，**管不到路由面**。
于是「本地加了接口、忘了同步 worker」没有任何自动防线 —— 本报告与
`scripts/route-parity.py` 就是补这道防线。

## 为什么之前没被发现

1. `deploy.yml` 的冒烟测试只探 **8 条**路由，都不在缺失集合里。
2. `wrangler.jsonc` 的 `assets.not_found_handling = "single-page-application"`
   —— 页面路由永远 200，页面能打开、只是数据请求失败，看起来像「空数据」。
3. 前端本地默认 `NEXT_PUBLIC_API_MODE=mock`，不接真实后端也能开发。

## 本次补齐（25 条）

### 第一批：产品配置化 / 权限矩阵 / 公章（11 条）

| 接口族 | 路由 | 实现 |
|---|---|---|
| 产品定义配置化 | `GET/POST /tenant-products`、`PUT/DELETE /tenant-products/{id}` | `backend/worker/src/ws_products.py` |
| 报价工位权限矩阵 | `GET/POST /workstation-products` | 同上 |
| 公司公章 | `GET/POST /tenant/company-seals`、`GET .../{id}/image`、`PUT .../{id}/default`、`DELETE .../{id}` | `backend/worker/src/ws_seals.py` |

公章能直接移植的关键：2026-09-30 的设计裁决把**图像处理全部挪到前端 Canvas**，
后端只用共享内核 `kaas_common.trade_doc.png` 的**纯 Python** IHDR 解析校验 ——
Worker（Pyodide）不需要 Pillow，行为与 orchestrator 天然一致。

同时补上**工位订阅校验**：报价工位按 `full_chain` 编码校验（生产租户 `default` /
`lianjia` 都已有该订阅行），未订阅 → 404 `SUBSCRIPTION_REQUIRED` 且**不写任何数据**；
两端编码逐字对齐（`app/api/subs.py` `WORKSTATION_CODES["quote"]` ↔ worker `QUOTE_SUB_CODES`）。

### 第二批：客户 / 订单 / 报价 / 单证 四域（14 条）

范围由「**前端实际调用的 API → 生产路由**」对照确定（脚本：`apiClient.*` 调用点
归一化后比对 worker 路由表），而不是凭路由表猜：

| 域 | 路由 | 实现 | 前端调用点 |
|---|---|---|---|
| 单证 | `GET /enums` | `ws_enums.py` | `use-trade-docs.ts:229` |
| 订单 | `GET/POST /shipments`、`GET/PATCH /shipments/{id}` | `ws_shipments.py` | `shipments/page.tsx` |
| 单证 | `POST /trade-docs/{id}/refresh-sources`、`/confirm`、`/translate` | `ws_docs_ext.py` | `use-trade-docs.ts:173` 等 |
| 客户 | `PATCH /customers/{id}`、`GET /customers/{id}/inquiries`、`GET /inquiries`、`PATCH /inquiries/{id}` | `ws_crm_ext.py` | — |
| 报价 | `POST /export-quote/rebate-rate/lookup`、`POST /export-quote/products/{key}/explain` | `ws_quote_ext.py` | — |

`GET /enums` 走的是**共享内核镜像**：`app/domain/enums.py` 由 `sync-shared.ps1` 第三段
复制成 `kaas_common/domain/enums.py`（同一份文件，不是手抄）——线上枚举少一个就是
「下拉里没有那个选项」这种无声故障。

## 顺带修掉的 3 个生产级缺陷（均非本次引入）

### P0｜单证 4 个端点运行期 `NameError` → 生产 500

`e5ab56e`「单证数据装配下沉共享内核」删掉了 `main.py` 里 11KB 的镜像实现，
**但 9 处调用点没跟着改**：`_doc_dict / _snap_rows / _seller_block / _buyer_block /
_clean / _order_snapshot / _quote_snapshot / _inquiry_snapshot` 在运行期根本不存在。

| 端点 | 之前 | 现在 |
|---|---|---|
| `POST /api/v1/trade-docs` | NameError 500 | ✅ |
| `GET /api/v1/trade-docs/{id}` | NameError 500 | ✅ |
| `PATCH /api/v1/trade-docs/{id}` | NameError 500 | ✅ |
| `GET /api/v1/trade-docs/{id}/render-data` | NameError 500 | ✅ |
| `GET /api/v1/tenant/company-profile` | NameError 500 | ✅ |

**静态检查发现不了**：这些名字只在函数体内被引用，Python 到调用时才解析。
修复方式是把装配助手抽成**单一实现** `backend/worker/src/doc_payload.py`
（main 与 `ws_docs_ext` 共用），并把 `seller_block` / `clean` 上收共享内核
（orchestrator 的 `company_profile.seller_block` 改为委托，避免又出现两份）。

修复过程中又暴露**同一条链上的第二个 500**：`render-data` 调
`build_render_data()` 少传了共享内核的**必填**关键字参数 `doc_status` → `TypeError`。
已补（`doc_status=doc.get("status")`）。

### P1｜10 处 `db.execute(..., table=...)` → `TypeError` 500

`platform/db.py` 的 `execute(request, sql, *args)` **不收 `table=`**（只有
`fetch/fetchrow` 收）。涉及的路径：单证 create/patch、订单状态与汇率回写、
付款计划、应收、企业主体 upsert。

已全部剔除该参数，并加了**静态守卫测试**（括号配平扫描 `src/*.py`），
防止后人再写出来。

### P2｜重复确认的口径冲突（测试期望不可达）

`tests/test_trade_docs_api.py` 里两个测试对「已 issued 再确认」期望互相矛盾：
一处期望 `NOT_DRAFT`（与实现一致），另一处期望 `ILLEGAL_TRANSITION`。
实现是 `assert_draft` 先行，`ILLEGAL_TRANSITION` 在该路径上不可达
（内核 `can_transition` 把同态视为合法）。已把测试改成 `NOT_DRAFT`，
与 Worker 的 `ws_docs_ext.confirm` 一致。

## 检查器用法（棘轮）

```bash
python scripts/route-parity.py           # 校验：未登记缺失 / 过期登记 → 退出码 1
python scripts/route-parity.py --list    # 只看差异
python scripts/route-parity.py --update  # 重写允许清单（写完必须人工补原因）
```

- **未登记缺失** = 真漂移 → CI 失败。
- **过期登记** = 清单里的路由 worker 其实已实现 → CI 失败（防棘轮漏掉下次漂移）。
- **worker 独有** = 只提示，不失败。
- 原因里含「待补」= 承认是缺口，脚本每次运行都单独打印成债务清单。

CI 接入：`.github/workflows/backend-test.yml`（`unit-tests` 的
`Route parity` 步骤 + `worker-tests` 作业跑 worker 全量测试）。

## 剩余缺口：24 条

### 有意不做（11 条，不算缺口）

平台运维：`/admin/deployment_audit`、`/admin/metrics/summary`、`/admin/cache/clear`、
`/admin/tenants/{id}`、`/admin/spec/attribute-proposals*`；
本地运行时探针：`/health/deep`、`/health/ready`；
Pyodide 跑不了：`POST /oss/presign`（阿里云 SDK 是 C 扩展）、
`POST /intel/collect/comtrade`（采集任务由本地定时器调度）。

### 待补（13 条）

- **认证（2）**：`POST /auth/register`、`POST /auth/logout`
  —— 前端 `auth-context.tsx` 会调用；属认证域，本轮的四个业务域之外。
- **规格库（11）**：`GET /product-specs`；`GET/POST /spec/attributes`、`.../search`、
  `.../{id}`、`.../{id}/values`；`GET/PATCH /spec/skus`、`.../{sku_id}`；
  `GET /spec/templates`、`.../{template_id}` —— 前端当前未直接调用。

## Worker 独有（12 条，反向漂移提示）

```
GET/POST/PATCH/DELETE /api/v1/export-quote/quote-profiles[/{profile_id}]   ← 见下方
GET/POST/PUT/PATCH/DELETE /api/v1/outreach/webhook                          ← 见下方
GET  /api/v1/subscriptions
GET  /api/v1/subscriptions/bundles
POST /api/v1/leads/crawl-batch
POST /api/v1/leads/{lead_id}/crawl
```

⚠️ **`quote-profiles` 是「同一功能、两个路径」**：Worker 在
`/api/v1/export-quote/quote-profiles`，orchestrator 在 `/api/v1/quote-profiles`
（`app/api/quote_profiles.py` 的 prefix 是 `/api/v1`，`main.py:148` 也没传 prefix）。
前端 `frontend/src/lib/export-quote/import-file.ts` 用的是 `/export-quote/quote-profiles`
—— 即**生产对、本地错**；`next.config.mjs` 没有对应 rewrite。
建议把 orchestrator 侧统一过去，否则本地联调会一直踩这个 404。

⚠️ **`outreach/webhook` 方法面不一致**：Worker 用
`@app.api_route(..., methods=["GET","POST","PUT","PATCH","DELETE"])`（`chain.py:1678`）
注册，orchestrator 只有 `POST` —— 线上比本地宽，安全面需复核。

## 另一处已知不一致（未在本次修，需产品决策）

worker 的**既有** `GET /api/v1/customers` / `GET /api/v1/customers/{id}` **不做归属过滤**，
而 dev（与新补的 `PATCH /customers/{id}`、`GET .../inquiries`）按 §10.3 过滤
（`owner_id = 我` 或 `owner_scope = 'tenant'`）。

线上实测：`customers` 表 3 行中有 2 行 `owner_id IS NULL`，且存在 2 个
`account_type='customer'` 的账号 —— 这些账号打开上述新接口会得到 404，
而列表里却看得见（**"列表里有、点进去没有"**）。

本次只做了**无回归**的那一半：让 `POST /api/v1/customers` 像 dev 一样写
`owner_id` / `owner_scope`（否则新建的客户必然复现同一矛盾），
**没有**给既有读接口加过滤（那会让成员账号看不到存量客户，属数据可见性变更）。

彻底一致的两条路（需产品决策）：
1. 把 worker 既有读接口也加上 §10.3 过滤（会隐藏 `owner_id` 为 NULL 的存量客户）；
2. 或给存量客户回填 `owner_id`（数据迁移），然后两端统一。

附带：worker 的 `_can_see_all` 只认 `role == "system_admin"`，而 dev 的
`effective_role` 把历史 `'admin'` 也映射成 `system_admin`。线上现有账号都是
`system_admin` / `owner`，暂不受影响；若将来出现 legacy `'admin'` 账号，
它会按普通成员处理（与 orders / quote_api 的既有口径一致，改动需三处同改）。

## 检查器已知边界

- 只做**静态解析**：`@router.x("/y")`、`@app.x("/y")`、
  `@app.api_route("/y", methods=[...])` 三种写法都覆盖；`app.mount()` /
  `add_api_route()` 动态注册不在覆盖范围（当前代码库没有这两种用法）。
- **`api_route` 这种写法最初漏掉过**，后果是检查器既会误报缺口、也会掩盖真漂移
  —— 修好后棘轮立刻抓出 `POST /api/v1/outreach/webhook` 是过期登记，
  这正是「过期登记必须失败」这条规则的价值。

## 验证方式

除单元测试外，本次所有新增/修改的 SQL 都拿**真实数据库**做过 `PREPARE` 校验
（只编译不执行，不写数据）：出运台账 10 条 + 客户/询盘 9 条 + 单证/企业主体 20 条，
全部通过。

## 复现命令

```bash
python scripts/route-parity.py --list
```

（本次统计：orchestrator 189 条 / worker 177 条 / 允许清单 24 条 /
缺失已登记 24、未登记 0、过期登记 0、worker 独有 12、
其中原因含「待补」的 13 条）
