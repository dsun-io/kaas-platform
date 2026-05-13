# KaaS Platform 全量代码检查报告

> 检查日期：2026-05-13
> 分支：feature/v2-refactor
> 检查范围：frontend/ + backend/orchestrator/ + shared/contracts/ + scripts/ + CI/CD
> 检查维度：后端质量 / 前端质量 / 安全 / 架构一致性 / 测试与CI/CD

---

## 总体概况

| 维度 | 状态 | 问题数 | 严重 | 中危 | 低危 |
|---|---|---|---|---|---|
| 后端代码质量 | 需改进 | 10 | 4 | 4 | 2 |
| 前端代码质量 | 需改进 | 10 | 3 | 5 | 2 |
| 安全与漏洞 | 需关注 | 6 | 1 | 3 | 2 |
| 架构一致性 | 需改进 | 10 | 1 | 5 | 4 |
| 测试与CI/CD | 需改进 | 10 | 3 | 5 | 2 |
| **合计** | | **46** | **12** | **22** | **12** |

---

## 一、后端代码质量（10个问题）

### 严重

1. **异常处理过于宽泛，隐藏根因**（多处）
   - `app/middleware/auth.py:154` — `except Exception as e:` 捕获所有异常后返回 500，不记录原始异常堆栈
   - `app/api/quote_v2.py:59` — `except Exception:` 权限校验失败吞掉所有异常类型
   - `app/api/quote.py:35,54,77,94,113,130` — 6 处 broad except，报价链路各阶段异常均被吞掉
   - **建议**：区分 `ValidationError`、`HTTPException`、业务异常，只捕获已知异常类型

2. **API 层直接操作 DB，绕过 Repository 层**（多处）
   - `app/api/auth.py:70-84` — `_find_user_by_email`、`_get_customer_binding` 直接在 API 层执行 `db.execute(select(...))`
   - `app/api/capabilities.py:39-54` — 直接构建 `select(CustomerCapability)` 聚合查询
   - `app/api/dashboard.py:46-162` — 大量原始 SQL (`text()`) 直接嵌入 API 层
   - **建议**：所有 DB 查询应下沉到 repository 层，API 层只负责路由和参数校验

3. **`JSONResponse` 与 `response_model` 混用，破坏类型安全**（多处）
   - `app/api/quote.py:27` 声明 `response_model=QuoteResponse`，但函数内全部返回 `JSONResponse(...)`
   - `app/api/quote_v2.py:25` 同理
   - `app/api/capabilities.py:72,226` 等 18 处路由声明了 `response_model` 但返回 `JSONResponse`
   - **建议**：统一使用 Pydantic model 返回，或移除 `response_model` 装饰器避免误导

4. **Session 管理不一致 — 多处直接创建独立 session**（多处）
   - `app/api/quote_v2.py:95` — 事件记录独立创建 `async_session_factory()` session，手动 commit
   - `app/middleware/auth.py:79` — Auth 中间件内独立创建 session 查用户
   - `app/middleware/tenant.py:74` — Tenant 中间件内独立创建 session 验证租户
   - `app/services/knowledge_provider.py:84` — Provider 内部独立管理 session
   - **建议**：中间件层不应直接操作 DB session；事件记录应通过后台任务或消息队列解耦

### 中等

5. **类型注解覆盖率不足**
   - `app/api/pricing_data.py:94` — `_parse_date(value)` 参数无类型注解
   - `app/api/quote.py:29` — `create_quote()` 返回类型缺失
   - `app/services/quote_engine.py:21` — `request: dict` 过于宽泛
   - `app/api/admin.py:55` — `_append_audit` 参数 `detail: dict` 无结构定义

6. **裸 `except Exception:` 在事务边界**（3 处）
   - `app/db/session.py:41` — `get_db_session()` 依赖中会捕获 `KeyboardInterrupt`
   - `app/api/pricing_data.py:269,568,625` — 3 处 `except Exception:` 后手动 `db.rollback()`
   - **建议**：事务边界只捕获 `SQLAlchemyError`

