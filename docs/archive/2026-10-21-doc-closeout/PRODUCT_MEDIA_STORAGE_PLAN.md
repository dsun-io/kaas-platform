# 文件与产品媒体：存储规划（2026-10-11）

> ⚠️ **已归档（2026-10-21）· 历史留档，不代表当前口径。** 归档理由与「生产 S3 直传不可用」结论摘要见
> [`README.md`](./README.md)；未收口项看 `docs/TODO.md` D2。归档内相对链接可能指向旧路径（校验排除 `docs/archive/**`）。

## 实施进度（2026-10-11 晚）

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 迁移 `202610110016`（三表）+ `202610110017`（版本化边界收窄 + 主图）+ `202610110018`（`sort_order`，见第 11 项） | ✅ **已在生产库执行** | 生产实测 file_objects **23 列**（016/017 后 22 列，018 加 `sort_order`）、索引 11 个 |
| 2 | 共享内核 `kaas_common/files`（校验 / key / 版本化 / 引用解析） | ✅ | **21** 条单测进 `-m unit` 门禁（含新增 `coerce_file_ref_id` 3 条） |
| 3 | orchestrator API（文件域 + 产品媒体；含直传端点） | ✅ | OpenAPI 实测 **170** 条路径（此前 167） |
| 4 | Worker 镜像 + **R2 binding**（桶 `kaas-files` 已建） | ✅ | worker `pytest` **176 passed**（当前）；`wrangler.jsonc` 已加绑定 |
| 5 | 前端 `/products` 产品管理页（基础信息 + 图片上传/命名/类型/**排序**/主图/下线） | ✅ | typecheck 0 / test **325 passed / 25 files** |
| 6 | 侧边栏入口（契约 ts+py 双向一致） | ✅ | `contracts:check` **R2 PASS（26 工位）** |
| 7 | 单证引用产品图：`{file_id}` → data URI（装配层解析） | ✅ 两端 | 渲染器**未改**（白名单不放开） |
| 8 | 盖章回传版本化（新版本上位、旧版留档） | ✅ 后端完成 | `POST /trade-docs/{id}/files/upload`（两端） |
| 9 | 单证编辑页「从产品图库选图」的**图形化选择器** | ✅ **已完成** | `trade-docs/components/doc-photo-picker.tsx`：选产品 → 点图 → 写入 `{"file_id": N, "caption": …}`；已添加的图标记「已添加」防重复引用 |
| 10 | 对象存储 **S3 直传实现 + R2 接线** | ✅ 实现完成并交叉验证 / ⏳ **生产直传待修密钥** | 见下「落点优先级与 S3 直传」：`kaas_common/files/s3.py`（8 条与 minio-py **逐字符一致**）+ `test_files_s3_roundtrip.py`（**15 条真回环**，文件域三件合跑 **41 passed**）；两端端点齐平；线上配置齐全（vars + 两 secret + `FILES` binding）。⚠️ **验收发现 `S3_ACCESS_KEY` 只有 13 位（R2 要求 32）⇒ 生产直传当前不可用**，服务端代理兜底可用；⏳ 待用户重建密钥 |
| 11 | 迁移 `202610110018`：`file_objects.sort_order`（**只新增列**） | ✅ **已在生产执行** | lead 实跑 `alembic upgrade 202610110018`；生产只读复核 = **23 列**、`sort_order` 默认 **0** |
| 12 | 产品图**排序**（两端同一口径 + PATCH + 前端上/下移） | ✅ | `_FILE_ORDER_BY = "is_primary DESC, sort_order, id"`（orchestrator `files.py:74` ↔ worker `ws_files.py:69`）；`sort_order` **0–9999**，越界 **422 `SORT_ORDER_OUT_OF_RANGE`**；worker 补 `FilePatch.caption` 使两端字段一致 |
| 13 | 公章**上传界面**（此前前端**无任何入口**） | ✅ | `settings/company-profile` 的 `CompanySealCard`；5 个端点与两端后端一一对应；**Canvas→PNG 是后端契约**（`validate_seal_image` 只认 PNG 魔数） |
| 14 | **默认公章自动带入**单据渲染（G1 单一真源） | ✅ | 共享内核 `kaas_common/files/seal.py`；两端 `apply_default_seal` 是**同一函数对象**（测试断言）；`sync-shared -Check` 共享内核 **27** 文件 |
| 15 | 三个缺陷修复（坏 `file_id` 500 / PDF 让位 / 前端两处） | ✅ | 见下「产品图排序与公章」§4：`coerce_file_ref_id`、让位扩到 `("stamp_scan","render_pdf")`、版本链改按后继件 `supersedes_id` |
| 16 | 生产**真实验收**（带登录 + 真直传尝试） | 🔶 **已执行；卡在密钥长度** | 经用户授权临时改 bcrypt 哈希 → 登录 → **立即改回**（复核：恢复后与备份**逐字一致**、新口令**不再匹配** ⇒ **生产数据最终未变**）；因 `PUT` 被拒**未创建任何测试记录**；生产 `users` 仅 **3 个账号**、**无联佳账号**、口令全为 bcrypt（不可还原） |
| 17 | 直传失败**自动回退服务端代理**（不静默） | ✅ | 见下 §8：`fellBackToProxy: true` + `fallbackReason`；UI 显示「已上传（直传失败：<原因>；已走服务端兜底）」；**`PUT` 成功但 `register` 失败 ⇒ 抛错不回退**；`configured=false` **不算回退**；`pnpm test` 实测 **28 files / 354 passed**（use-products **13 条**；**lead 实测**：4 条新用例在旧实现下会红）。**未覆盖**：`products/page.tsx` 的 `doUpload` |

