# W4 切换退役 Runbook（2026-10-21 起草，执行前需全部门面域迁移完成 + 金标全绿）

> 架构依据 ADR-008（TS 门面 + Python 内核）；前置=W3 Phase 2 全部域完成、金标 harness 双端全绿、
> 边缘 Worker 已部署且冒烟通过。**本 runbook 的每一步都可单独回滚**。

## 0. 前置检查清单（缺一不可）

- [ ] 门面域迁移完成：auth/customers/teams/orders/files/outreach/admin/workstations/intel/dashboard/meta
- [ ] 引擎域透传就绪：quotes/trade-docs/ai（KERNEL binding 已验证）
- [ ] ts-worker typecheck 0 / vitest 全绿；金标 harness 双端 diff 0（白名单外）
- [ ] 用户确认切换窗口（生产切流属「必须停下问」类别）

## 1. 密钥迁移（关键卡点，2026-10-21 实测结论）

**问题**：`JWT_SECRET` / `ADMIN_SETUP_TOKEN` / `RESEND_API_KEY` / S3 密钥等由历史会话写入 Python Worker，
CF 不返回 secret 明文 ⇒ 无法直接复制到 kaas-edge。

**推荐方案：切流时轮换 JWT_SECRET（一次性）**
1. 生成新强随机值（写入 `~/.dsh/secrets/`，不入仓）。
2. 用 **Cloudflare API 精确写入**（禁 PowerShell 管道，铁律）：`PUT /accounts/{id}/workers/scripts/{name}/secrets`，
   body `{name:'JWT_SECRET',type:'secret_text',text:<value>}`；对 `kaas`（内核）与 `kaas-edge`（门面）**写同一个值**。
3. 效果：已有用户 token 全部失效，用户需重新登录一次（可接受，切换窗口内一次性成本）。
4. 其他 secret（RESEND_API_KEY / ADMIN_SETUP_TOKEN / S3_ACCESS_KEY / S3_SECRET_KEY）：
   能拿到明文的一并写入 edge；拿不到的走「临时降级」：ADMIN_SETUP_TOKEN 缺失 → bootstrap 端点 503（不影响业务）；
   RESEND 缺失 → forgot-password 退化为 TODO:TS2 现状（3600s token 不发信，运维手工重置）；S3 缺失 → 文件走 R2 binding 落点，
   功能不缺（ADR-003 三级落点）。**每一项都要在切换验收报告里如实标注**。
5. 写入后必须真实链路验证：登录签 token → 调 `/api/v1/auth/me` 通过；旧 token 返回 401。

## 2. 静态资产切到门面

1. `kaas-edge` wrangler.jsonc 增加 `assets: { directory: "../../frontend/out" }` 与 SPA 回退（对齐 Python worker 现状）。
2. 保留 `/_headers`（immutable 缓存）；`frontend/out` 由 `NEXT_EXPORT=1 pnpm build` 产出（工作区静止时构建）。
3. 部署 edge（`cd backend/ts-worker && pnpm wrangler deploy`，注意 CF token env），用 workers.dev 域名冒烟：
   login 页 + 全部 `/_next/*.js` chunk 200 + `/api/v1/auth/me` 401 形状一致。

## 3. 域名切分（切换窗口内执行）

1. `kaas-edge` 增加 routes：`kaas.powervoy.com` + `api.kaas.powervoy.com`（custom_domain）。
2. `kaas`（Python 内核）移除这两个自定义域名，保留 `workers_dev` 关闭 + 可选内部域（调试用，如 `kernel.kaas.powervoy.com`，需用户确认是否暴露）。
3. 顺序：先给 edge 加域名（Cloudflare 会等待证书）→ 验证 → 再移除 kernel 域名（避免空窗）。
4. 验证：`/health`（edge 返回 `service=kaas-edge`）、登录、核心列表页、单证页（透传）、cron 不受影响（仍在 kernel）。

## 4. 冒烟与验收（全部通过才算切流成功）

