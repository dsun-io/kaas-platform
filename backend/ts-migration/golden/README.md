# Golden Harness 原型（金标对照）

W3 Phase 0 交付物之二：迁移质量主门禁的原型（计划 §2 Phase 0 第 2 条）。
同一份请求清单分别打两个 base URL，按 **JSON 语义 diff** 对比响应，
输出 markdown 报告。将来左 = 本地 Python worker，右 = 本地 TS worker（Hono）；
当前阶段右端可直接用生产做基线。

## 文件

| 文件 | 说明 |
|---|---|
| `diff_responses.py` | harness 本体，纯标准库（urllib），两个 venv 的解释器都能跑 |
| `smoke-vs-prod.report.md` | 2026-10-21 首次 smoke 对生产基线的报告存档（左端未起服务，5 条全记录为连接失败，右端基线形状全部符合预期） |

## 用法

```powershell
# 解释器：backend/orchestrator/.venv/Scripts/python.exe（或 worker 的 venv；PATH 的 python 是坏的）
$py = "backend/orchestrator/.venv/Scripts/python.exe"

# smoke 清单（5 条无副作用请求）对生产基线（写成单行，避免 PS 续行符）
& $py backend/ts-migration/golden/diff_responses.py --left http://localhost:8000 --right https://kaas.powervoy.com --only smoke

# 自测（两端同 URL，应 5/5 一致）
& $py backend/ts-migration/golden/diff_responses.py --left https://kaas.powervoy.com --right https://kaas.powervoy.com --only smoke

# 报告写文件：追加 --out report.md
```

退出码：0 = 全部一致；1 = 有差异/某端失败；2 = 用法错误。

## 内置 smoke 清单（5 条，全部 side_effect=none）

| # | 请求 | 期望 | 说明 |
|---|---|---|---|
| 1 | GET /health | 200 | 存活探针 |
| 2 | GET /openapi.json | 200 | 全表面契约快照（注意：生产当前返回 text/html，疑似 SPA fallback，见「已知发现」） |
| 3 | POST /api/v1/auth/login（不存在账号+错误密码） | 401 | 探 401 形状，**不碰真实账号** |
| 4 | GET /api/v1/auth/me（无 token） | 401 | 鉴权闸门 |
| 5 | GET /api/v1/auth/me（非法 Bearer） | 401 | 鉴权闸门 |

## JSON 语义 diff 规则

- 白名单字段忽略（显式登记，计划 §2 风险表要求"不静默放过"）：
  - 精确键名：created_at / updated_at / deleted_at / 各类 token /
    expires_* / issued_at / last_login_at / timestamp / request_id /
    trace_id / nonce / jti / password_hash 等；
  - 正则：(_at|_token|_timestamp|_hash)$ 与 JWT claims iat/exp/nbf。
- 列表按序比较；长度不同即差异。
- 数字默认精确比较；--float-tolerance 留给 Decimal→number 漂移期。
- status 与 body 类型（json/text）不一致都算差异。

## 生产纪律（硬约束）

1. 只打 side_effect == "none" 的请求；命中 kaas.powervoy.com 时若清单含
   写操作请求，脚本直接拒绝执行（防护在代码里，不靠自觉）。
2. auth 端点 zone 限流 5 次/10 秒/IP（2026-10-20 口径）：--delay 默认
   2.0 秒，**不要调小**；每条 smoke 里 login 类请求最多 1 次。
3. 本地 worker 起服务需要 DB/Hyperdrive binding（local_run.py），不属于
   本原型范围；左端没起时报告如实记录连接失败（见存档报告）。

## 已验证（2026-10-21）

- py_compile 通过；--list 正常。
- 生产基线右端：5 条 smoke 形状全部符合预期（200/200/401/401/401）。
- 自测 prod vs prod：5/5 一致，diff 引擎行为正确。
- 左端 localhost:8000 无服务，5 条如实记为"左端失败"（exit=1），报告见
  `smoke-vs-prod.report.md`。

## 已知发现（交给 Phase 1+）

- 生产 GET /openapi.json 返回 **text/html**（应为 application/json）——
  疑似 Cloudflare 侧 SPA 资产 fallback 把未命中路径兜成了 index.html。
  TS 迁移时要决定：Hono 侧显式服务 openapi.json，还是保持现状并登记为
  金标差异。

## 路线图（Phase 0 后续）

1. 从 `../route-inventory.md` 生成全量请求清单（按域分批，先
   auth/customers/quotes 三域），写操作请求打本地双跑环境。
2. 清单支持模板变量（token 注入：先 login 拿 token 再带 token 回放）。
3. 报告接入迁移看板（按域统计 parity 百分比）。
