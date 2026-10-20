# 前端 UI 依赖的后端能力清单（2026-10-20）

> 目的：把“前端已经做到边界、再往下必须改后端”的 UI 需求集中登记，避免混进纯前端批次。
> 每条都写清：**现状事实 → 需要的改动 → 建议方案 → 验收**。是否排期/采用由产品拍板。
>
> **⚠️ 状态横幅（2026-10-21 文档收尾）：本文是「历史验收基线」，不代表当前待办。**
> 以下 5 项**已于 2026-10-20 全部完成并合并入 `main`**（合并提交 `118af7ce`；逐项证据见
> [`HANDOVER_2026-10-20_FINAL.md`](./HANDOVER_2026-10-20_FINAL.md) §0.1）。
> **现状以 [`TODO.md`](./TODO.md)（活跃待办唯一账本）与代码为准**；本文保留的价值是
> 「提出时的现状事实 + 建议方案 + 验收口径」，可作回归对照。
>
> | # | 事项 | 完成情况（2026-10-20） | 关键证据 |
> |---|---|---|---|
> | 1 | 签发后服务端自动上传 PDF | ✅ 方案 A | `ws_files.archive_rendered_pdf`；`main.py:4568`（PATCH 签发）、`ws_docs_ext.py:298`（confirm） |
> | 2 | 单证内容版本 | ✅ | 迁移 `202610200001`；`ws_docs_ext.py:588/622/653`；前端 `doc-content-versions.tsx` |
> | 3 | 个人信息编辑 | ✅ | `main.py:451`（`PATCH /auth/me`）、`main.py:483`（`POST /auth/change-password`）；侧栏个人信息弹窗 |
> | 4 | 询盘状态机 | ✅ | 迁移 `202610200003`；`backend/worker/src/inquiry_stage.py`；`GET /inquiries/{id}/stage-log` |
> | 5 | 报价 / 订单 1:N 约束 | ✅ 口径 A（保留 1:N + 业务闸门） | `main.py:3494` `ORDER_QUOTE_CURRENCY_MISMATCH`、`:3510` `ORDER_EXCEEDS_QUOTE` |
>
> 下文各节的「现状」是 **2026-10-20 提出时**的事实，「建议方案 / 验收」保留原样。
> 唯一的未做项是**方案 B（模板迁服务端，让不带 HTML 的第三方客户端也能出 PDF）**，已单独登记在
> `TODO.md` **A2-B**（需用户定要不要做）。

## 1. 签发后服务端自动上传单证 PDF

> **完成情况（2026-10-20）**：✅ 已落地「方案 A」——`POST /trade-docs/{id}/confirm` 与
> `PATCH /trade-docs/{id}`（draft→issued）均可携带前端**预览同一份 HTML**，服务端复用唯一实现
> `ws_files.archive_rendered_pdf`（校验 HTML → Browser Rendering 出字节 → `render_pdf` 新版本上位，
> 旧版挂 `render_pdf_superseded`）。**失败不回滚签发**：响应带 `pdf_archive{ok:false,...}`，界面提示手动上传。
> **方案 B 未做**（不带 HTML 的第三方客户端仍不出 PDF；见 `TODO.md` A2-B）。
> 测试：`backend/worker/tests/test_trade_doc_issue_auto_upload.py`。

**现状（2026-10-20 提出时）**

- Web UI 在签发成功后由前端 `render-data → renderTradeDoc(HTML) → POST /trade-docs/{id}/pdf`，服务端 Browser Rendering 出字节并落档。
- 直接调 API / 其他客户端签发不会自动上传（HTML 模板在前端）。
- 手动上传 `POST /files/upload` 与单证工位「导入已有数据」保留。

**需要的改动（二选一或分阶段）**

- 方案 A（推荐第一步）：签发接口接收前端 HTML（或前端在签发后同请求提交），服务端在同一事务里出 PDF 并落 `render_pdf` 版本。
- 方案 B：把 `renderTradeDoc` 模板迁到共享包/服务端，使任何客户端签发都能服务端自动出 PDF。
- 失败策略：签发成功但 PDF 失败 → 回滚签发还是“已签发 + 归档失败”可重试？需产品定；当前 UI 是后者并提示手动上传。

**验收**

- 任意客户端把 draft→issued 后，`/trade-docs/{id}/files` 出现 `render_pdf` 当前版本；无渲染器时 503 且签发状态不被静默吞掉。
- 手动上传仍可用；版本让位（旧版 `_superseded`）不变。

## 2. 单证内容版本（改几版、留最终版）

> **完成情况（2026-10-20）**：✅ 已落地。迁移 `202610200001` 建 `trade_doc_content_versions`
> （整份 payload 快照、按单据递增版本号、`change_source`）；三端点
> `GET /trade-docs/{id}/content-versions`、`GET .../{version_no}`、`POST .../{version_no}/restore`
> （`ws_docs_ext.py:588/622/653`）；前端「内容版本」面板 `doc-content-versions.tsx`（回看 + 恢复，仅 draft）。
> 测试：`tests/test_trade_doc_content_versions.py`（12 条）+ 前端 `doc-content-versions.test.tsx`（9 条）。

**现状（2026-10-20 提出时）**

- `trade_docs.raw_payload` 只存当前内容；draft 可改、issued 冻结；**没有内容版本表**。
- 已有 PDF 文件版本链（`file_objects.version/is_current/supersedes_id`），但那只覆盖“上传/归档过的 PDF”，不覆盖字段修改。

**建议方案**