> 字节落点的当前行为（按优先级）：① **S3 预签名**（配好 `S3_*` 时，浏览器直传，字节不过服务端）
> → ② **R2 binding**（`FILES`，生产 Worker 的平台直连）→ ③ **inline**（写 `file_objects.content` 兜底）。
> 本地 orchestrator 没有 binding，走到 ② 时直接 inline。**无论走哪条，真实落点都写进
> `file_objects.storage`** —— 上传是用户的显式动作，不能因为存储配置问题直接失败，也不会因此隐瞒数据在哪。

---

## 落点优先级与 S3 直传（2026-10-11 晚 · 当前实现）

### 1. 字节落点优先级

| 优先级 | 落点 | 触发条件 | 说明 |
|---|---|---|---|
| ① | **S3 预签名** | `S3_ENDPOINT` + `S3_ACCESS_KEY` + `S3_SECRET_KEY` 三项都配好 | 浏览器拿短时效 PUT URL **直传**，字节不过服务端；本地 = MinIO，生产 = R2 的 S3 端点 |
| ② | **R2 binding**（`FILES`，桶 `kaas-files`） | 没配 S3 密钥、且在 Cloudflare Worker 内 | 平台直连，无需密钥流转、不占 Worker 出口流量 |
| ③ | **inline**（写 `file_objects.content`） | 前两条不可用或抛异常 | 兜底：不把用户的上传动作变成 500 |

- 「什么算配好」只有**一条规则**：共享内核 `kaas_common/files/s3.py` 的 `s3_config()` ——
  `endpoint` + `access_key` + `secret_key` **同时**存在才算配好，否则返回 `None`（调用方据此回退）。
  两端各自判断必然漂移，症状是「本地进了对象存储、线上悄悄落库」。
- 本地 orchestrator 跑在 Cloudflare 之外、没有 binding，所以是 ① → ③。
- **无论走哪条，真实落点都写入 `file_objects.storage`**（`s3` / `inline`），可审计。
- Worker 侧 ① 失败会**降级到 ②**、② 失败再降级到 ③，每一步都留日志。

### 2. 新增共享内核 `backend/kaas_common/files/s3.py`

AWS **SigV4 预签名**，**纯标准库**（生产 Worker 跑 Pyodide、装不了 boto3，而预签名本质就是
「规范化请求 + HMAC-SHA256 链」）。同一份代码服务生产 R2（`region=auto`）、
本地 MinIO（`region=us-east-1`）与短时效直链。

**正确性证据**：`backend/orchestrator/tests/test_files_s3.py` **8 条全通过**，其中最关键的一条是
**与本地 `minio-py` 的 `presign_v4` 逐字符比对签名** —— 同样的 host / bucket / key / 密钥 /
region / 时间 / 有效期下，`X-Amz-*` 五个字段与 `X-Amz-Signature` 必须完全相同，
覆盖 **GET 与 PUT**、以及**不同有效期**（900 秒与 60 秒）。自己写的密码学必须拿独立实现对照，
否则「看起来能跑」说明不了任何问题。其余覆盖：确定性、GET≠PUT、额外查询串参与签名、
非法输入一律 `SigV4Error`、AWS 未保留字符编码规则。

`sync-shared.ps1 -Check` 实测：共享内核 **26** 个文件一致（含本模块，此前记录 23）/
报价引擎 19 / 枚举字典 1。

### 3. 直传相关端点（两端一致）

orchestrator OpenAPI **实测 170 条路径**（此前记录 167）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/file-objects/presign` | **新增**：直传预签名；未配 S3 返回 `{"configured": false}` |
| POST | `/api/v1/file-objects/register` | **新增**：直传后登记元数据，**不碰字节** |
| GET | `/api/v1/file-objects/{id}/url` | 短时效直链，**默认 900 秒** |

前端 `/products` 已走**直传优先、失败回退 multipart 代理**（`lib/products/use-products.ts`）：
先 `POST /file-objects/presign` → PUT 直传 → `POST /file-objects/register`；
`configured=false` 时回退 `POST /products/{key}/media`。

### 4. 基础设施实测

- R2 桶 **`kaas-files` 已建**。
- **桶 CORS 已设**（Cloudflare API 读取实测）：允许来源
  `https://kaas.powervoy.com`、`http://localhost:3000`、`http://127.0.0.1:3000`；
  允许方法 `GET` / `PUT` / `HEAD`；允许头 `Content-Type`；暴露 `ETag`；`maxAge` 3600 秒。
- `backend/worker/wrangler.jsonc` 已加 `r2_buckets`（binding `FILES` → 桶 `kaas-files`）
  与非机密 `vars`：`S3_ENDPOINT` / `S3_BUCKET=kaas-files` / `S3_REGION=auto` / `S3_PRESIGN_EXPIRES=900`。

### 5. 生产验收：入口已打通、配置齐全，但**卡在密钥长度**（⏳ 待用户重建）

> 结论先行：**生产 S3 直传（①）当前不可用**，坏点只有一个 —— `S3_ACCESS_KEY` 长度不合规；
> **服务端代理上传仍可用**，且直传失败会**自动回退**并如实告知用户（见 §8）。

#### 5.1 线上配置已核实**齐全**

- 非机密 `vars`：`S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_PRESIGN_EXPIRES`（`plain_text`）；
- 两个 secret：`S3_ACCESS_KEY` / `S3_SECRET_KEY`（`secret_text`）；
- R2 binding：`FILES`。

⇒ ① 的**代码与配置都在位**，缺的只是"这把密钥能不能用"。

#### 5.2 生产验收**已执行**（2026-10-11 晚）

