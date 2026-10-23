# QA 越权审计 · 真机留证（A-10 / C27 · 2026-10-23）

> **执行方式**：生产黑盒，仅拒绝路径（P4 口径），只读请求；生产唯一写入 = 创建 QA 账号
> （`scripts/seed_qa.py`，幂等、护栏见该文件；用户目标授权「未回复按推荐默认」记录于本文件）。
> **工具链**：python urllib + 浏览器 UA（见 §3 发现 F-1）。生产 API = `https://api.kaas.powervoy.com/api/v1`。

## 0. 账号前提（2026-10-23 实测）

- 生产 `users` 原有 **2 个账号**（david@powervoy.com internal/system_admin、david@lianjiafence.com customer/owner）；
  **QA 账号不存在**（2026-10-21 审计文档「3 个账号含 qa_*」已过时）。
- 按 `docs/QA_TEST_ACCOUNTS.md` 设计补建（seed 脚本入库修复审计 D-3）：
  - `qa_user@qa.kaas.internal`：internal / **user**（非管理员；plan=internal；team_id=NULL）
  - `qa_customer@qa.kaas.internal`：customer / owner（plan=free；team_id=NULL）
  - `customers` 行：id=2、code=`qa_smoke`、tenant_id='default'（单租户事实，见 D-2）、owner_scope=private
  - `user_customers`：qa_customer → qa_smoke
- 口令：随机生成一次，存 `~/.dsh/secrets/qa-accounts-password-20261023.txt`（不入仓，inventory.md 已登记）。

## 1. 真机矩阵结果（16 组请求）

| # | 用例（对应 QA 7 条 / v2 矩阵） | 请求 | 状态码 | 响应体关键 | 判定 |
|---|---|---|---|---|---|
| A1 | AI 读（F1） | GET /ai/providers（qa_user） | **403** | forbidden · Platform operator required | ✅ 拒绝 |
| A2 | AI 读（F1） | GET /ai/providers（qa_customer） | **403** | 同上 | ✅ 拒绝 |
| A3 | AI 读（F1） | GET /ai/tasks（qa_user / qa_customer） | **403** | 同上 | ✅ 拒绝 |
| A4 | AI 写（F1） | PUT /ai/providers/deepseek（两账号，body 仅 model，**未写 key**） | **403** | 同上 | ✅ 拒绝 |
| B1 | 单证列表（F2） | GET /trade-docs（qa_customer） | **404** | not_found · `WORKSTATION_NOT_SUBSCRIBED`（workstation=trade-docs） | ✅ 拒绝（闸门顺序见 §2-F3） |
| B2 | 单证详情（F2） | GET /trade-docs/999999（qa_customer） | **404** | 同上 | ✅ 拒绝 |
| B3 | 单证写（F2b/R-1） | PATCH /trade-docs/999999（qa_customer） | **404** | 同上 | ✅ 拒绝 |
| C1 | 单证确认（F3） | POST /trade-docs/999999/confirm（qa_customer） | **404** | 同上 | ✅ 拒绝 |
| C2 | 单证导出（F3） | POST /trade-docs/999999/pdf（qa_customer） | **404** | 同上 | ✅ 拒绝 |
| C3 | 单证确认（F3） | POST /trade-docs/999999/confirm（qa_user） | **404** | 同上（无团队 ⇒ 未订阅） | ✅ 拒绝 |
| D1 | 公章读（F4） | GET /tenant/company-seals（qa_customer） | **404** | `WORKSTATION_NOT_SUBSCRIBED`（公章工位映射 trade-docs 订阅） | ✅ 拒绝 |
| D2 | 公章读（F4） | GET /tenant/company-seals（qa_user internal） | **404** | 同上（订阅闸门先于 internal 放行） | ✅ 拒绝（见 §2-F3） |
| #4 | admin 专属 | GET /admin/feature_flag（qa_user） | **403** | forbidden | ✅ 拒绝 |
| #6 | 无 token | GET /trade-docs（无 Authorization） | **401** | — | ✅ 拒绝 |
| 登录 | 口令校验 | POST /auth/login 两账号 | **200** | access_token | 正常（正确口令） |

**汇总：16/16 拒绝路径全部被拦，无越权成功；生产未发生任何 AI key / 单证 / 公章数据读取。**

## 2. 审计发现

- **F-1（方法学）Cloudflare 会拦非浏览器 UA**：python-urllib 默认 UA ⇒ 全端点一律 403（连 /auth/login
  与无 token 请求都 403 ⇒ 判定为边缘层拦截、非应用语义）。换浏览器 UA 后语义恢复正常。
  **以后真机审计必须带浏览器 UA，否则证据无效**（首轮 16 组结果已作废重跑）。
- **F-2 账号清单过时**：2026-10-21 审计文档 §0「生产 3 账号含 qa_*」与实测不符（QA 账号已被清理）；
  本轮按设计文档补建，并把 `scripts/seed_qa.py` 入库（修复 D-3）。
- **F-3 闸门顺序（重要，如实的实现事实）**：**工位订阅闸门先于角色闸门**。无团队账号访问
  trade-docs / 公章工位时，先命中 `WORKSTATION_NOT_SUBSCRIBED` 404（不泄露存在性），
  不会到达内核的 NO_TEAM / 跨团队 404 / TEAM_ADMIN_REQUIRED 分支。含义：
  - 对「拒绝路径审计」无影响（同样拒绝、同样不泄露）；
  - 但真机**无法**对 S5/S6 的角色层细分（403 NO_TEAM vs 跨团队 404）取到独立证据 —— 该深度
    已由代码级测试锁定（worker `test_admin_authz.py` 等，随 1711 passed 全绿），符合 v2 验收
    口径「①代码级 ③真机黑盒」双证据。
  - 若后续想真机跑角色层矩阵，需给 QA 建团队并订阅 trade-docs 工位（再写生产，**需用户拍板**，本
    轮不做）。
- **F-4 QA_TEST_ACCOUNTS.md 口径漂移确认（D-1/D-2 落地说明）**：单租户 default + 团队隔离是事实；
  QA 数据面本轮用「无团队 + owner_scope=private + qa_smoke 客户行」实现隔离，未另建团队。

## 3. 与 QA 7 条的对应

| QA 条 | 真机结果 |
|---|---|
| #1 公章读取（qa_customer 不可） | 404 未订阅（拒绝 ✓；角色层 403 由代码级测试锁定） |
| #2 跨租户读单证 | 404 未订阅（拒绝 ✓；跨团队 404 由代码级测试锁定） |
| #3 创建/确认/导出单证 | 404 未订阅（拒绝 ✓） |
| #4 admin 专属接口 | 403（真机 ✓） |
| #5 列表可见性 | 404 未订阅（拒绝 ✓；S5 403 NO_TEAM 由代码级测试锁定） |
| #6 无 token / 伪造 | 401（真机 ✓） |
| #7 系统配置写（AI） | 403（真机 ✓，F1 闸门按 v2 裁决收紧后生效） |

## 4. 复核命令

- 登录：`POST https://api.kaas.powervoy.com/api/v1/auth/login`（需浏览器 UA）
- 矩阵脚本：本轮为一次性脚本（含口令，不入仓）；重放可用 `scripts/seed_qa.py` 重建账号后按 §1 表逐条复打。
- 代码级佐证：`cd backend/worker && uv run --with pytest python -m pytest tests/test_admin_authz.py -q`（及 trade-docs/seals 相关 authz 用例）。
