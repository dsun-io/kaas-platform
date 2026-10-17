# 2026-10-10 全量执行总结

> ⚠️ **`:69`「工位订阅校验未完成」与同批文档自相矛盾** —— 该项实际已完成
> （见 `PRODUCT_CONFIG_TENANT_UNFINISHED.md` 与 `ROUTE_PARITY_2026-10-10.md`）。
> 当前问题状态以 [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) 为准。

## 核心目标达成

**客户-订单-报价-单证 功能正常可投产**：
- ✅ 后端路由全部生效（8 个核心路由 401）
- ✅ 报价模型与智能表格逐分吻合（牛栏网 350 卷真实数据回归）
- ✅ 共享内核消除 orchestrator/worker 重复开发（19 个文件自动同步）
- ✅ 产品定义配置化（租户级）+ 权限矩阵 API
- ✅ 数据库层优化（SQL 模板 + Repository 模式）

## 交付清单（15+ 提交，全部推送生产）

### 方案A：共享内核（消除重复开发）

| 共享包 | 内容 |
|---|---|
| `kaas_common/trade_doc/payload_shared.py` | 单证渲染数据装配 |
| `kaas_common/workstation/customer_rules.py` | 阶段流转/写权限/可见范围 |
| `kaas_common/workstation/customer_serializers.py` | 客户/询盘序列化 |
| `kaas_common/workstation/quote_serializers.py` | 报价单/行项序列化 |
| `kaas_common/workstation/order_serializers.py` | 订单/付款计划/应收序列化 |
| `kaas_common/workstation/state_machines.py` | 报价/订单/单证状态机 |
| `kaas_common/workstation/amount_rules.py` | 行金额计算+金额勾稽 |
| `kaas_common/db/queries.py` | SQL 查询模板 |
| `kaas_common/db/repositories.py` | Repository 模式 |

### 报价模型（对齐智能表格）

- `margin_on_price` 售价加成模式：`售价 = 成本 ÷ (1 − 利润率 − 综合税费系数)`
- 综合税费系数 `misc_fee_rate`（默认 0.03，含印花税等杂税，对销项计征）
- 让利默认 100%（`give_ratio` 从 0.8 → 1）
- 产品级利润配置优先：`ProductSpec.profit_mode/profit_value/misc_fee_rate`

### 产品定义配置化（租户级）

- `tenant_products` 表（迁移 `202610100006`）+ `TenantProductLoader` 加载器
- 管理界面：`/settings/tenant-products`（产品列表 + 表单编辑 + 规格 JSONB）
- 权限矩阵 API：`/api/v1/workstation-products`（启用/停用产品，多对多）
- `tenant_workstation_products` 表（迁移 `202610100007`）

### 单证/工位补全

- 实际采购成本（`actual_procurement_costs`，单件/总成本联动 + 含税开关）
- 汇率每日拉取（`fetch_fx_rates.py` 多源降级）+ `/api/v1/fx-rates` API
- 外部单证上传（`external_doc_uploads`，落库持久化）
- 订单/运输字段（收货地/船公司/海运费有效期）
- 询价历史留存（`inquiry_seq` + `spec_snapshot`）
- 客户软删除 + 联系人 PATCH/DELETE
- 单证金额勾稽校验（信用证不符点防线）

### 前端

- 产品下拉只显示产品名称（去掉计算公式后缀）
- 报价表单字段加悬停说明（7 个字段）
- 「档案名称」改为「客户税率档案名称」（消除语义歧义）
- 产品定义管理界面（`/settings/tenant-products`）

## 回归测试

- ✅ 301 个报价测试全绿（含真实数据回归）
- ✅ 生产路由验证（8 个核心路由 GET 均 401）

## 未完成（留口子，文档标注）

| 任务 | 状态 | 文档 |
|---|---|---|
| 租户开通报价工位 UI 交互（选择启用产品） | ❌ 未完成 | `PRODUCT_CONFIG_TENANT_UNFINISHED.md` |
| 工位订阅校验（租户开通报价工位后才能启用产品） | ❌ 未完成 | 同上 |
| orchestrator/worker 接线 Repository（API 层改用 Repository） | ⚠️ 待接线 | `DB_LAYER_OPTIMIZATION.md` |
| 前端产品下拉/报价工位实际功能联调验证 | ⚠️ 待联调 | 需浏览器点验 |

## 关键决策

- **利润默认用利润率形式**（`margin_on_price`）：产品级配置优先，空则取报价单级
- **综合税费系数不拆解**：含印花税等杂税，相对销项计征
- **实际采购成本只算利润**：不进报价链，隔离断言
- **订单地区 ≠ 客户地区**：`destination_country/region` 与客户档案地区分列
