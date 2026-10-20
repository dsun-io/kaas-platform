# S5 预览环境脚本

PR 级预览环境的资源管理脚本（README §2 目标态矩阵；2026-10-20 用户裁决全量做）。
CI 编排见 [`.github/workflows/preview.yml`](../../.github/workflows/preview.yml)。

## 命名约定（全套同源：slug = PR 号）

| 资源 | 名字 | 说明 |
|---|---|---|
| Neon 分支 | `preview-pr-<num>` | 从根分支（production）派生，写时复制 |
| Hyperdrive config | `kaas-preview-<num>` | 指向该 PR 的 Neon 分支（pooler 主机） |
| 预览 worker | `kaas-preview-pr-<num>` | 只挂 workers.dev，**不挂生产域名** |
| R2 键前缀 | `pr-<num>/` | 桶 `kaas-preview-storage`（所有 PR 共享） |
| KV 键前缀 | `pr-<num>:` | namespace `KAAS_PREVIEW`（所有 PR 共享） |

## 脚本一览

| 脚本 | 用途 | 典型调用 |
|---|---|---|
| `preflight.py` | CF token 权限校验（verify + policies 四项权限；读不到 policies 降级探针） | `python3 scripts/preview/preflight.py` |
| `ensure.py` | 建/复用 Neon 分支 + endpoint + Hyperdrive config，输出注入参数 | `python3 scripts/preview/ensure.py --pr 123` |
| `render-wrangler-config.py` | 从生产 wrangler.jsonc 渲染预览配置（去 cron/域名、换绑定、注 PR_SLUG） | 见 workflow |
| `assert-bindings.py` | S5-d 防污染断言：核对**线上真实绑定**（`--pre-deploy` 只核渲染产物） | 见 workflow |
| `teardown.py` | 回收 worker + Neon 分支 + Hyperdrive + KV/R2 前缀（删除带生产双保险校验） | `python3 scripts/preview/teardown.py --pr 123` |

公共库 `preview_lib.py`（Neon/CF API 客户端、dry-run Runner、日志/输出）。
**纯标准库**，CI 的 python3 直接可跑，不许引入三方依赖。

## 环境变量契约

| 变量 | 性质 | 用途 |
|---|---|---|
| `NEON_API_KEY` | secret | Neon API（CI 注入；**严禁写进任何文件**） |
| `NEON_PROJECT_ID` | secret/variable | Neon 项目 |
| `CLOUDFLARE_API_TOKEN` | secret | CF API（需 Workers Scripts/Hyperdrive/R2/KV 四项 Account 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | secret/variable | CF 账号 |
| `KAAS_PREVIEW_KV_NAMESPACE_ID` | **variable** | 预览 KV namespace（本机已建：`c77ab8c9c3a3422aa09c2afdc33f6974`） |
| `KAAS_PREVIEW_R2_BUCKET` | **variable** | `kaas-preview-storage` |
| `PROD_R2_BUCKET` / `PROD_HYPERDRIVE_ID` | **variable** | 防污染断言的期望值/禁用值（现名 `kaas-files` / `f53fed49…`） |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_ENDPOINT` | secret（可选） | teardown 的 R2 对象清理；不配则打印手动清理指引 |

资源标识只从环境变量读（代码零硬编码机密；共享预览资源标识是 variable 不是 secret）。

## 本机手测

```powershell
# dry-run：只读 GET + 打印将执行的动作（不发任何写请求）
$env:NEON_API_KEY="..."; $env:NEON_PROJECT_ID="falling-salad-31662168"
$env:CLOUDFLARE_API_TOKEN="..."; $env:CLOUDFLARE_ACCOUNT_ID="..."
python scripts/preview/ensure.py --pr 123 --dry-run

# 真实全链路（会产生/回收少量云资源）
python scripts/preview/ensure.py --pr 123
python scripts/preview/teardown.py --pr 123
```

## 红线（README §2.3）

- 只动名字带 `preview` 的资源；**绝不碰** Neon 根分支/production、
  `kaas-prod-hyperdrive`（生产 Hyperdrive）、`kaas-files`（生产桶）。
- Neon 删除有双保险校验（根分支 parent_id 为空 + name == production，任一命中即拒删），
  不依赖 Neon Protected 设置本身。
- 预览配置渲染时剥离 cron triggers 与自定义域名；预览库只承载人工流量。