7. **代码重复 — 权限校验逻辑在多个 API 中重复**（6+ 处）
   - `app/api/pricing_data.py:123-143`、`app/api/quotation.py:27-39`、`app/api/wechat.py:71-89` 等
   - **建议**：提取为 `get_current_tenant_and_customer(auth, request)` 统一工具函数

8. **`import re` 放在函数内部**（运行时重复导入）
   - `app/services/conversation_orchestrator.py:201`
   - `app/api/admin.py:150,371`
   - **建议**：所有 import 移至模块顶部

### 轻微

9. **N+1 查询风险**
   - `app/services/accessory_pricing.py:49-177` — 循环内对每条配件分别调用查询，若 accessories 有 N 条则产生 3N 次查询
   - `app/api/product_specs.py:121-129` — `quotable_specs` 构建时二次查询全部规格

10. **中间件异常处理不完善**
    - `app/middleware/auth.py:154-161` — `except Exception` 返回 500 但不记录异常详情，session 未正确关闭
    - `app/middleware/tenant.py:89-96` — 同样不记录详情

---

## 二、前端代码质量（10个问题）

### 严重

1. **useEffect+fetch 反模式**
   - `frontend/src/app/(app)/pricing-data/page.tsx:93` — 手动 useCallback + useEffect 获取数据，未使用 TanStack Query
   - 错误处理静默（`catch { // ignore }`），无缓存、无重试、无 loading 统一状态

2. **useEffect 依赖数组遗漏 + eslint-disable**
   - `frontend/src/app/(app)/customers/components/capability-form.tsx:60` — 依赖数组只写了 `[syncJob?.status]`，内部使用了 `syncJobId`、`onSaved`、`createEvent` 等却用 `eslint-disable-next-line react-hooks/exhaustive-deps` 掩盖

3. **表单状态过度使用 useState**
   - `frontend/src/app/(app)/pricing-data/page.tsx:66-80` — 单个页面 14 个 `useState` 管理表单字段，无统一表单库
   - 应使用 `react-hook-form` + zod，与项目其他表单保持一致

### 中等

4. **`as any` 类型断言**
   - `frontend/src/components/layout/sidebar.tsx:129, 242` — `href={item.href as any}` 两处

5. **`usePageView` 事件重复触发风险**
   - `frontend/src/lib/events/use-page-view.ts:29` — `firedRef` 配合 `eslint-disable` 跳过依赖检查

6. **硬编码颜色类名**
   - `frontend/src/app/(app)/pricing-data/page.tsx:520-524` — `bg-green-100 text-green-700` 等硬编码颜色
   - `quote-result.tsx` 中 `bg-amber-50` 重复 6 次，应提取为共享 StatusAlert 组件

7. **客户端路由跳转使用 `window.location`**
   - `frontend/src/lib/auth/auth-context.tsx:119,136,167,187` — 多处使用 `window.location.href` 而非 Next.js `useRouter().push()`
   - 导致全页刷新，丢失 React 状态

8. **`useSafeQuery` 类型安全问题**
   - `frontend/src/lib/query/safe-query.ts:21` — zod 校验失败时 `return raw as TData`，类型断言掩盖运行时类型不匹配

9. **`quote-form.tsx` 重量回填 useEffect 缺少依赖**
   - `frontend/src/app/(app)/quotations/v2-quote/components/quote-form.tsx:146-150`

### 轻微

10. **ErrorBoundary 使用范围不足**
    - 仅在 `global-error.tsx` / `error.tsx` 使用，业务页面未包裹

---

## 三、安全与漏洞（6个问题）

### 严重