- **入口打通方式（经用户授权）**：临时替换 `qa_user@qa.kaas.internal` 的 **bcrypt 哈希** →
  登录拿到 JWT → **立即改回原哈希**。已复核两点：**恢复后与备份逐字一致**、
  **新口令不再匹配** ⇒ **生产数据最终未变**。
- 因 `PUT` 被拒，**没有创建任何测试记录**（`register` 未执行）。
- 核实到的事实：生产 `users` 只有 **3 个账号**（`admin@kaas.dev` / `qa_user@qa.kaas.internal` /
  `qa_customer@qa.kaas.internal`），**没有联佳账号**；口令全为 **bcrypt（不可还原）**
  ⇒ 「从库里取登录凭证」这个说法**在事实上不成立**。

#### 5.3 ⏳ 唯一坏点：`S3_ACCESS_KEY` 只有 **13 位**，R2 要求 **32 位**

- 现象：预签名 `PUT` 返回
  **`400 InvalidArgument: Credential access key has length 13, should be 32`**。
- ⇒ **生产 S3 直传当前不可用**；**服务端代理上传（multipart）仍可用**。
- ⏳ **待用户重建 R2 S3 密钥并更新 Worker 的 secret**（操作步骤见文末「附录：FAQ」）。
- 在密钥修好并跑通验收之前，**不得声称「生产直传已成功」**。

#### 5.4 验收工具（已备好，等密钥修好即可跑）

`scripts/verify-file-storage-e2e.mjs`（lead 自建，Node 无依赖）做一次**真上传**并逐步打印结果：
登录/给 token → `presign`（必须 `configured:true`）→ 用预签名 URL **PUT 真字节** →
`register`（**`storage` 必须是 `s3`**，是 `inline` 就说明走了回退）→ 取短时效直链
**把字节取回来与本地文件逐字节比对**（同时证明 R2 接受了我们的签名且内容未损坏）→
产品图库里能看到；`--cleanup` 可验证后下线该图。任一步失败即 `exit 1`。
用法见脚本头部注释（`--api/--token` 或 `--email/--password`、`--product`、`--file`、`--name`、`--media-kind`）。
脚本自身的失败路径已实测：缺 `--file`、类型不在允许集、文件不存在 ⇒ 均 `exit 2` 并给出原因（**不静默成功**）。

### 6. S3 真回环验证（`test_files_s3_roundtrip.py`，15 条）

`backend/orchestrator/tests/test_files_s3_roundtrip.py`（`pytestmark = unit`）：

- 在 `127.0.0.1` **随机端口**起纯 `http.server` stub S3，**真发 PUT/GET 字节**，
  断言 stub 实收的路径 / 内容 / `Content-Type`；
- 对 stub **实际收到**的请求，用 `minio.signer.presign_v4`（独立实现）按 `X-Amz-Date` /
  `X-Amz-Credential` 的 scope **重算并逐字符比对**签名与整个查询串；
- 覆盖 inline 回退的五种半配形态（全没配 / 只有 endpoint / 只有密钥 / 少 secret / 空白 endpoint）。

**实测**：该文件 **15 passed**；文件域三件合跑 **41 passed**（`test_files_kernel.py` 18 +
`test_files_s3.py` 8 + 本文件 15）。变异自证（队友实测）：篡改签名 / 错 secret /
region 漂移 / 方法互换 **4/4 被拒**。

⚠️ **边界（必须如实标注）**：stub **不做服务端验签**，所以
**「生产 R2 会接受该预签名 URL」仍未证实**。它证明的是两件事 ——
「生成的 URL 是正确的 SigV4 预签名」与「`_store_bytes` / `_load_bytes` 真能 PUT/GET 字节」。

### 7. 构建门禁：并发 worktree 下会假红（已修）

- **现象**：原地 `NEXT_EXPORT=1 pnpm build` 曾两次失败 ——
  `Cannot find module 'frontend/.next/server/middleware-manifest.json'`；
  换独立目录后又出现 `PageNotFoundError: Cannot find module for page: /admin/gray-release`。
- **定性**：同一 worktree 里**另一条线正在跑 `next dev` + Playwright e2e**，双方都写
  `frontend/.next` ⇒ **并发环境问题，不是代码缺陷**。取证：frontend 源码整体复制成隔离副本
  （**284 个文件**，`node_modules` 用同深度 junction）后 `next build` **exit 0**，全路由表正常输出。
- **修复**：`frontend/next.config.mjs` 加 `distDir: process.env.NEXT_DIST_DIR || ".next"`；
  `.gitignore` 加 `.next-build/`。
- **复测（本 worktree，并发 `next dev` + e2e 仍在跑）**：`$env:NEXT_EXPORT="1"` +
  `$env:NEXT_DIST_DIR=".next-build"` 再 `node node_modules/next/dist/bin/next build`
  ⇒ **exit 0**，全路由表正常输出（37 条路由 + middleware）—— **文档线复跑确认**。
- ⚠️ **但 `NEXT_DIST_DIR` 只隔离产物目录，不隔离源码的并发写**：文档线首次尝试（与另一条线
  改写 `frontend/src/app/(app)/trade-docs/*` 的时间重叠）**仍是 exit 1**
  （`Export encountered errors`，含 `JSON.parse` 栈）；等对方写入停止后同命令复跑 exit 0。
  ⇒ 「**取数前确认工作区静止**」这条纪律对构建同样适用。
- ⇒ 构建门禁在**工作区静止**时**通过**；但**并发 worktree 下必须**用 `NEXT_DIST_DIR` 指定独立产物
  目录，否则会与 `next dev` 互相破坏 —— 那类失败看起来像代码坏了，其实只是环境。
