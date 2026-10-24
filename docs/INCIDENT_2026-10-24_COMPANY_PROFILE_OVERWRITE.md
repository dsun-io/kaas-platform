# 事故记录：企业抬头被 QA 冒烟请求覆盖（2026-10-24 20:24）

## 1. 事件
- **时间**：2026-10-24 12:24:09Z（北京时间 20:24）。
- **动作**：为验证「团队管理员写权限」是否正常，我用 QA 账号（qa_user@qa.kaas.internal，已被我设为 QA 测试团队的管理员）
  调用了 `PUT /api/v1/tenant/company-profile`，body 只给了 `name_en` / `name_zh`。
- **后果**：该端点是**整行覆盖**语义 ⇒ 生产库 `tenant_company_profile` 的其余 14 个字段
  （address_en/address_zh/phone/email/website/bank_name/bank_account/swift_code/logo_url/default_incoterm/
  default_payment_terms/default_country_of_origin 等）被置为 NULL / 空串。
  这是**租户级**数据（所有对外单证的卖方抬头），不是团队级。

## 2. 发现与恢复
- 发现方式：PUT 响应体回显里 `address_en: null` 与既有值不符 ⇒ 立刻停止写冒烟。
- 恢复方式：**Neon 时间点恢复（PITR）**
  1. Neon API 建时间点分支 `recovery-company-profile`，`parent_timestamp=2026-10-24T12:15:00Z`（PUT 之前）；
  2. 从该分支只读取出原始整行（18 个字段全量）；
  3. 用主库 DSN 逐字段 UPDATE 还原（含 `updated_at=2026-10-22 05:41:40.834055+00:00`）；
  4. 校验「逐字段一致: True」；
  5. 删除临时 PITR 分支（仅剩 main）。
- **结果**：`tenant_company_profile` 已 100% 还原（含 swift_code=PCBCCNBJHBX / bank_account / address 等）。
- 同时清理：`fx_rates` 标记行（DB 同一性验证用）、`tax_archives` QA 冒烟档案 1 行。

## 3. 根因
1. **我把「只读交叉验证」写成了「写验证」**：为确认 403 的原因，我用了业务写端点 PUT company-profile，
   而它的语义是整行覆盖（未给出的字段被清空）—— 我没有先读实现里的覆盖语义就调用；
2. **测试数据策略错了**：这类验证应该用**专用测试端点/测试库/或先在 PITR 分支上试**，绝不能对生产租户级数据做写探测；
3. 缺少**写前快照**：调用前没有先落一份该行的备份。

## 4. 防再犯（已生效的规则）
1. **生产写探测三原则**：① 先读 handler 的写入语义（PATCH 合并 vs PUT 整行覆盖）；② 调用前把目标行 dump 到本地
   （`SELECT *` 全字段）；③ 优先用 **Neon 分支**（`parent_timestamp`）做写验证，而不是主线。
2. **租户级数据禁止用作冒烟对象**（company_profile / feature flags / 全局配置）——要么造团队级资源（tax_archives 等），
   要么在分支里做。
3. 冒烟脚本必须带**恢复分支**：任何 UPDATE/PUT 探测前，先写一份还原 SQL。

## 5. 影响范围
- 数据：仅 `tenant_company_profile` 一行，已完整还原；无其它表受影响。
- 业务：窗口期约 **1 分钟**（12:24:09Z 覆盖 → 恢复完成）。窗口期内若有单证渲染会拿到空抬头；
  经查 `trade_docs` / `quote_orders` 当前均为 0 行，**无单证在该窗口生成**，故无对外单证受影响。
- 审计：Neon PITR 分支已删除，但主库 WAL 保留（可再取任意时间点）。