1. **JWT_SECRET 存在弱默认值**
   - `backend/orchestrator/app/core/auth.py:19` — `JWT_SECRET = os.environ.get("JWT_SECRET", "kaas-dev-jwt-secret-change-in-prod")`
   - `backend/orchestrator/app/config/settings.py:57` — `jwt_secret: str = Field(default="kaas-dev-jwt-secret-change-in-prod", alias="JWT_SECRET")`
   - **风险**：生产环境如果未显式设置 `JWT_SECRET`，将使用可预测的默认密钥，攻击者可伪造 JWT token
   - **建议**：生产环境启动时校验 `JWT_SECRET` 不为默认值，或直接在生产配置中强制要求设置

### 中等

2. **硬编码客户商业敏感数据（成本价/利润率/运费）**
   - `backend/orchestrator/scripts/seed_dev.py` — 大量硬编码的真实成本数据：
     - 成本价：4.6 元/kg、4.82、5.10、5.50 等
     - 利润率：低 1.10 / 标准 1.15 / 高 1.20
     - 运费：四川 22 元、山东 22 元等
   - 数据来源注释为 "Notion 确认 2026-04-12"，属于联佳等客户的真实商业机密
   - **风险**：所有能访问仓库的人都能看到这些数据；若仓库后续分享会泄露商业机密
   - **建议**：种子数据中的商业敏感数据应外置到独立配置文件，按租户隔离

3. **MinIO 凭据存在默认值**
   - `backend/orchestrator/app/config/settings.py:39-40` — `minio_access_key/minio_secret_key` 默认值为 `minioadmin`
   - `docker-compose.yml:42-43` — 同样使用 `minioadmin`
   - 开发环境正常，但生产部署必须覆盖

4. **Dashboard API 使用 `text()` 构建动态 SQL**
   - `backend/orchestrator/app/api/dashboard.py:90-91` — 使用 `text(f"...")` 拼接 SQL
   - 虽然使用了参数化查询（`:tenant_id`），但动态拼接 SQL 字符串仍然存在潜在风险
   - 建议：使用 SQLAlchemy 的 `case()` / `func.coalesce()` 等表达式构建，避免字符串拼接

### 轻微

5. **开发环境 Token 默认值**
   - `backend/orchestrator/.env.example` 中的 `ADMIN_RELOAD_TOKEN=dev-token-123`、`ADMIN_SETUP_TOKEN=bootstrap-dev-token-2026`
   - 这是 `.env.example` 模板文件，正常；但需确保生产环境不复制这些默认值

6. **API Key 脱敏机制存在但覆盖不完整**
   - `app/core/sanitizer.py` 实现了日志脱敏，正则覆盖 `api_key`、`token`、`password`、`secret`
   - 但 `jwt_secret`、`minio_secret_key`、`database_url` 等未纳入脱敏范围
   - 特别是 `database_url` 包含数据库密码，若出现在日志中会泄露

---

## 四、架构一致性与契约（10个问题）

### 严重

1. **中间件链注册顺序错误**
   - `backend/orchestrator/app/main.py` 中中间件注册顺序与设计文档矛盾
   - 注释声明请求流向：CORS(最外层) -> TenantContext -> Sampling -> Trace -> RouteVersion
   - 实际注册顺序：BodySizeLimit -> RequestContext -> TenantContext -> AuthContext -> Sampling -> Trace -> RouteVersion -> CORS
   - 由于 Starlette `add_middleware` 是 inside-out 包装，TenantContext 在 AuthContext 之前导致 AuthContext 注入的 tenant_id 可被 TenantContext 覆盖
   - **建议**：正确顺序应为 CORS -> BodySizeLimit -> RequestContext -> Sampling -> Trace -> RouteVersion -> TenantContext -> AuthContext

### 中等

2. **QuoteV2Response `status` 字段类型不一致**
   - `shared/contracts/quote.ts` 中 `QuoteV2ResponseSchema.status` 为 `z.string()`（无约束）
   - 后端 `app/schemas/quote_v2.py` 中注释声明状态枚举但未用 Literal 约束

3. **Events Schema 前后端契约严重不一致**
   - `shared/contracts/events.ts` 定义了 6 种 event_type 的 payload schemas
   - 后端 `app/schemas/events.py` 仅有一个极简的 `EventResponse` 模型，没有任何 payload schema 定义
   - 后端实际的 payload 校验在 `app/api/schema_registry.py` 和 `app/domain/schema_registry.py` 中，但存在重复定义且结构不同

