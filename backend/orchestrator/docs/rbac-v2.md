# Kaas v2 · 三层角色体系 (RBAC v2)

> **版本**: Wave 2 (2026-05-22)
> **状态**: 生效中（过渡期兼容旧角色）

---

## 1. 角色层级

| 层级 | 角色名 | 标识 | 说明 |
|:---:|:---|:---|:---|
| L1 | 平台管理员 | `system_admin` | 全平台管理，可访问所有租户数据 |
| L2 | 客户负责人 | `customer_owner` | 客户域管理员，管理本客户全部业务数据 |
| L3 | 客户成员 | `customer_member` | 普通成员，仅可报价和查看销售价 |

---

## 2. 旧角色映射

数据库中 `users.role` 字段保留旧值，通过 `effective_role` property 映射：

| 旧角色 | effective_role | 说明 |
|:---|:---|:---|
| `system_admin` | `system_admin` | 不变 |
| `admin` | `system_admin` | 合并到 L1 |
| `owner` | `customer_owner` | 迁移到 L2 |
| `customer_owner` | `customer_owner` | 不变 |
| `user` | `customer_member` | 迁移到 L3 |
| `customer_member` | `customer_member` | 不变 |

---

## 3. 权限矩阵

| 权限点 | system_admin | customer_owner | customer_member |
|:---|:---:|:---:|:---:|
| `cost:read` / `cost:write` | ✅ | ✅ | ❌ |
| `sale_price:read` / `sale_price:write` | ✅ | ✅ | read only |
| `pricing_profile:read` / `pricing_profile:write` | ✅ | ✅ | ❌ |
| `freight_rate:read` / `freight_rate:write` | ✅ | ✅ | ❌ |
| `quote:run` | ✅ | ✅ | ✅ |
| `quote:sensitive_debug` | ✅ | ❌ | ❌ |
| `admin:customer_read` | ✅ | ✅ | ❌ |

---

## 4. 代码使用

### 后端

```python
from app.core.auth import AuthContext

auth = AuthContext(user_id=1, account_type="internal", role="admin")
assert auth.effective_role == "system_admin"
assert auth.is_admin() is True
```

```python
from app.core.permissions import require_permission

# FastAPI dependency
@router.post("/quote")
async def create_quote(request: Request):
    await require_permission(request, "quote:run")
```

### 前端

```typescript
import { useRole, ROLES } from "@/hooks/use-role";

function MyComponent() {
  const { isSystemAdmin, isCustomerOwner, isCustomerMember, effectiveRole } = useRole();
  // ...
}
```

---

## 5. 过渡期兼容

- **X-Role header**: 仍支持旧角色（`tenant_owner`, `tenant_sales` 等）
- **AuthContext.role**: 保留原始值，不破坏现有逻辑
- **`users` 表**: 不添加 CHECK 约束，避免锁表

---

## 6. 迁移状态

- [x] T1: JWT 安全启动校验
- [x] T2: 敏感数据脱敏
- [x] T3: `effective_role` property + `UserRole` 表
- [x] T4: 权限工具增强
- [x] T5a: 中间件升级
- [x] T5b: auth_utils 清理
- [x] T6: 前端角色映射
- [x] T7: Quote API JSONResponse 统一
- [x] T8: 测试覆盖
- [x] T9: 文档更新
