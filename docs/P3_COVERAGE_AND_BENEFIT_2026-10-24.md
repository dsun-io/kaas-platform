# P3 迁移覆盖率与收益量化（2026-10-24 23:10）

> 本文用**机检数据**回答两个交接时最容易被含糊过去的问题：
> ① 「可迁清单真的清空了吗？」② 「迁完之后内核/init 暴露面到底降了多少？」

## 1. 覆盖率审计（机检，非文档自述）

数据源：`backend/ts-migration/routes.json`（280 业务路由）× `backend/ts-worker/wrangler.jsonc` 白名单（44 个 route id）
× `src/index.ts` 的 12 个 `createProxyApp` 前缀 × 门面实现清单（engine.ts / misc-read.ts / quotes-read.ts / ai-read.ts / tax-rates-write.ts）。

**87 条 passthrough 全部归类，未归类 = 0：**

| 分类 | 条数 | 说明 |
|---|---|---|
| 已覆盖（门面直连 / 引擎切片） | **32** | 读多数在这里；写有 6 条（tax-archives / product-tax-rates 的 create/update/delete） |
| 判定留内核（业务元数据 / 字节流 / 写副作用 / 出站探针） | **14** | ai.tasks、ai.task-bindings、terms/template、fx-rates/latest、_debug、clause-templates、external-docs 下载、receipts、doc-set、fingerprint×2 |
| 方案 A 例外（跨表事务写） | **41** | 取号 / 状态机 / 多表同事务（报价单、单证签发、导入落库…） |
| **未归类** | **0** | ✅ 机检确认「可迁清单已清空」 |

> 结论：**能迁的都迁完了**，剩下 41 条写事务 + 14 条留内核是**已裁决的例外**，不是遗漏。
> 复核脚本口径见本文末尾（可重跑）。

## 2. 收益量化：Pyodide init 暴露面下降 62%

数据源：Cloudflare GraphQL `workersInvocationsAdaptive`（script=`kaas`，逐小时，2026-10-24 08:00Z→15:00Z）。

| 时段 | 迁移状态 | 内核 invocation/小时 |
|---|---|---|
| 08:00Z–09:00Z | 只迁了 P0 五条热读 | 81 / 68（平均 **74**） |
| 13:00Z–14:00Z | 14 引擎切片 + 12 纯 SQL + 6 写路径全部放量 | 41 / 15（平均 **28**） |

**⇒ 内核调用频次下降 62%**，且 **08:00Z 之后每一小时 `scriptThrewException` 都是 0**。

这意味着：
1. 「页面能否打开」不再依赖 Pyodide 初始化（认证/热读/大部分只读都在门面直连 Hyperdrive）；
2. Pyodide init 的**触发次数**降到原来的 ~38%，同样概率的 init 失败对用户的影响面同比缩小；
3. 剩下的 28/h 中，绝大部分是 `/api/v1/internal/engine/*` 纯算 RPC（tail 证据见工单 §9.2/事故文档）。

> 诚实边界：这是**同一天内的对比**，流量构成也变了（尤其是 cron 与重试），所以不能把 62% 全部归因于「迁移」；
> 但「哪些请求必须进内核」这一件事是确定的 —— 32 条端点不再进内核。

## 3. 复杂度与维护收益

| 项 | 迁移前 | 现在 |
|---|---|---|
| 内核「自己连库」的模块 | 全站（23 模块 / 340 处 DB 调用） | **同一份基线**，但已加 CI 门禁：清单外不得新增、清单内**只减不增**（`scripts/check-kernel-db-allowlist.py`） |
| 双份实现风险 | 迁移中必然出现（门面 + 内核） | 已登记 **25 个可删的内核 GET handler**（删除清单见 `docs/P3_PASSTHROUGH_DISPOSITION_2026-10-24.md` §8） |
| 回退方式 | 改 `AUTH_DB_SPLIT` 一个 flag | 仍可用 flag（**在删除内核 handler 之前**）；删 handler 后回退=回滚代码 |

## 4. 复核命令（可重跑）

```bash
# 覆盖率审计（需要 node）
node .tmp-coverage.js        # 脚本内容见 git 历史；口径：87 passthrough × 门面实现清单
# 内核 DB 门禁
python -m scripts.check-kernel-db-allowlist  # 或 backend/orchestrator/.venv/Scripts/python.exe scripts/check-kernel-db-allowlist.py
# 收益量化
#   GraphQL: workersInvocationsAdaptive(scriptName="kaas", datetimeHour 08:00Z→15:00Z)
```
