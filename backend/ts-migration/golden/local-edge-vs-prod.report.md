# 金标双跑报告：本地门面(kaas-edge) vs 生产 Python(kaas)

> 时间 2026-10-21；命令 `--left http://127.0.0.1:8787 --right https://kaas.powervoy.com --only smoke,facade401`。
> 本地门面用 wrangler dev --local 起（Hyperdrive 指向 Neon dev 分支，不碰生产库）。
> 结果：17 条中 10 条完全一致；4 条差异全部为**预期内**（下方登记）；其余为解析/展示。

## 已知差异登记（显式，不是静默忽略）

| 项 | 本地门面 | 生产 Python | 性质 |
|---|---|---|---|
| `GET /health` body | `{status:'ok',service:'kaas-edge'}` | `{status:'ok',service:'kaas-intel-worker',shared:{...}}` | **设计差异**：门面与内核身份不同；切流后 `/health` 由门面返回，需在 W4 验收口径中改为断言 `service=kaas-edge` |
| `GET /api/v1/quotes` | 503 `kernel_error: kernel binding not configured` | 401 | **本地环境限制**：wrangler dev 无 Service Binding（需同账号部署才有）；部署后应一致（验收需在预发环境重跑） |
| `GET /api/v1/trade-docs` | 同上 503 | 401 | 同上 |
| `GET /api/v1/ai` | 同上 503 | 404（生产无该前缀端点，历史形状） | 同上；另登记 `/api/v1/ai` 在 Python 侧本就 404，门面透传前缀是否保留待 W5 决策 |

## 一致性证据（10 条）

- smoke：openapi_surface（JSON 语义 diff 通过，白名单外字段一致——注意 Python 生产 openapi.json 实际 text/html 的已知差异）、login_unknown_account 401、me_no_token 401、me_invalid_token 401 等；
- facade401：auth/me、customers、customers/capabilities、teams、teams/me、orders、files、outreach、admin/feature_flag 全部 401 形状一致。

## 结论

本地可验证的 10 条全部一致；4 条差异均有明确解释且不涉及语义漂移。**下一步**：部署 edge 预发（需先落 secret 轮换口径，见 W4 runbook §1）后重跑本报告，预期只剩 `/health` 一个设计差异。