4. **Admin Schema 与 shared/contracts/admin.ts 字段名不一致**
   - `shared/contracts/admin.ts`：`tenant_id` + `name` + `is_active`
   - 后端 `app/schemas/admin.py`：`tenant_id` + `display_name` + `enabled`
   - 字段名完全不同，前后端对接时会产生映射错误

5. **Capabilities Schema 字段缺失**
   - `shared/contracts/capabilities.ts` 中 `CapabilitySchema` 包含 `is_active: boolean`
   - 后端 `app/schemas/capabilities.py` 中 `CapabilityItem` 没有 `is_active` 字段

6. **`app/domain/schema_registry.py` 与 `app/api/schema_registry.py` 重复定义**
   - 两个文件都定义了相同的 payload schemas，但结构不同
   - domain 版是扁平的 `Dict[str, type[BaseModel]]`（无 version 维度）
   - api 版是 `Dict[str, Dict[int, type[BaseModel]]]`（有 version 维度）
   - domain 版未被引用，形成死代码

7. **`QuoteRequest` (V1) 前后端字段不一致**
   - `shared/contracts/quote.ts` 中 `QuoteRequestSchema` 包含 `session_id` + `customer_id` + `items[]`
   - 后端 `app/schemas/quote.py` 中 `QuoteRequest` 完全不同的字段结构
   - V1 契约已废弃但未清理

### 轻微

8. **数据库模型 `bundle_size` 字段类型与 Schema 不一致**
   - `models.py` 中 `ProductSpec.bundle_size` 为 `Column(Integer)`
   - `shared/contracts/quote.ts` 中 `AccessoryRequestSchema.bundle_size` 为 `z.number()`（未限定 int）

9. **EventCreate 接口缺少 schema_version 必填校验**
   - `shared/contracts/events.ts` 中 `EventCreate` 是 TypeScript interface（非 zod schema）
   - `schema_version` 为 `number` 类型但无运行时校验

10. **前端类型复用存在重复定义**
    - `frontend/src/lib/events/types.ts` 中 `PendingEvent` / `DeadLetterEvent` 与 `shared/contracts/events.ts` 中 `EventCreate` 字段高度重叠但未复用

---

## 五、测试与CI/CD（10个问题）

### 严重

1. **DB测试全部失败（96 errors）**
   - `backend/orchestrator/tests/` 中所有标记 `@pytest.mark.db` 的测试因无法连接 PostgreSQL（localhost:5432）而报错
   - 本地开发环境无自动启动测试数据库的机制，开发者无法本地验证
   - 文件：`tests/test_quote_api.py`, `tests/test_quotation_api.py` 等

2. **2个单元测试失败**
   - `test_body_limit.py::test_raw_text_too_long_returns_422` — Pydantic 校验逻辑问题
   - `test_knowledge_provider.py::test_service_search_returns_empty_list` — 空数据返回不符合预期

3. **13个核心服务模块零测试覆盖**
   - `app/services/` 下 15 个模块中仅 4 个有测试
   - 缺失：`quote_engine`, `quote_script_renderer`, `freight_calculator`, `accessory_pricing`, `conversation_orchestrator`, `llm_client`, `spec_matcher`, `wechat_adapter`, `niulanwang_pricing`, `knowledge_service`, `http_utils`, `quote_templates`

### 中等

4. **8个API模块零测试覆盖**
   - `app/api/` 下 17 个模块中仅 9 个有测试
   - 缺失：`dashboard.py`, `events.py`, `pricing_data.py`, `product_specs.py`, `quote_v2.py`, `schema_registry.py`, `wechat.py`, `deps.py`

5. **2个测试文件未标记 pytest marker**
   - `test_auth_wx_r1.py`（34个测试）和 `test_tenant_isolation.py`（29个测试）未设置 `pytestmark`
   - 导致 CI 中 `-m unit` 和 `-m db` 筛选时行为不可预测

