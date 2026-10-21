# 路由分类：门面移植 vs 内核透传（W3 Phase 2 执行口径，2026-10-21）

> 依据：docs/OPTIMIZATION_PLAN_2026-10-21.md §2.0（ADR-008 两层架构）+ route-inventory.md（253 路由）。
> 分类原则：**UI 面 CRUD/鉴权/配置类 → 门面（Hono）逐端点移植；引擎/渲染/AI/cron → Python 内核，
> 门面只做「鉴权 + 协议转换 + 透传」（KERNEL service binding），不逐端点重写**。
> 铁纪律：透传层不得改写业务语义；错误信封统一为 `{error:"kernel_error",message,status}`（5xx）/ 原样透传（4xx）。

## 1. 汇总

| 种类 | 域 | 路由数 | 处理 |
|---|---|---|---|
| **门面移植** | auth 9 / customers 20 / teams 15 / orders 16 / files 9 / outreach 12 / admin 11 / workstations 35 / intel 34 / dashboard 1 / meta 1 | **≈163** | Hono 逐端点实现（业务规则经 KERNEL，不重写） |
| **内核透传** | quotes 38 / trade-docs 38 / ai 8 / cron 2 | **≈86** | 门面 /api/v1/{quotes,trade-docs,ai}/* → KERNEL.fetch 透传 |
| FastAPI 内置 | /openapi.json /docs /redoc 等 4 条 | 4 | 门面自实现（openapi）或不做（docs 内部用） |

合计 249 业务路由 + 4 内置 = 253（与 route-inventory 核对一致）。

## 2. 为什么透传而不是移植

- **禁止第二份实现**（AGENTS 铁纪律）：quotes/trade-docs 的核心是 kaas_common 引擎（报价计算/单证 facts/render），
  在 TS 重写即第二份实现，必然漂移。
- 透传层只做三层职责：① 复用门面鉴权（JWT 校验后转发）；② 路径/头转换（保留 Authorization）；③ 错误信封归一。
- 迁移收益仍兑现：UI 的所有请求都先过门面（冷启动 ~50ms），透传一跳 ~5ms 内，用户无感。

## 3. 透传实现契约（Phase 2 落地）

```
// src/proxy.ts（示意）
app.all('/api/v1/quotes/*', auth, async (c) => {
  const res = await c.env.KERNEL.fetch(new Request(c.req.raw)); // 原样转发（含 body/headers）
  return new Response(res.body, { status: res.status, headers: normalizeCors(res.headers) });
})
```
- 鉴权：透传前门面校验 JWT（与 Python 同一 secret/claims）；**内核仍会二次校验**（双保险，不依赖单层）。
- 金标：透传路由的 diff 应为 0（除 CORS 头统一），纳入 golden harness 清单。
- 禁止：在透传层做参数改写、缓存、重试换语义。

## 4. 门面移植域的执行顺序（每域完成判据）

1. auth ✅（进行中）/ customers ✅（进行中）/ teams（进行中）
2. orders → files → outreach → admin
3. workstations → intel → dashboard/meta

每域 DoD：① 端点与 Python 形状一致（zod schema 从 pydantic 生成，禁止手抄）；② vitest 覆盖关键分支；
③ 金标 harness 对应 case 全绿；④ README 进度表更新。

## 5. 待办

- [ ] 透传层（proxy.ts）+ 3 个前缀挂载（quotes/trade-docs/ai）
- [ ] golden harness 请求清单扩至全部门面域的只读端点（无副作用）
- [ ] W5：MCP server 建立在门面（暴露工位能力 → 映射到上述路由）
