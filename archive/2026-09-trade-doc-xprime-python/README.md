# 归档：单证渲染的 Python 实现（已被前端 TS 实现取代）

**归档日期**：2026-09-26
**原因**：单证渲染改为**前端实现（X′ 方案）**，本目录是历史实现，已移出构建路径。

## 为什么换实现

本项目架构是「`orchestrator` 开发 → 手工同步到 `worker/main.py` 单文件上线」。
线上 Worker 为控制体积刻意裁剪到 6 个依赖，**不带模板引擎**——
结果是线上只能「开单存库」，`/trade-docs/{id}/render` 直接 404，**渲染不出单据**。
而预览与打印本来就发生在浏览器里，模板也天然属于前端静态资产。
所以渲染归前端：预览零网络往返、线上不再有断层，并且**只有一份实现**（避免双实现漂移）。

## 归档内容

| 归档路径 | 原位置 | 说明 |
|---|---|---|
| `app/templates/trade_docs/` | `backend/orchestrator/app/templates/trade_docs/` | 18 类模板 HTML + 共享打印样式 + 字段清单 |
| `app/renderers/trade_doc_renderer.py` | `backend/orchestrator/app/renderers/` | Python 渲染器（22.8KB） |
| `app/api_trade_doc_render.py` | `backend/orchestrator/app/api/trade_doc_render.py` | 后端渲染/模板路由（已从 `main.py` 摘除） |
| `sample_docs/` | `backend/orchestrator/sample_docs/` | 渲染样例产物 |
| `scripts/render_all_samples.py` | `backend/orchestrator/scripts/` | 样例生成脚本 |
| `tests/test_trade_doc_renderer.py` | `backend/orchestrator/tests/` | 43 个 Python 单测 |

## 替代实现在哪里

- 渲染器：`frontend/src/lib/trade-doc/render.ts`
- 模板与字段清单：`frontend/src/lib/trade-doc/assets.json`、`manifest.json`（模板 HTML 逐字复制）
- 测试（含**逐字节基准比对**）：`frontend/src/lib/trade-doc/__tests__/render.test.ts`
- 基准产物：`frontend/src/lib/trade-doc/__fixtures__/html/sample_*.html`

## 迁移等价性怎么保证的

迁移前先冻结 Python 版的**输出**（18 份样例 HTML）作为基准，
TS 版必须与之**逐字节一致**，任何差异直接测试失败。
> 实测这道关卡拦下了两处真实偏差：① Windows 文本模式写出的 CRLF 换行差异；
> ② 「看起来像数字的字符串」被误当金额格式化（`HS Code 7314410000` → `7,314,410,000.00`），
> 这在海关审单里就是「不符点」。靠肉眼是发现不了的。

## 注意

本目录**不是**运行时依赖，不要从任何 build / import 路径引用它。
保留它只是为了在需要追溯历史实现时有据可查；如需彻底删除，请先确认已不再需要。
