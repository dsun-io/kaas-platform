# 契约与 mock 覆盖：用户裁决（2026-10-11 第三批）

> **性质**：用户裁决的原始记录 + 由裁决决定的下一步。
> 与另两份文档的关系：
> `docs/ADMIN_TENANTS_CONTRACT_REPORT.md`（只读分析，310 行）是**输入**；
> `docs/PRODUCT_MODULE_DECISIONS.md` 管产品模块；本文管**契约一致性**与 **mock 覆盖**。

## 一、用户裁决（原文照录）

| # | 问题 | 用户裁决 |
|---|---|---|
| **P1** | `/admin/tenants` 契约以谁为准 | **以前端消费契约为准**（= mock 现状） |
| **P2** | 租户显示名统一到哪个键 | **统一到 `display_name`** |
| **P4** | `/admin/tenants/reload` 要否返回清单 | **要返回清单** |
| **M1** | ~119 个端点无 mock handler 怎么办 | **按 e2e 实际用到的路由补** |

### P2 为什么选 `display_name`（回答用户"分别有什么作用"）

"租户显示名"这个字段在仓库里有**三种用法**，且**真正决定屏幕上显示什么的是渲染层**：

| 谁 | 键 | 作用 |
|---|---|---|
| `frontend/src/lib/.../use-tenants.ts:8`（列表查询） | `name` | 决定向后端要什么 |
| 同文件 `:20`（重载后） | `display_name` | 同上 |
| **真正渲染的组件**（`settings/components/types.ts:3-7` + `tenant-list.tsx:41-49`） | **`display_name`**（还读 `locale`/`region`/`is_active`） | **决定屏幕显示什么** |

⇒ 统一到 `display_name` 只改**查询 hook 一处**，**渲染层零改动**；统一到 `name` 则要改渲染层 ✗

## 二、由裁决决定的下一步（按顺序）

### S1（前置）e2e 实际用到的路由与端点清单 —— 本步是 M1 的输入
- 产出：**e2e 访问的路由 → 该路由用到的 `apiClient` 端点**清单（含已覆盖 / 未覆盖标记）
- 有了它才谈"补哪些 mock"，否则无从下手

### S2 按清单补 mock（gated）
- 只补清单里**未覆盖**的端点；**不做全量 119 个**（用户裁决 M1）
- 每个 handler 必须**核对消费方源码**取形状；写法沿用 task-4/task-6 已验证的做法
  （同一份 handlers 起 MSW node server + "改错方法名必失败"的反证测试）

### S3 `/admin/tenants` 契约统一（P1 + P2 + P4）
- 以**前端消费契约**为真源：`GET {tenants:[{tenant_id,name→display_name,is_active}]}`、
  `POST {reloaded_count, active_tenants:[...]}`
- ⚠️ **改 worker = 改生产**（`deploy.yml:65-104` 只部 worker，无 orchestrator 部署作业）
  ⇒ 顺序建议 **worker 先、orchestrator 后（保留旧键兼容）**
- ⚠️ **形状可统一、内容统一不了**：worker 单租户部署永远返 1 条（`main.py:2288` 注释 UNCERTAIN #13），
  reload 是**记账 no-op** ⇒ **不要为了"看起来一致"伪造多条**
- ⚠️ **当前撞车**：另一条任务正在改 `backend/worker/src/main.py`
  ⇒ **本步要等它让出该文件**，否则会冲突

### S4 新增门禁 R5（防止再漂）
- `route-parity.py` **只比对路径存在性**（两侧路径都在 ⇒ 今天绿的）
- `contracts:check` R0–R4 **没有 admin 端点规则** ⇒ 现有门禁**一条都抓不到**这类不一致
- 建议照 R0/R2 的套路新增 **R5**：把"共享形状声明 + 两端响应键集合"三方比对

## 三、本轮附带发现的**三个真实缺陷**（登记，待排期）

1. **`PATCH /customers/:id/stage`**：后端有 **409 二次确认门**（won/lost 且有 open 询盘时，
   `customers.py:367-373`），而前端**从不发** `close_all_open`、**没有确认弹窗**，
   且错误渲染 `page.tsx:124-130` 会把**对象型 detail 塞进 JSX** ⇒ **React 崩** ✗
2. **`POST /customers/:id/inquiries` 的 channel**：后端是**大小写敏感枚举**（6 值，`enums.py:25/90`），
   前端是自由文本且 placeholder 写着「Alibaba / Expo / Web」（`page.tsx:302-306`）
   ⇒ **照提示填 "Alibaba" 在 real 模式就是 422** ✗
3. **`GET /admin/feature_flag`**：worker 版**要 `flag_name` 且返单值**（`main.py:2237-2246`），
   orchestrator 返 `tenant_id→flags` 映射，前端按映射消费
   ⇒ **real 模式灰度页所有开关恒显示 OFF** ✗
   （与 task-4 修掉的 mock 症状**表现相同、原因不同** —— 这次在 worker）

## 四、已完成的模拟/契约修复（供追溯）

| 提交 | 内容 |
|---|---|
| `495d72a` | 客户列表/详情响应形状对齐后端契约（修 mock 模式客户 **0 行**） |
| `5e8fbb4` | 灰度开关按租户号做 key（原用客户风格 id ⇒ 开关**恒 OFF**） |
| `ec64137` | 补 5 个写操作 handler（`POST /customers`、`PATCH …/stage`、`…/inquiries`、`…/contacts`、`POST /auth/register`）+ 10 条回归测试 |
| `1938dbe` | `/admin/tenants` 契约不一致报告（只读分析） |

**门禁**：mock 侧 `test` **26 files / 335 tests 全绿**；`typecheck` exit 0；`lint` 无 error
（**未跑 `next build`** —— `frontend/.next` 让给 e2e 线）