- ⚠️ **2026-10-11 晚间最终轮再次复现**：文档线再复跑一次又 **exit 1**
  （`PageNotFoundError`/ENOENT，`load-components`），当时另一条线正在写
  `frontend/src/mocks/handlers.ts`（**22:54:20** 仍在写）。⇒ 结论不变且要写得更硬：
  **构建门的数字只在工作区静止时作数**；并发写期间"变红"不代表代码坏了。
  注意 `NEXT_DIST_DIR` **只隔离产物目录，不隔离源码并发写**。

### 8. 直传失败**自动回退服务端代理**（**不静默**）

**行为**（`frontend/src/lib/products/use-products.ts`）：

| 情形 | 行为 |
|---|---|
| `presign` 请求失败 | 记 `fallbackReason = 预签名失败：<原因>`（`:195`） |
| `configured=true` 但没给 `upload_url` | 记 `预签名未返回 upload_url`（`:230-232`，判定为"服务端状态不对"，**不当成"没配对象存储"**） |
| 直传 `PUT` 非 2xx | 记 `直传被拒：HTTP <status>`（`:207`） |
| 直传 `PUT` 抛异常（网络 / CORS） | 记 `直传异常：<原因>`（`:210`） |
| 以上任一 ⇒ | **回退 `POST /products/{key}/media`（服务端代传）**，返回体带机器可读标记 **`fellBackToProxy: true` + `fallbackReason`**（`:241`） |
| **`PUT` 成功但 `register` 失败** | **抛错、不回退重传**（避免重复对象 / 重复流量） |
| `configured=false` | **不算回退**（设计如此，不给用户惊吓）：`fellBackToProxy: false`（`:239`） |

**界面如实显示**：`products/page.tsx:126-131` 在"回退成功"时提示
**`已上传（直传失败：<原因>；已走服务端兜底）`**，而不是静默成功。

**证据**：`frontend/src/lib/products/__tests__/use-products.test.ts` **13 tests**；
文档线实跑 `pnpm test` = **28 files / 354 passed**（**lead 实测**：4 条新用例在旧实现下都会红，
文档线未复现"旧实现下红"这一步）。
**未覆盖**：`products/page.tsx` 的 `doUpload` **无自动化测试**（整页渲染成本高，本轮未做）。

**运行事实**：在密钥修好之前，**UI 里的产品图上传会走这条"直传失败 → 服务端兜底"路径**
（用户看到带原因的提示），**不是静默成功** —— 这正是"不掩盖故障"的设计。

---

## 产品图排序与公章（2026-10-11 晚 · 第二批实现）

### 1. 产品图排序（迁移 `202610110018`）

- **迁移**：`file_objects` 新增 `sort_order INTEGER NOT NULL DEFAULT 0`（**只新增列**，存量行自动补 0；
  `downgrade` 只删列、不碰数据行）——`backend/orchestrator/alembic/versions/202610110018_file_sort_order.py:31-41`。
  ✅ **已在生产执行**（lead 实跑 `alembic upgrade 202610110018`；生产只读复核 = **23 列**、`sort_order` 默认 0）。
- **为什么加在 `file_objects` 而不是另建排序表**：产品图位次是**产品图本身**的属性，
  一份图被多张单证引用（`trade_doc_files.file_id`），它的顺序应当一次维护、处处一致
  （迁移文件头注释即此理由）。单证自己的顺序另有 `trade_doc_files.sort_order`。
- **两端同一常量**：`_FILE_ORDER_BY = "is_primary DESC, sort_order, id"`
  （`backend/orchestrator/app/api/files.py:74`；`backend/worker/src/ws_files.py:69`），媒体/列表共用。
- **PATCH 支持排序值**：`PATCH /api/v1/file-objects/{id}` 接受 `sort_order`，范围 **0–9999**
  （`_MAX_SORT_ORDER = 9999`，两端同值），越界返回 **422 `SORT_ORDER_OUT_OF_RANGE`**
  （orchestrator `files.py:360-367`；worker `ws_files.py:370-375`）。
- **两端字段对齐**：worker 的 `FilePatch` 补上此前缺失的 `caption`
  （orchestrator `files.py:324-328` ↔ worker `ws_files.py:338-342`）。
- **前端**：产品图卡片提供**上移/下移** + **位次徽标**；**主图恒排最前** ——
  主图存在时第二张不允许上移（`products/page.tsx:91-93,319,346-363`）。
  上/下移把整个顺序压成 `0..n-1` 后**只对位次真变的图发 PATCH**，任何一条失败都提示用户
  （`products/page.tsx:97-113`）。

### 2. 公章上传界面（`settings/company-profile`）

此前**前端没有任何公章上传入口**（全仓只引用渲染字段 `company_stamp`），
生产 `tenant_company_seals` 为 **0 行** ⇒ 用户根本传不了章，PI 的签章区永远空着。

- 新组件 `frontend/src/app/(app)/settings/company-profile/components/company-seal-card.tsx`，
  挂在企业主体信息页。
- 5 个端点与两端后端**逐一对应**：`POST /tenant/company-seals`（上传，multipart）、
  `GET /tenant/company-seals`（列表）、`GET /tenant/company-seals/{id}/image`（取 PNG，需 Bearer）、
  `PUT /tenant/company-seals/{id}/default`（设默认，全局唯一）、
  `DELETE /tenant/company-seals/{id}`（删除；默认章还有别的章时后端 409 要求先转移默认）。
  后端路由见 `backend/orchestrator/app/api/company_seals.py:112,201,217,241,263`（worker 镜像同契约）。