6. **E2E测试存在13处硬编码 waitForTimeout**
   - `frontend/e2e/` 中 13 处 `page.waitForTimeout()`（200ms~2000ms 不等）
   - 特别是 `quote-real-backend.spec.ts` 中 1000ms 等待立柱规格加载，网络波动即失败

7. **CI无测试覆盖率报告和产物上传**
   - `.github/workflows/` 三个工作流均未配置覆盖率收集
   - 失败时无法查看详细报告

8. **契约检查仅覆盖2个维度**
   - `scripts/contracts-check.ts` 仅检查 event_type 一致性（R0）和 quote 字段映射（R1）
   - 未覆盖：auth API 契约、capabilities 契约、quotation 契约、events payload 结构、前端路由与后端 API 路径一致性

9. **Dockerfile无多阶段构建优化**
   - `backend/orchestrator/Dockerfile` 单阶段构建，未分离编译依赖和运行依赖
   - `docker-compose.yml` 中 backend 服务挂载整个代码目录用于热重载，但生产环境无区分

10. **前端Vitest单元测试仅8个文件**
    - `frontend/src/**/*.test.ts` 仅 8 个文件，覆盖辅助函数
    - 零组件级单元测试，所有 UI 组件依赖 E2E 覆盖

### 补充发现
- 前端 E2E 缺少关键路径：无登录/认证流程测试、无错误边界测试、无移动端响应式测试
- `backend-test.yml` 分支过滤缺失：未限定 `branches: [main]`，任何分支 push 都触发
- `test_auth_wx_r1.py` 中部分测试使用 `client` fixture（需DB），但文件被当作 unit 测试运行时会失败

---

## 优先修复建议（按影响排序）

### P0 — 立即修复

1. **JWT_SECRET 默认值安全风险** — 生产环境必须强制设置强密钥
2. **中间件注册顺序错误** — 可能导致 tenant_id 被错误覆盖，影响多租户隔离
3. **DB测试96个全部失败** — 无法本地验证，严重阻碍开发效率
4. **API层直接操作DB** — 违反分层架构，维护困难，需逐步下沉到repository

### P1 — 本周修复

5. **硬编码客户成本数据外置化** — `seed_dev.py` 中的商业敏感数据应移出代码
6. **Events Schema 前后端不一致** — payload 结构未对齐，可能导致运行时错误
7. **Admin/Capabilities Schema 字段名不一致** — 前后端对接会产生映射错误
8. **2个单元测试失败** — 影响CI可靠性
9. **`JSONResponse` 与 `response_model` 混用** — 18处类型安全破坏
10. **useEffect+fetch 反模式** — `pricing-data/page.tsx` 应使用 TanStack Query

### P2 — 排期修复

11. 权限校验代码提取统一函数
12. N+1查询批量优化
13. 13处 E2E 硬编码 waitForTimeout 替换为 waitForSelector
14. schema_registry 重复定义清理
15. Dockerfile多阶段构建优化
16. 前端组件级单元测试补充
17. 契约检查覆盖 auth/capabilities/quotation 维度
18. 错误边界在业务页面推广使用

---

## 正面评价

- **认证体系**：bcrypt 密码哈希 + JWT 验证机制规范，sanitizer 日志脱敏机制完善
- **架构设计**：中间件链设计合理（tenant/trace/sampling/route_version/rate_limit/body_limit），分层架构清晰
- **前端架构**：TanStack Query + zod + react-hook-form 在核心模块使用规范，MSW mock 机制完整
- **契约层**：shared/contracts 共享类型设计良好，前后端类型共享思路正确
- **容器化**：Docker Compose 一键启动基础设施，开发体验良好

---

*报告由 Claude Code 自动生成，检查范围涵盖 91 个 Python 文件、131 个 TypeScript/TSX 文件、13 个共享契约文件、34 个测试文件。*
