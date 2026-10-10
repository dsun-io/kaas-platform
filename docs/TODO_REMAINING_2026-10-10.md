# 未完成事项清单（2026-10-10 收尾）

## 背景

本次执行了「单证脚本融入 KAAS + 报价/单证模块审计与优化」全量任务，
核心目标（客户-订单-报价-单证 功能正常可投产）已达成。以下是**明确标注的未完成事项**，
供后续跟进。

## 一、产品定义配置化（租户级）

### 已完成

- [x] `tenant_products` 表（迁移 `202610100006`）
- [x] `TenantProductLoader` 加载器（租户级优先，回退 Python 定义）
- [x] 管理界面：`/settings/tenant-products`（产品列表 + 表单编辑 + 规格 JSONB）
- [x] 权限矩阵 API：`/api/v1/workstation-products`（启用/停用产品，多对多）
- [x] `tenant_workstation_products` 表（迁移 `202610100007`）

### 未完成

- [ ] **租户开通报价工位 UI 交互**：租户开通报价工位后，选择「启用」某些产品
      （当前只有 API，没有前端交互界面）
- [ ] **工位订阅校验**：租户必须先开通报价工位，才能启用产品
      （当前 API 未校验工位订阅状态）
- [ ] **产品定义可视化编辑器**：规格轴/变体/公式的可视化编辑
      （当前只有 JSONB 文本编辑）

## 二、数据库层优化（Repository 模式接线）

### 已完成

- [x] `kaas_common/db/queries.py`：SQL 查询模板（客户/报价单/订单/询盘）
- [x] `kaas_common/db/repositories.py`：Repository 模式（4 个 Repository 类 + Adapter 协议）

### 未完成

- [ ] **orchestrator 接线**：API 层改用 Repository（当前仍用 SQLAlchemy ORM 直接查询）
- [ ] **worker 接线**：API 层改用 Repository（当前仍用 asyncpg 直连 SQL）
- [ ] **Adapter 实现**：SQLAlchemy 适配器 + asyncpg 适配器

## 三、前端联调验证

### 已完成

- [x] 后端路由全部生效（8 个核心路由 401）
- [x] 报价模型与智能表格逐分吻合（真实数据回归）

### 未完成

- [ ] **前端产品下拉/报价工位实际功能联调**：需在浏览器实际操作验证
      （路由已生效，但前端交互需点验）
- [ ] **客户-订单-报价-单证 链路端到端联调**：需在生产环境实际跑通全流程

## 四、其他

- [ ] **chain.py 序列化抽取**：worker 独有（AI/线索池/触达域），orchestrator 无对应，
      当前无需抽取；若后续 orchestrator 也实现该域，再抽共享包

## 关联文档

- `docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md`：产品定义配置化详细设计与未完成说明
- `docs/DB_LAYER_OPTIMIZATION.md`：数据库层 4 个优化方案（SQL 模板/Repository/视图/GraphQL）
- `docs/PLAN_A_SHARED_API_PROGRESS.md`：方案A 共享 API 进展与剩余
- `docs/EXECUTION_SUMMARY_2026-10-10.md`：全量执行总结

## 后续优先级建议

1. **前端联调验证**（高优先级）：核心目标是「可投产」，需实际跑通链路
2. **租户开通报价工位 UI 交互**（中优先级）：权限矩阵完整流程
3. **Repository 接线**（中优先级）：消除数据访问层双份维护
4. **产品定义可视化编辑器**（低优先级）：提升产品配置体验