- **Canvas 转 PNG 是后端契约要求，不是降级**：`validate_seal_image` 只认 **PNG 魔数**
  （`backend/kaas_common/trade_doc/png.py:42`；两端调用点 `company_seals.py:62`、`ws_seals.py:70`），
  所以前端必须先把图归一化成 PNG 再传（`company-seal-card.tsx:20,270`）。
- 空态明说：**「没有公章时，PI / 合同 / 装箱单的签章区不会盖章」**（`company-seal-card.tsx:461,469`）。

### 3. 默认公章自动带入单据渲染（G1 单一真源）

- 纯函数住在共享内核 `backend/kaas_common/files/seal.py`：
  `SEAL_FIELD` / `seal_field` / `seal_data_uri` / `apply_default_seal`（`seal.py:30,33,36,46,59`）。
- **覆盖优先级**（两端逐字一致）：
  ① 单据 `custom` **显式含** `company_stamp`（**含空串**）⇒ 以它为准，不覆盖、**不查库**；
  ② 没给 ⇒ 取租户 `is_default` 章，`png_bytes` 转 `data:` URI 填入；
  ③ 无默认章 / 空字节 / None ⇒ **不注入**（**不伪造空图**）。
- 两端只剩"取数壳"：orchestrator `trade_docs.py:47,775-779,827`；worker `main.py:3589,3598-3608,3683`。
- **证据**：两端 `apply_default_seal` 是**同一个函数对象**
  （测试断言 `backend/orchestrator/tests/test_trade_doc_seal_default.py:79`：
  `td.apply_default_seal is apply_default_seal`），源码里已无本地副本；
  `sync-shared.ps1 -Check` 实测共享内核 **27** 个文件一致。

### 4. 本轮修掉的三个缺陷

| # | 缺陷 | 处置 | 位置 |
|---|---|---|---|
| a | 坏 `file_id`（如 `{"file_id":"abc"}`）让 render-data **500** | 共享内核新增 `coerce_file_ref_id`（只认正整数/数字字符串，**`bool` 单独挡掉**——它是 `int` 子类），`is_file_ref` 复用它 | `backend/kaas_common/files/rules.py:203,232-235`；回归测试 `test_files_kernel.py:177-201`（用 **`db=None`** 证明坏 id 走完装配**不触库**；合法引用在 `db=None` 下必然抛错，作为对照） |
| b | `attach_doc_file` 让位只处理 `stamp_scan` ⇒ 反复归档 PDF 会出现多条"当前 PDF" | 扩到 `("stamp_scan","render_pdf")`，旧链接挂 `<role>_superseded`（**不物理删**） | orchestrator `files.py:543-550`；worker `ws_files.py:466-472` |
| c | 前端：界面把 Markdown `**` 当文本渲染；历史版本号用 `version+1` **推算** | 去掉星号；改为按**后继件的 `supersedes_id`** 找后继，找到写真实 `v{后继.version}`，找不到写「已被新版取代」 | `doc-stamp-return.tsx:118-124`（`:66` 已无 `**`） |

### 5. 验证资产（新增测试）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `backend/worker/tests/test_ws_files_storage.py` | **34** | `_s3` 读请求期绑定、三段回退**顺序**、`_load_bytes` 不把错误当内容、`resolve_photo_refs` |
| `frontend/src/lib/products/__tests__/use-products.test.ts` | **9** | 直传/回退双路径 + sha256 固定期望值 + 排序 hook 请求契约 |
| `frontend/src/app/(app)/trade-docs/components/__tests__/doc-stamp-return.test.tsx` | **5** | 版本链按真源/跳号/无后继/星号回归 |
| `backend/orchestrator/tests/test_trade_doc_seal_default.py` | **28** | 覆盖优先级 + 两端同一函数对象 + 装配层接线（假 DB，不连库） |

**顺带修掉一个测试配置缺口**：仓库此前**没有任何 `.tsx` 测试**，而 `tsconfig.json` 的 `jsx: preserve`
（Next 构建需要）会被 Vite 8 的 **oxc** 转换器照搬 ⇒ 任何 import `.tsx` 的测试都跑不起来。
`frontend/vitest.config.ts:13` 加 `oxc: { jsx: { runtime: 'automatic', importSource: 'react' } }` 修好
（注释同时写明：Vite 8 下 `esbuild: { jsx }` 会被忽略并告警）。

### 6. ⏳ 仍未做（保持待办，别写成已完成）

1. **真实上传端到端（用户已决定：暂缓）**：工具已备 `scripts/verify-file-storage-e2e.mjs`，但需要
   **一次带登录的生产上传**。2026-10-12 实测生产侧 R2 报
   `Credential access key has length 13, should be 32`（用户设的 `S3_ACCESS_KEY` 不是 32 位）
   ⇒ 需用户在 Cloudflare dashboard 的 *Manage R2 API Tokens* 重建密钥并
   `wrangler secret put S3_ACCESS_KEY` / `S3_SECRET_KEY` 后再验。
   **在重建密钥并真实跑通之前，任何文档都不得写成"上传已验证成功"**
   （当前生产会按落点优先级回退到 R2 binding / inline，功能不缺，但"直传/对象存储"这一条未验证）。
2. **真实 PostgreSQL / db 级用例**：部分唯一索引唯一性、跨租户隔离、`bytea` 往返 —— **未做**。
3. **盖章在 PI 版式中的位置/尺寸无视觉验证**（没有逐页渲染 QA）。
4. **排序的页面级过滤逻辑**（`products/page.tsx` 里"只对位次真变的图发请求"）**未被测试覆盖** ——
   队友已说明**没有用复刻逻辑假装覆盖**；hook 层契约有测试（`use-products.test.ts`），页面层没有。

---

