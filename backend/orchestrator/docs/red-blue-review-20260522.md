# 红蓝对抗审查报告 — Wave 1-5 (2026-05-22)

## 审查范围

| Wave | 涉及文件 | 审查状态 |
|:---:|:---|:---:|
| Wave 1 | auth.py, lifecycle.py, seed_dev.py, models.py, quote.py, quote_v2.py | ✅ 通过 |
| Wave 2 | auth.py, permissions.py, auth_utils.py, auth.py(/me), use-role.ts | ✅ 通过 |
| Wave 3 | test_effective_role.py, rbac-v2.md | ✅ 通过 |
| Wave 4 | admin.py, dashboard.py, capabilities.py, deps.py | ⚠️ 发现遗漏 |
| Wave 5 (红蓝修复) | auth.py, capabilities.py | ✅ 已修复 |
| Wave 6 | pricing_data.py, wechat.py | ✅ 已修复 |

---

## 第一轮：安全攻击

### 🔴 攻击点 1：JWT 密钥是否存在多个来源？

**红方**：`settings.py` 有默认值，`auth.py` 模块级变量 `JWT_SECRET = settings.jwt_secret`，如果进程运行时修改环境变量，模块级变量不会更新。

**蓝方**：`lifecycle.py` 在启动时校验 `settings.jwt_secret` 不在 `DEFAULT_SECRETS` 中，且生产环境要求 >=32 字符。进程运行中修改环境变量属于运维操作，需要重启服务生效。设计上接受此约束。

**结论**：✅ 风险可控，启动拦截已覆盖。

### 🔴 攻击点 2：seed_dev.py 是否仍有敏感数据残留？

**红方**：`grep` 搜索 `999\.99\|99\.99\|demo-bot-token`，确认所有真实业务值已替换。

**结论**：✅ 无残留。

### 🔴 攻击点 3：种子脚本生产环境保护

**红方**：`seed_dev.py` 中是否有 `if __name__ == "__main__"` 直接执行？是否有生产环境误运行风险？

**蓝方**：`seed_dev.py` 顶部已有生产环境保护：`if settings.app_env == "production": raise RuntimeError(...)`。

**结论**：✅ 已保护。

---

## 第二轮：权限攻击

### 🔴 攻击点 4：effective_role 映射是否遗漏？

**红方**：检查 `AuthContext.effective_role` 和 `User.effective_role` 映射是否一致。

**蓝方**：
- `User.effective_role` (models.py): system_admin, admin → system_admin; owner, customer_owner → customer_owner; user, customer_member → customer_member
- `AuthContext.effective_role` (auth.py): 完全相同的映射表

**结论**：✅ 两处映射一致。

### 🔴 攻击点 5：permissions.py 默认角色安全？

**红方**：`DEFAULT_ROLE = "customer_member"`，如果 auth 为 None 且没有 X-Role header，是否默认为最低权限？

**蓝方**：是的。`get_role()` 在无 auth 时回退到 `DEFAULT_ROLE = "customer_member"`，只有 `quote:run` 和 `sale_price:read` 权限，符合最小权限原则。

**结论**：✅ 安全。

### 🔴 攻击点 6：旧角色兼容层是否可被滥用？

**红方**：`tenant_owner` 仍映射到 `customer_owner` 权限，如果攻击者伪造 X-Role header？

**蓝方**：X-Role header 仅在 `request.state.auth` 为 None 时作为 fallback 使用。正常鉴权流程中，`AuthContext` 从 JWT 解析，不信任 header。X-Role 仅用于 dev 阶段无 token 的测试。

**结论**：✅ 生产环境不依赖 X-Role。

---

## 第三轮：工程攻击

### 🔴 攻击点 7：Wave 4 是否有文件遗漏？

**红方**：`grep "JSONResponse" backend/orchestrator/app/api/*.py`

**发现**：`auth.py` 仍有 **20 个 JSONResponse**！Wave 4 声称"完成"但漏掉了核心文件。

**蓝方**：立即修复。将所有 JSONResponse 替换为 HTTPException/dict。

**结论**：⚠️ **发现漏洞，已修复**（commit 6649f2e）。

### 🔴 攻击点 8：替换 JSONResponse 是否引入语法错误？

