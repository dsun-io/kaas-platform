# 文件与产品媒体：存储规划（2026-10-11）

## 实施进度（2026-10-11 晚）

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 迁移 `202610110016`（三表）+ `202610110017`（版本化边界收窄 + 主图） | ✅ **已在生产库执行** | 生产实测 file_objects 22 列、索引 11 个 |
| 2 | 共享内核 `kaas_common/files`（校验 / key / 版本化 / 引用解析） | ✅ | 18 条单测进 `-m unit` 门禁 |
| 3 | orchestrator API（文件域 + 产品媒体；含直传端点） | ✅ | OpenAPI 实测 **170** 条路径（此前 167） |
| 4 | Worker 镜像 + **R2 binding**（桶 `kaas-files` 已建） | ✅ | `pytest` 142 passed；`wrangler.jsonc` 已加绑定 |
| 5 | 前端 `/products` 产品管理页（基础信息 + 图片上传/命名/类型/主图/下线） | ✅ | typecheck 0 / test 304 passed |
| 6 | 侧边栏入口（契约 ts+py 双向一致） | ✅ | `contracts:check` **R2 PASS（26 工位）** |
| 7 | 单证引用产品图：`{file_id}` → data URI（装配层解析） | ✅ 两端 | 渲染器**未改**（白名单不放开） |
| 8 | 盖章回传版本化（新版本上位、旧版留档） | ✅ 后端完成 | `POST /trade-docs/{id}/files/upload`（两端） |
| 9 | 单证编辑页「从产品图库选图」的**图形化选择器** | ✅ **已完成** | `trade-docs/components/doc-photo-picker.tsx`：选产品 → 点图 → 写入 `{"file_id": N, "caption": …}`；已添加的图标记「已添加」防重复引用 |
| 10 | 对象存储 **S3 直传实现 + R2 接线** | ✅ 实现完成并交叉验证 / ⏳ **真实上传实测** | 见下「落点优先级与 S3 直传」：`kaas_common/files/s3.py`（8 条与 minio-py **逐字符一致**）+ `test_files_s3_roundtrip.py`（**15 条真回环**，文件域三件合跑 **41 passed**）；两端端点齐平。**S3 密钥已由用户在 dashboard 设置**（只读核验名称存在）；**真实上传端到端仍未实测** |

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

### 5. 激活步骤：密钥已设置；真实上传实测待做

S3 直传（①）的**代码与配置已就位**：

1. R2 的 S3 密钥只能在 Cloudflare dashboard 的 **R2 → Manage R2 API Tokens** 创建。
   **Cloudflare API 没有「创建 R2 长期 S3 密钥」的端点**（已核对 OpenAPI：只有
   `/r2/temp-access-credentials` 临时凭证与 R2 SQL catalog 凭证），只能在 dashboard 建。
2. ✅ **密钥已设置（用户操作，已完成）**：用户在 dashboard 给 Worker `kaas` 设了
   `S3_ACCESS_KEY` 与 `S3_SECRET_KEY`；由 lead 用 Cloudflare API **只读核验名称存在
   （`secret_text`），未读取值**。
3. ⏳ **真实上传（R2 写入 / 读取端到端）仍未实测** —— 需要一次**带登录的实际上传**。
   在实测通过之前，**不得声称「生产上传已成功」**；① 是否已在生产生效同样尚未核实。

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
- ⇒ 构建门禁**通过**；但**并发 worktree 下必须**用 `NEXT_DIST_DIR` 指定独立产物目录，
  否则会与 `next dev` 互相破坏 —— 那类失败看起来像代码坏了，其实只是环境。

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

**接口（两端一致：orchestrator + Worker）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/products` | 产品列表（注册表 + 图片数 + 基础信息） |
| GET/PUT | `/api/v1/products/{key}/profile` | 基础信息读写 |
| GET | `/api/v1/products/{key}/media` | 产品图片列表 |
| POST | `/api/v1/products/{key}/media` | 上传（multipart：文件 + name + media_kind） |
| PATCH/DELETE | `/api/v1/file-objects/{id}` | 改名 / 排序 / 删除（软删） |
| GET | `/api/v1/file-objects/{id}/url` | 取签名 URL（短时效，默认 **900 秒**）；未配 S3 或文件在 inline 时返回 `{"configured": false}` |
| POST | `/api/v1/file-objects/presign` | **直传预签名**（返回短时效 PUT URL，字节不过服务端）；未配 S3 返回 `{"configured": false}` |
| POST | `/api/v1/file-objects/register` | **直传后登记元数据**（字节已在对象存储，不碰字节） |
| POST | `/api/v1/trade-docs/{id}/files` | 单证挂文件（产品图引用 / 盖章回传 / PDF 归档） |

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