> 起因（用户原话）：
> 「产品图片可以在产品管理页面添加，可以添加各种类型的图片（生产/尺寸/重量/成品），
> 上传后有一个输入框给图片命名，还可以添加产品的基础信息。单证直接调用产品管理页面的图片。
> 这样一次维护、重复使用、一劳永逸。」
> 「你应该规划出专门的位置……我的要求很简单，就是数据持久化保存在它自己的位置，
> 特别是业务数据。」

---

## 一、为什么不用「内联存库」

**「内联存库」指的是把文件的字节直接塞进普通业务表的列里**（现有
`external_doc_uploads.content` 是 `LargeBinary`）——它不是另建一个库，而是图文数据
与业务行混在同一张表。后果：

| 问题 | 具体后果 |
|---|---|
| 业务表被撑大 | 一张 PI 带公章 + 两张产品照 ≈ **1.4MB base64**；`trade_docs` 是每次列表/详情都要读的行 |
| 备份/迁移不独立 | 图片/PDF 的生命周期与业务行生命周期不同（要长期留档、可能冷存），却绑在一起 |
| 换存储要改业务表 | 从库里搬到对象存储要动 `trade_docs` / `external_doc_uploads` 的表结构与所有读写路径 |
| 权限无法隔离 | 文件访问控制只能靠行级权限，无法用签名 URL / 目录策略 |

所以按「**数据存在它自己的位置**」的原则，拆成三层。

## 二、三层存储（各自有家）

| 层 | 存什么 | 落在哪 | 为什么 |
|---|---|---|---|
| **业务数据** | 单证、行项、报价、订单、产品定义、清单与状态 | 各自的业务表（现状不变） | 这些是"行"，要事务、要查询、要审计 |
| **文件元数据** | 谁传的、什么类型、用户命名、大小、mime、sha256、归属、版本、状态 | **`file_objects` 表**（新增，全平台唯一文件域） | 可查询、可关联、可审计；**业务表只存 `file_id`** |
| **文件本体**（字节） | 图片、盖章扫描件、生成的 PDF | **对象存储**：生产 = **Cloudflare R2**；本地 = **MinIO**（已有 docker-compose） | 两者都是 S3 兼容 ⇒ 同一套代码；库里只存 `object_key` |

> 为什么生产选 **R2**：项目已经跑在 Cloudflare Worker 上，R2 用 **binding** 直连
> （不需要额外密钥流转、不占 Worker 出口流量）；Neon 的对象存储与 MinIO 都要额外配置。
> 本地开发继续用 docker-compose 里的 MinIO —— 接口同为 S3，代码一份。

## 三、表结构草案