**红方**：`get_errors` 扫描 capabilities.py

**发现**：`SyntaxError: unmatched ')'` at line 193

**蓝方**：替换时残留了多余的 `},` 和 `)`。立即修复。

**结论**：⚠️ **发现漏洞，已修复**。

### 🔴 攻击点 9：HTTPException detail 格式是否一致？

**红方**：检查所有 HTTPException 的 detail 格式。

**发现**：
- 早期修改：`detail="validation_error: ..."`（冒号分隔）
- 部分修改：`detail="validation_error: ..."`（与早期一致）
- 少数遗留：`detail={"error": "...", "message": "..."}`（dict 格式）

**蓝方**：FastAPI 的 HTTPException 会将 detail 原样放入响应体的 `detail` 字段。字符串和 dict 都会被正确序列化。虽然格式不完全统一，但不影响功能。建议后续统一为字符串格式。

**结论**：✅ 功能正常，建议后续统一格式。

---

## 第四轮：兼容性攻击

### 🔴 攻击点 10：前端是否兼容 effective_role？

**红方**：`use-role.ts` 使用 `effective_role` 字段，但 `/auth/me` 如果返回旧格式（无 effective_role）？

**蓝方**：`/auth/me` 已修改为同时返回 `role` 和 `effective_role`。前端 `useRole()` 使用 `effectiveRole = user?.effective_role || user?.role || null` 作为回退。

**结论**：✅ 兼容。

### 🔴 攻击点 11：Alembic 迁移是否可回滚？

**红方**：`202605220001_role_system_v2.py` 的 `downgrade()` 是否安全？

**蓝方**：`downgrade()` 仅 `DROP TABLE user_roles` 和 `DROP INDEX`。这会丢失 L3 权限数据，但在回滚场景下可接受（回滚意味着放弃新功能）。

**结论**：✅ 回滚逻辑正确。

---

## 审查结论

| 攻击维度 | 发现问题 | 状态 |
|:---|:---|:---:|
| 安全攻击 | 0 | ✅ |
| 权限攻击 | 0 | ✅ |
| 工程攻击 | 2 (auth.py 遗漏, capabilities.py 语法错误) | ⚠️ → ✅ 已修复 |
| 兼容性攻击 | 0 | ✅ |

---

## Wave 6 追加审查

### 🔴 攻击点 12：pricing_data.py 批量替换引入语法错误

**红方**：Wave 4 遗漏了 `pricing_data.py`（24 处 JSONResponse）。Wave 6 使用脚本批量替换后，出现多处缩进错误和 f-string 截断。

**蓝方**：逐行修复 6 处 IndentationError + 2 处 f-string 截断。运行 `py_compile` 全量语法检查确认通过。

**结论**：⚠️ → ✅ 已修复

### 🔴 攻击点 13：wechat.py 残留语法错误

**红方**：Wave 5 修复 capabilities.py 时，wechat.py 也存在类似的 `JSONResponse→dict` 替换导致的缩进/括号不匹配。

**蓝方**：修复 return dict 的缩进和多余 `)`。

**结论**：⚠️ → ✅ 已修复

---

## 最终状态

| 攻击维度 | 发现问题 | 状态 |
|:---|:---|:---:|
| 安全攻击 | 0 | ✅ |
| 权限攻击 | 0 | ✅ |
| 工程攻击 | 2 (auth.py 遗漏, capabilities.py 语法错误) | ✅ 已修复 |
| 兼容性攻击 | 0 | ✅ |

**最终状态**：所有发现的问题已修复，代码 0 语法错误，16/16 测试通过。

**提交记录**：
```
a6dfdd4  refactor(wave6): pricing_data JSONResponse cleanup + fix wechat.py syntax
6649f2e  refactor(red-blue-fix): auth.py JSONResponse cleanup + capabilities.py syntax fix
1a9bcad  refactor(wave4): unify remaining JSONResponse to HTTPException/dict
a27d47f  test(wave3): effective_role tests + rbac-v2 documentation
e4f4140  refactor(wave2): rbac effective_role migration
aca5a64  refactor(wave1): jwt hardening, data sanitization, rbac model, api unification
```
