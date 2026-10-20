# 归档批 · 2026-10-21 文档收尾（业务/设计过时批）

> ⚠️ 历史留档，**不代表当前口径**。当前入口见 [`../../README.md`](../../README.md)（文档索引 / 当前权威 / 归档分层）。
>
> 本批 4 份都是「设计 / 计划 / 进度」类文档：主体已落地或已被取代，文内的进度数字与「未做」清单已过时。
> 处理方式：**`git mv` 移动归档**（历史可追，不是复制）。归档内相对链接可能仍指向旧路径；
> 文档校验**排除 `docs/archive/**`**（约定见 [`../README.md`](../README.md)）。

## 本批归档

| 文件 | 归档理由 | 现在看哪里（替代指针） |
|---|---|---|
| [`TEAMS_AND_VISIBILITY.md`](./TEAMS_AND_VISIBILITY.md) | 2026-10-11 三层组织与数据可见性的落地说明；文末「未做」清单已被后续实现推翻：`POST /api/v1/auth/logout` 已在 `backend/worker/src/main.py:410`、`POST /api/v1/teams/{team_id}/transfer` 已在 `main.py:444`。规则真源一直是**代码**（`backend/kaas_common/workstation/scope.py` 可见性、`teams.py` 团队规则） | 根 `README.md` §6（`tenant_id` 恒 `default`、`team_id` 才是隔离边界）；代码 + `backend/worker/tests/test_teams_api.py`（22 例）、`backend/orchestrator/tests/test_team_scope_rules.py`（15 例） |
| [`CUSTOMER_DOCUMENTS_VIEW.md`](./CUSTOMER_DOCUMENTS_VIEW.md) | 2026-10-11「客户历史报价/订单/单证包含关系与展示」设计；已按实现落地（客户详情弹窗 + 询盘 tab 后续单据 + 单证内嵌预览），设计推演过程被 UI 线文档与代码取代 | [`../../UI_UX_OPTIMIZATION_2026-10-20.md`](../../UI_UX_OPTIMIZATION_2026-10-20.md) §0.2/§0.3；共享内核 `backend/kaas_common/workstation/customer_records.py`（树装配唯一实现） |
| [`PRODUCT_MEDIA_STORAGE_PLAN.md`](./PRODUCT_MEDIA_STORAGE_PLAN.md) | 2026-10-11 文件/产品媒体存储规划 + 逐项进度表；进度表数字已过时，唯一仍未收口项（R2 密钥）已转 `TODO.md` D2 跟踪。**§5.3/§8 的 S3 密钥结论仍有效，摘要见下节** | `docs/TODO.md` D2（R2 新密钥替换）；存储落点矩阵见根 `README.md` §2；代码 `backend/kaas_common/files/` |
| [`PLATFORM_UPGRADE_PLAN.md`](./PLATFORM_UPGRADE_PLAN.md) | 2026-09-26 平台综合升级方案；文末自述「主体已收口、降级为背景参考、执行入口已移交 `MASTER_EXEC_PLAN_2026-10-19.md`」——而后者已于 2026-10-20 归档（`docs/archive/2026-10-20-closeout/`） | 根 `README.md`（架构/环境/门禁）、[`../../README.md`](../../README.md)、`docs/TODO.md`；工位体系上位权威 `docs/WORKSTATION_DESIGN.md` |

## 关键结论保留：生产 S3 直传不可用（`PRODUCT_MEDIA_STORAGE_PLAN.md`）

> 这条结论**不随归档失效**，2026-10-21 复核仍在 `docs/TODO.md` D2 未收口：

- **现象**：生产 `S3_ACCESS_KEY` 只有 **13 位**，R2 要求 **32 位** ⇒ 预签名直传 `PUT` 返回
  `400 InvalidArgument: Credential access key has length 13, should be 32`。
- **影响**：**生产 S3 直传当前不可用**；**服务端代理（multipart）上传仍可用**，且直传失败会
  **自动回退**代理并如实告知用户（`fellBackToProxy` / `fallbackReason`，不静默成功）。
- **纪律**：在用户重建 32 位密钥并跑通验收之前，**不得声称「生产直传已成功」**。
- **详情**：见本目录 [`PRODUCT_MEDIA_STORAGE_PLAN.md`](./PRODUCT_MEDIA_STORAGE_PLAN.md) §5.3 / §8 / FAQ Q1；
  **当前状态**看 `docs/TODO.md` D2（发布窗口执行 `wrangler secret put`）。

## 未归档（仍有效，勿用归档判断当前口径）

- 当前权威/交接：`docs/README.md`、`docs/HANDOVER_2026-10-20_FINAL.md`、`docs/PROBLEM_STATUS_2026-10-11.md`、`docs/TODO.md`
- 业务/设计参考（仍有效）：`docs/WORKSTATION_DESIGN.md`、`docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md`、
  `docs/TRADE_DOC_TEMPLATES.md`、`docs/TRADE_DOC_PDF_ARCHIVAL.md`
- UI 线（已完成，留作验收基线）：`docs/UI_UX_OPTIMIZATION_2026-10-20.md`、`docs/UI_BACKEND_DEPENDENCIES_2026-10-20.md`