```sql
-- ① 全平台文件域（唯一的"文件自己的位置"）
CREATE TABLE file_objects (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  team_id       BIGINT NULL,                 -- 与其它工位一致的隔离边界
  owner_type    TEXT NOT NULL,               -- product | trade_doc | customer | company
  owner_id      TEXT NULL,                   -- 归属对象的 id（产品 key / 单证 id …）
  kind          TEXT NOT NULL,               -- product_photo | stamp_scan | render_pdf | other
  media_kind    TEXT NULL,                   -- 产品图细分：production | size | weight | finished
  name          TEXT NOT NULL,               -- **用户给图片起的名字**
  storage       TEXT NOT NULL DEFAULT 's3',  -- s3 | inline（inline 仅作兜底，不推荐）
  object_key    TEXT NULL,                   -- s3 时的 key
  content       BYTEA NULL,                  -- inline 时的字节（默认不用）
  file_name     TEXT NULL,
  content_type  TEXT NULL,
  file_size     BIGINT NULL,
  sha256        TEXT NULL,                   -- 去重与完整性
  version       INT NOT NULL DEFAULT 1,      -- 版本化（用户已裁决）
  supersedes_id BIGINT NULL REFERENCES file_objects(id),
  is_current    BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by   TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 同一归属 + 同一用途，只允许一个"当前版本"
CREATE UNIQUE INDEX uq_file_current ON file_objects (tenant_id, owner_type, owner_id, kind, media_kind)
  WHERE is_current;

-- ② 产品基础信息（用户要的"产品的一些基础信息"）
--    产品本体是代码里的 ProductSpec（key: chain_link / field_fence / deer_net），
--    这里只存**租户可编辑**的补充信息，不复制规格定义。
CREATE TABLE product_profiles (
  tenant_id   TEXT NOT NULL,
  product_key TEXT NOT NULL,
  info        JSONB NOT NULL DEFAULT '{}',   -- 材质/表面处理/用途/HS 编码/包装/产地…
  updated_by  TEXT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_key)
);

-- ③ 单证 → 文件的引用（**引用而非复制**：产品图一次维护，多张单证复用）
CREATE TABLE trade_doc_files (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  trade_doc_id BIGINT NOT NULL,              -- → trade_docs.id
  file_id      BIGINT NOT NULL REFERENCES file_objects(id),
  role         TEXT NOT NULL,                -- product_photo | stamp_scan | render_pdf
  caption      TEXT NULL,                    -- 单证上的图注（可覆盖产品图默认名）
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**关键点**：产品图**只存一份**（`file_objects.owner_type='product'`），单证通过
`trade_doc_files.file_id` 引用它。产品图换了名字/换了图，所有引用它的单证同步变
—— 这就是"一次维护、重复使用"。

## 四、盖章回传的「覆盖」（按你已裁决的版本化）

| 步骤 | 数据动作 | 对外效果 |
|---|---|---|
| 系统出 PI | 生成 PDF → `file_objects`（kind=`render_pdf`, version=1, is_current） | 单证上看得到未盖章 PDF |
| 客户盖章回传 | 上传扫描件 → 新行（kind=`stamp_scan`, version=1） | 出现盖章件 |
| 再回传一版 | 新行 version+1，`supersedes_id` 指向旧行，旧行 `is_current=false` | **单证当前展示的是最新盖章件**；历史版本仍在库里留档 |
| 留档 | 所有版本都保留，按 `supersedes_id` 可串成版本链 | 出争议时能拿出"当时那一版" |

**PDF 留档（`render_pdf`）：两条路都已实现（人工归档兜底 + 自动出字节）** —— 前端归档入口已实现：
单证预览区（`frontend/src/app/(app)/trade-docs/components/doc-preview.tsx`）有「归档本版 PDF」（人工兜底）
与「自动出 PDF 并归档」（2026-10-12 新增）；
单据工位 `page.tsx` 已接线 `docId`（「样板预览」没有真实单据 ⇒ 不渲染这两个入口）。
人工路径：用户把「打印 / 导出 PDF」在打印对话框里另存下来的那份 PDF 选回来，即走
`POST /api/v1/trade-docs/{id}/files/upload`（multipart：`file` + `role="render_pdf"` + `name`）
落进 `file_objects`；前端在送字节前**当场校验** `application/pdf` 与 ≤32MB（与内核
`MAX_BYTES['render_pdf']` 一致），不把 422 丢给用户猜。自动路径：`POST /api/v1/trade-docs/{id}/pdf`
（入参是**与预览同源的那份 HTML**）→ 服务端 Cloudflare Browser Rendering 出 PDF 字节 → 复用同一套
落档链路（`_store_bytes` → `_create_file(kind='render_pdf', supersede=True)` → `attach_doc_file`）。
两条路都是**再归档 = 新版本上位、旧版挂 `render_pdf_superseded` 留档（不物理删）**，成功后都失效
`["trade-docs", id, "files"]`，单据文件区（`DocStampReturn` 的「系统出的 PDF」分区）随即刷新。
渲染器配置：生产 Worker 用 `wrangler.jsonc` 的 `"browser": {"binding": "BROWSER"}`（无需 token）；
orchestrator/本地用 `BROWSER_RENDERING_ACCOUNT_ID` + `BROWSER_RENDERING_TOKEN`；**未配置时接口返回
503 `PDF_RENDERER_NOT_CONFIGURED`（不假装成功）**。入参 HTML 过内核安全校验（拒脚本/事件属性；
外链**只放行 `data:` URI 或白名单域名**，白名单 `PDF_HTML_ALLOWED_HOSTS` 可配，默认
`kaas.powervoy.com,api.kaas.powervoy.com`）—— 细节见 `docs/TRADE_DOC_PDF_ARCHIVAL.md §〇`。
**未验证/已暂缓**：无头环境只验证了"上传的字节与服务端收到的一致"（`doc-preview-archive.test.tsx`
逐字节比对 + multipart body 取样），**没有也无法验证真实 PDF 的版面/分页**；
**真实上传验收暂缓**（用户已决定）—— 生产 R2 报 `S3_ACCESS_KEY` 长度 13≠32，需用户重建 32 位密钥后
再验，**在此之前不得写成"上传已验证成功"**。

## 五、单证引用产品图的链路（渲染器不用改）

```
产品管理页上传 → file_objects(owner=product, kind=product_photo, media_kind=size)
                    ↓ 单证编辑时选图
trade_doc_files(role=product_photo, file_id, caption)
                    ↓ render-data 装配时解析
GET /trade-docs/{id}/render-data
   → 把 file_id 解析成图片源：
       · R2/S3：签发**短时效签名 URL**（http(s)）→ 渲染器白名单本来就接受
       · 需要自包含时：读对象转 data URI
                    ↓
