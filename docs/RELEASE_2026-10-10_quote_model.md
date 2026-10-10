# 2026-10-10 报价模型 + 单证 + 工位补全（margin_on_price / 多产品手动干预 / 实际采购成本 / 外部单证）

## 背景

业务在用的智能表格「客户询盘跟进表」报价逻辑更成熟，但参数硬编码（0.97/0.03 税费系数、
利润率语义不清）；单证脚本每客户一份硬编码；kaas 报价模型（markup_on_cost）与业务口径冲突。
本次以智能表格口径为准改造 kaas 报价模型，并补齐单证/工位缺口。
**智能表格与单证脚本在产使用，本次未做任何改动**；kaas 是未来使用的重心。

## 报价模型（核心改动）

### margin_on_price 售价加成模式

```python
# pricing.py PricingPolicy 新增
profit_mode: str = "fixed"  # fixed | ratio | margin_on_price
misc_fee_rate: Any = 0  # 综合税费系数（默认 0.03）
```

售价公式（对齐业务在用表格）：

```
不含税售价 = 税前成本 ÷ (1 − 利润率 − 综合税费系数)
利润(对销项口径) = 不含税售价 × (1 − 综合税费系数) − 税前成本
```

**综合税费系数 `misc_fee_rate`**：除销项增值税外的印花税、土地税、个人所得税等杂税总和，
相对销项计征。默认 0.03，可按产品/按单覆盖，**不拆解**（印花税已含在内，本模式下
`stamp_duty` 恒为 0）。

**让利默认 100%**（`give_ratio` 默认从 0.8 改为 1，对齐智能表格默认让利100%）。

### 真实数据吻合性（回归测试锁定）

智能表格「客户询盘跟进表」牛栏网记录（350 卷，成本 281.9561/件，利润率 6%）：

| 指标 | kaas 引擎 | 智能表格 | 差异 |
|---|---|---|---|
| 单件售价(CNY) | 309.8419 | 309.841918... | < 0.01 ✓ |
| 单件利润(CNY) | 18.5905 | 18.590515... | < 0.01 ✓ |
| 总售价(CNY) | 108444.67 | 108444.6714... | < 0.5 ✓ |

详见 `backend/orchestrator/tests/test_real_data_regression.py`。

## 多产品报价 + 手动干预

迁移 `202610100001_quote_item_manual_override`：报价/订单行项新增：

- `policy_override`（JSONB）：行级报价政策覆盖（利润率、综合税费系数等），空则继承报价单共享政策
- `price_source`：auto（公式自动）| manual（非标产品手动给价）| overridden（覆盖公式结果）
- `cost_override` / `price_override` / `weight_override` / `volume_override`：行级覆盖值
- `image_url`：产品图片（单证可选配图）

**产品丝径参数体系**（对齐业务报价表）：

- 勾花网：单一丝径
- 牛栏网（field_fence）：边丝 + 经丝 + 纬丝
- 鹿网（deer_fence）：边丝 + 经纬丝 + 拧花(环扣)丝径

**表面处理选项**（对齐业务报价表，field_fence）：热镀锌 40/200/260g/㎡、电镀锌、PVC涂塑(黑色)。
组合数 64 → 160。

## 实际采购成本（只算利润，不碰报价）

迁移 `202610100002_actual_procurement_costs`：`产品 × 供应商(可选) × 生效期`。

- 单件/总成本联动：录入任一自动算另一个（qty 来自客户订单该行产品参数）
- 含税开关 `cost_basis: pretax|incl_tax`（默认不含税）；含税时按进项票税点换算税前值
- **隔离保证**：只进「利润核算/经营分析」链路，报价计算链路读取的是报价成本快照，
  报价单/单证渲染永不引用实际成本

## 汇率

- 新增 `scripts/fetch_fx_rates.py`：USD/CNY 每日拉取（er-api/frankfurter 多源降级，
  全部失败沿用最近一条并标 `is_stale`）
- 新增 `/api/v1/fx-rates` API：查询/手动补录
- 报价/订单生成时由 `ws_common.lock_fx_rate` 锁定当日快照（已有机制）

## 询价历史留存

迁移 `202610100003_order_inquiry_fields`：`cust_inquiries` 加 `inquiry_seq` + `spec_snapshot`，
支持同客户同订单多次询价（不同产品/规格）+ 我方报价 + 时间线留存。

## 订单/运输字段补齐

- `destination_country` / `destination_region`：**订单地区 ≠ 客户地区**（经销商/中间商场景）
- `carrier`：船公司
- `freight_valid_from` / `freight_valid_to`：海运费有效期

## 客户 CRUD 补齐

迁移 `202610100004_customer_soft_delete`：客户软删除（`is_deleted`/`deleted_at`，
保留历史单据引用）；联系人 PATCH/DELETE。

## 外部单证上传

迁移 `202610100005_external_doc_uploads`：用户手动上传外部获取的单证（PDF/图片）
挂到对应订单，落库持久化（BYTEA + 元数据），与系统生成单证同状态机（draft/issued/void）。

## 单证金额勾稽

`trade_docs` 创建/更新时校验「单证合计 = 行项目合计」，差异 > 0.01 直接拒绝
（信用证不符点防线）。

## 部署注意事项

1. **数据库迁移**：5 个新迁移（202610100001~0005）需 `alembic upgrade head`
2. **共享内核同步**：CI 的 `sync-shared.ps1` 会把 `app/services/export_quote/` 复制到
   `worker/src/kaas_common/`（含本次 pricing.py 改动），部署时自动执行
3. **Worker 接口族**：`worker/src/main.py` 是 orchestrator 的移植版，本次新增的
   `/api/v1/fx-rates`、`/api/v1/actual-costs`、`/api/v1/external-docs` 端点需在
   Worker 镜像中同步（与既有 `trade_docs` 接口族同构）
4. **回归测试**：`backend/orchestrator` 下 `pytest -k "export_quote or real_data"`
   → 301 passed

## 已知遗留

- `test_customer_no_x_tenant_id_works` 失败：预先存在（基线提交上也失败，
  `/auth/me` 端点鉴权测试问题），与本次改动无关
- 阶段9（必备单证渲染投产联调验收）：前端 18 种单证模板已就绪，需生产环境联调
  （渲染数据字段打通、PDF/打印导出、盖章/seal、双语）+ 样张对照验收