- [ ] `GET /health` 200 `service=kaas-edge`；`shared.loaded` 语义由 kernel health 透传/或 edge 自报
- [ ] 登录成功 / 错误密码 401 / 无 token 401；旧 token 401（若轮换）
- [ ] 客户/团队/订单列表 200 且形状与 Python 基线 diff=0
- [ ] quotes 透传端点 200/401 与 Python 一致；trade-docs 渲染路径抽 1 单验证
- [ ] 金标 harness：`--left <edge> --right https://api.kaas.powervoy.com`（内核内部域）facade401 + smoke 全 0
- [ ] cron 3 条仍在 kernel 触发（tail 日志有记录）
- [ ] 观测 30 分钟：5xx 率、P95 延迟、登录失败率

## 5. 回滚（任何一步失败）

1. 域名回切：edge 移除自定义域名 / kernel 重新加回（wrangler 部署回上一个 version：`wrangler versions deploy <prev>@100%`）。
2. JWT_SECRET 若已轮换：回滚后仍需把新值写入 kernel（否则用户全部掉线）——**先确认两边 secret 一致再做域名回切**。
3. 保留窗口：切换成功后 **2 周**内 kernel 原域名/旧版本不删，随时可回滚；
4. 2 周后清理：删除 kernel 旧自定义域名、旧 Hyperdrive 旧配置、旧 Neon 旧项目（破坏性，需用户确认）。

## 6. 收尾（W4 文档口径）

- 根 README / HANDOVER / AGENTS 技术栈基线改 TS 门面口径；
- `check-worker-bundle.py` 增加 edge 包体积断言（当前 ~110KB gzip 3.1MB? 实测 60.48KiB raw）；
- Python 侧内核瘦身：迁出域代码从 main.py/ws_* 删除，main.py ≤3000 行，结构债阈值收紧；
- STRUCTURAL_DEBT S-1/S-2 以「被 W3 解决」销账；W5 MCP/REST 立项开始。

---

*本 runbook 由 lead 起草于 2026-10-21；执行前需用户确认切换窗口，执行后回填实测数字。*
---

## 7. 执行记录（2026-10-21 12:40–13:00，用户裁决「直接切流，不用等低峰期」）

| 步骤 | 结果 |
|---|---|
| 前端静态导出 | `NEXT_EXPORT=1 pnpm build` → `frontend/out` ✅ |
| 门面预发部署 | `kaas-edge` workers.dev 子域，版本 `8312b518` → 修 KERNEL binding 后 `db62066a` → 404 信封修复 `e87a26a9` |
| JWT_SECRET 轮换 | 新随机值写入 `~/.dsh/secrets/jwt-secret-20261021.txt`；经 **CF API 精确写入** kaas + kaas-edge（response success=true 双端）；自签 token 调双端 `/me` **均 200 且 11 键形状一致** ⇒ secret 同步验证通过；**既有用户 token 已失效（需重新登录一次）** |
| 预发金标 | edge(workers.dev) vs 生产 Python：13/17 一致 → 修 404 信封后 **15/17**；仅剩 `/health`（身份差异）与 `/openapi.json`（有意 JSON 化） |
| 内核摘域名 | `backend/worker/wrangler.jsonc` routes → `[]`，部署版本 `25133623`（3 条 cron 保留）；内核不再有公网域名，门面经 Service Binding 调用 |
| 门面接域名 | `backend/ts-worker/wrangler.jsonc` 增加两条 custom_domain，部署版本 `8f1c2129` → 接管 kaas./api. 两个域名 |
| 切后冒烟（全部 200/401 符合预期） | `/health` = `kaas-edge`；`/login` `/` 200；`api.kaas.powervoy.com/health` 200；`/api/v1/auth/me` 无 token 401 / 带 token 200（11 键一致）；customers/teams/orders 200（门面直连 DB）；**quotes / trade-docs / export-quote/products / pricing-data 经 KERNEL 透传 200/422 正常**；静态资产 `immutable` 头生效 |
| 回滚路径 | 内核版本 `25133623` 仍在（cron 常驻）；回滚 = 内核 wrangler 恢复 routes + 部署 → 门面移除 routes + 部署；JWT_SECRET 两边同值，回滚后用户无需再次重登 |

**遗留/待观察**：① 下一次 cron（*/15）执行后核对内核日志；② 门面 `workers_dev` 暂留 true（调试用），验收期后改 false；
③ 内核旧版本保留 2 周（W4 观察窗口），期间不回滚即清理；④ **旧 Neon 项目与旧 Hyperdrive 已于 2026-10-21 删除**（用户授权；回滚改为应用层回滚，见 ARCH_DECISIONS ADR-007 附注）。