- 新增 `trade_doc_versions`：`doc_id, version, raw_payload jsonb, status, created_at, created_by, reason, is_current`。
- 在 PATCH 内容 / 签发 / 作废时写快照（事务内），`current` 唯一。
- API：`GET /trade-docs/{id}/versions`（列表）、`GET /trade-docs/{id}/versions/{v}`（预览）；前端在单证详情加「版本」区，可切换只读预览。
- 保留策略：按租户配置保留 N 版/按时间；删除需审计。

**验收**

- draft 改 3 次 → 版本列表 3 条；签发后只读；能打开任一历史版预览；当前内容与最新版一致。

## 3. 个人信息管理（真实编辑）

> **完成情况（2026-10-20）**：✅ 已落地。`PATCH /api/v1/auth/me`（`main.py:451`，改显示名，只改本人，
> 邮箱不自助改）+ `POST /api/v1/auth/change-password`（`main.py:483`，必须验旧密码、新密码 ≥8）；
> 侧栏「个人信息」弹窗由只读变可编辑（`frontend/src/components/layout/sidebar.tsx`）。测试：`tests/test_profile_edit.py`（7 条）。

**现状（2026-10-20 提出时）**

- 侧栏「个人信息」弹窗只读（账号类型/角色/团队/套餐），明确提示“修改资料请联系管理员”。
- 后端只有 `/auth/me` 读取；没有资料修改接口；密码走找回流程。

**建议方案**

- `PATCH /auth/me`：`display_name`、`locale`、`timezone` 等非敏感字段；头像走文件域。
- 邮箱变更需验证（发信到新邮箱 + token），不要直接改。
- 修改密码单独 `POST /auth/change-password`（旧密码校验），与找回流程分开。
- 权限：只能改自己；管理员改他人走账号治理接口。

**验收**

- 前端个人信息弹窗从只读变可编辑；保存后 `/auth/me` 立即反映；邮箱变更未验证不生效。

## 4. 询盘状态机（真实流转）

> **完成情况（2026-10-20）**：✅ 已落地（用户拍板口径：**落库 + 事件驱动**，前端展示推导保留为兜底）。
> 迁移 `202610200003` 加 `cust_inquiries.stage/stage_updated_at` + `inquiry_stage_log`；阶段
> `inquiry < quotation < order < shipment < completed`，`closed` 为终态，**只前进、幂等**；
> 事件钩子 = 报价创建 / 订单创建 / 订单完成 / 出运创建 / 询盘手动关闭；
> `GET /api/v1/inquiries/{id}/stage-log` 提供变更历史。真源：`backend/worker/src/inquiry_stage.py`。
> 测试：`tests/test_inquiry_stage.py`。

**现状（2026-10-20 提出时）**

- `cust_inquiries.status` 只有 `unquoted/quoted/closed`；UI 的「关闭/询盘/报价/订单/发货/完结」是**前端按单证+订单状态推导**，不落库。
- 推导规则见 UI 方案 §0.3；订单未直接挂询盘（经报价传递）。

**建议方案**

- 先定口径：状态是否要真实落库（报表/筛选/通知会依赖）。
- 若落库：定义迁移表（关闭/询盘/报价/订单/发货/完结），由报价签发、订单创建/完成、PL/BL 签发等事件驱动；写 `inquiry_stage_log`。
- 保持展示推导作为兜底；后端就绪后前端直接读 `stage_display`。

**验收**

- 同一询盘在“报价→订单→发货→完结”各阶段，后端与 UI 显示一致；能按阶段筛选；历史变更可查。

## 5. 报价 / 订单 1:N 的业务约束

> **完成情况（2026-10-20）**：✅ 用户拍板**口径 A（保留 1:N）**，不加 1:1 唯一约束；
> 改为在 `POST /orders` 加业务闸门：①订单币种必须与报价一致（422 `ORDER_QUOTE_CURRENCY_MISMATCH`，
> `main.py:3494`）②同一报价下**未取消**订单金额累计不得超过报价合计（422 `ORDER_EXCEEDS_QUOTE`，
> `main.py:3510`，按分容差并附「报价合计 / 已下单 / 本单」明细）。历史多单不回填、不迁移。
> 测试：`tests/test_order_quote_constraints.py`（5 条）。

**现状（2026-10-20 提出时）**

- `orders.quote_id` 只有索引、没有唯一约束；`POST /orders` 不拦重复转单。现实允许“分批/重复下单”，UI 已支持 1:N（多条分组、单条扁平）。
- 若业务要求“一个报价只能一张订单”，当前系统不会阻止。

**需要产品决策**

- 选 A：保留 1:N（推荐，符合分批发货/重复下单），不加约束；UI 继续分组。
- 选 B：强制 1:1 → 后端加唯一约束 + 冲突提示 + 历史多单数据处理/迁移脚本；前端补错误提示。

**验收**

- 若选 B：同一报价第二次转单返回明确 409；历史多单可视图/迁移完成；e2e 覆盖冲突提示。

## 建议顺序

> 以下为 2026-10-20 提出时的建议顺序；**5 项已全部完成**（顺序仅作历史参考）。

1. **1（自动上传）**：直接影响“签发即可用”，收益最高；先做方案 A。
2. **4（询盘状态机）**：影响列表/筛选/报表，先定口径再动。
3. **3（个人信息）**：独立小改，可并行。
4. **2（内容版本）**：表结构与前端预览都要改，工作量最大，单独排期。
5. **5（1:N 约束）**：先决策，避免误伤历史数据。

## 边界

> 本节为边界原则；其中「后端就绪后前端接线」已于 2026-10-20 完成（5 项均已接线并有测试）。

- 以上均**不改**前端已完成的展示层；后端就绪后前端按新接口接线。
- 任何涉及数据迁移/删除/权限的改动，按项目规则先取证、再弹窗确认，不擅自执行。