renderTradeDoc("pi", { product_photos: [{ image, caption }] })
```

现有渲染器的图片白名单（`data:image/*;base64` 与 `http(s)` 绝对地址）**不用改** ——
引用解析放在装配层（`build_render_data` 之后 / render-data 接口内）。

## 六、页面与接口

**新页面 `/products`（侧边栏"业务"组）**

- 产品列表：勾花网 / 牛栏网 / 鹿网（来自 ProductSpec 注册表），显示已有图片数与基础信息完整度
- 产品详情（页签）：
  - **基础信息**：材质、表面处理、用途、HS 编码、包装、产地……（存 `product_profiles.info`）
  - **图片**：上传 → 选类型（生产 / 尺寸 / 重量 / 成品）→ **输入框命名** → 排序 / 设主图 / 删除
- 单证编辑页：图片位从"选本地文件"升级为"**从产品图库里选**"（本地文件上传保留为兜底）
- **公章**：`settings/company-profile`（企业主体信息页）新增「公司公章」区块（`CompanySealCard`）——
  上传（前端 Canvas 归一化成 PNG）/ 列表 / 设默认 / 删除；空态说明"没有公章时签章区不会盖章"。
  默认章会在 `render-data` 装配时自动补进 `company_stamp`（详见上「产品图排序与公章」§3）。

**接口（两端一致：orchestrator + Worker）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/products` | 产品列表（注册表 + 图片数 + 基础信息） |
| GET/PUT | `/api/v1/products/{key}/profile` | 基础信息读写 |
| GET | `/api/v1/products/{key}/media` | 产品图片列表 |
| POST | `/api/v1/products/{key}/media` | 上传（multipart：文件 + name + media_kind） |
| PATCH | `/api/v1/file-objects/{id}` | 改名 / 设主图 / **排序**（`sort_order` 0–9999，越界 422 `SORT_ORDER_OUT_OF_RANGE`）；worker 侧字段与 orchestrator 一致（含 `caption`） |
| DELETE | `/api/v1/file-objects/{id}` | 下线（**软删**：`is_current=false`，行保留可追溯） |
| GET | `/api/v1/file-objects/{id}/url` | 取签名 URL（短时效，默认 **900 秒**）；未配 S3 或文件在 inline 时返回 `{"configured": false}` |
| POST | `/api/v1/file-objects/presign` | **直传预签名**（返回短时效 PUT URL，字节不过服务端）；未配 S3 返回 `{"configured": false}` |
| POST | `/api/v1/file-objects/register` | **直传后登记元数据**（字节已在对象存储，不碰字节） |
| POST | `/api/v1/trade-docs/{id}/files` | 单证挂文件（产品图引用 / 盖章回传 / PDF 归档；`render_pdf` 也参与版本让位） |
| POST | `/api/v1/tenant/company-seals` | **上传公章**（multipart；**只认 PNG 魔数**，前端 Canvas 归一化后再传） |
| GET | `/api/v1/tenant/company-seals` | 公章列表（元数据 + `preview_url`，不回裸字节） |
| GET | `/api/v1/tenant/company-seals/{id}/image` | 取公章 PNG（需 Bearer；`<img src>` 带不上，走 blob→objectURL） |
| PUT | `/api/v1/tenant/company-seals/{id}/default` | 设为默认（全局唯一；后端事务内先清后设） |
| DELETE | `/api/v1/tenant/company-seals/{id}` | 删除（默认章若还有别的章 → 后端 409 要求先转移默认） |

## 七、落地顺序（一次做完，按依赖排）

1. **迁移**：`file_objects` + `product_profiles` + `trade_doc_files`（orchestrator alembic → 生产库）
2. **共享内核**：文件归属/版本/覆盖的纯函数（`kaas_common`，两端共用）+ 单测
3. **存储适配**：`StorageBackend` 接口 —— `R2Backend`（生产，binding）/ `MinioBackend`（本地）/ `InlineBackend`（兜底）
   → **实际落地与此不同**（见上「落点优先级与 S3 直传」）：没有抽象 `StorageBackend` 类，
   而是「共享 `s3.py` 预签名 → R2 binding → inline」三段优先级，两端共用同一段 SigV4 代码。
4. **两端 API**：上面 7 条路由 + `sync-shared`
5. **前端**：`/products` 页面（列表 + 基础信息 + 图片上传/命名/排序/设主图）
6. **单证联动**：编辑页"从产品图库选图" + render-data 解析 file_id → 图片源
7. **盖章回传**：上传扫描件 → 版本+1 覆盖当前件，旧版留档
8. **门禁**：orchestrator `pytest -m unit`、worker `pytest`、前端 `typecheck`/`lint`/`test`、
   `contracts:check`、`route-parity`、`sync-shared -Check`、`NEXT_EXPORT=1 pnpm build`
   （**并发 worktree 下加 `NEXT_DIST_DIR=.next-build` 隔离产物目录**，见上 §7）

## 八、需要你拍板的点

| # | 决策 | 建议 |
|---|---|---|
| 1 | 文件本体放 **Cloudflare R2**（生产）+ MinIO（本地） | 建议采纳（Worker 已有 Cloudflare 环境，binding 直连） |
| 2 | 产品 key 直接用现有 `ProductSpec` key（勾花网/牛栏网/鹿网） | 建议采纳（不新建产品主数据，避免两套真相） |
| 3 | 产品图**引用而非复制**进单证 | 建议采纳（"一次维护重复使用"的前提） |
| 4 | 盖章件版本化（对外一份、旧版留档） | 已裁决 ✅ |

> 第 1–3 项均已采纳并落地（见上「实施进度」与「落点优先级与 S3 直传」）；
> 第 4 项为既有裁决。本表保留作为决策记录，不再代表待办。

---

## 附录：FAQ

### Q1. R2 报 `Credential access key has length 13, should be 32` 怎么办？

这是 **R2 的 S3 Access Key ID 长度不合规**：R2 要求 **32 位**，而当前 Worker secret 里是 **13 位**。
出现该错误时 **预签名直传（①）不可用**，但 **`POST /products/{key}/media` 的服务端代理上传仍可用**，
并且前端会**自动回退**、在提示里说明原因（见「落点优先级与 S3 直传」§5.3 / §8）。

修复步骤：

1. Cloudflare dashboard → **R2** → **Manage R2 API Tokens** → 新建 token：
   权限 **Object Read & Write**，**只授权桶 `kaas-files`**。
2. 复制它给出的 **Access Key ID（32 位）** 与 **Secret Access Key**。
3. 更新 Worker `kaas` 的两个 secret：
   ```bash
   npx wrangler secret put S3_ACCESS_KEY
   npx wrangler secret put S3_SECRET_KEY
   ```
4. 跑一次验收（会**真上传**，`--cleanup` 会在验证后把该图下线）：
   ```bash
   node scripts/verify-file-storage-e2e.mjs --api https://api.kaas.powervoy.com \
        --email <账号> --password <口令> --file <本地图片> --name <图名> --cleanup
   ```
   期望链路：`presign` 返回 `configured:true` → `PUT` 2xx → `register` 的 **`storage == "s3"`**
   → 短时效直链取回的字节与本地**逐字节一致**。

> ⏳ 截至本文更新时，**上面第 4 步还没有成功跑过一次**（原因就是这把 13 位的密钥）。
> 在它跑通之前，**不要声称"生产直传已成功"**。

### Q2. "临时改哈希登录"算不算动了生产数据？

不算。见 §5.2：那是**经用户授权**的一次性入口手段，改后**立即改回原哈希**，并复核了
**恢复后与备份逐字一致**、**新口令不再匹配**；且 `PUT` 被拒 ⇒ **没有创建任何测试记录**。
