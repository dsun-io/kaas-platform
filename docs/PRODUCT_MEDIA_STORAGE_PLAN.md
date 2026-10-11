# 文件与产品媒体：存储规划（2026-10-11）

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
| GET | `/api/v1/file-objects/{id}/url` | 取签名 URL（短时效） |
| POST | `/api/v1/trade-docs/{id}/files` | 单证挂文件（产品图引用 / 盖章回传 / PDF 归档） |

## 七、落地顺序（一次做完，按依赖排）

1. **迁移**：`file_objects` + `product_profiles` + `trade_doc_files`（orchestrator alembic → 生产库）
2. **共享内核**：文件归属/版本/覆盖的纯函数（`kaas_common`，两端共用）+ 单测
3. **存储适配**：`StorageBackend` 接口 —— `R2Backend`（生产，binding）/ `MinioBackend`（本地）/ `InlineBackend`（兜底）
4. **两端 API**：上面 7 条路由 + `sync-shared`
5. **前端**：`/products` 页面（列表 + 基础信息 + 图片上传/命名/排序/设主图）
6. **单证联动**：编辑页"从产品图库选图" + render-data 解析 file_id → 图片源
7. **盖章回传**：上传扫描件 → 版本+1 覆盖当前件，旧版留档
8. **门禁**：orchestrator `pytest -m unit`、worker `pytest`、前端 `typecheck`/`lint`/`test`、
   `contracts:check`、`route-parity`、`sync-shared -Check`、`NEXT_EXPORT=1 pnpm build`

## 八、需要你拍板的点

| # | 决策 | 建议 |
|---|---|---|
| 1 | 文件本体放 **Cloudflare R2**（生产）+ MinIO（本地） | 建议采纳（Worker 已有 Cloudflare 环境，binding 直连） |
| 2 | 产品 key 直接用现有 `ProductSpec` key（勾花网/牛栏网/鹿网） | 建议采纳（不新建产品主数据，避免两套真相） |
| 3 | 产品图**引用而非复制**进单证 | 建议采纳（"一次维护重复使用"的前提） |
| 4 | 盖章件版本化（对外一份、旧版留档） | 已裁决 ✅ |
