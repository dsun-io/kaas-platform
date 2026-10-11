# 产品模块合并方案（含「产品定义可视化编辑器」）—— 只读分析

> **文档性质**：**分析 + 方案**，不包含任何代码改动。
> **本文不代表已实施**。所有"应该怎么做"都标了【推测】；只有标【已核实】的才是读到的代码事实。
>
> **快照基线**：`HEAD = ffdef5e`（2026-10-11 21:52）+ 当时的工作区未提交改动。
> 另一条任务正在同时修改产品相关代码，因此：
> - **行号会漂移**。引用时请以**符号名/字符串**为准（函数名、常量名、路由字面量），行号只作定位参考。
>   （`docs/PROBLEM_STATUS_2026-10-11.md`、`docs/PRODUCT_MEDIA_STORAGE_PLAN.md` 也在被另一条任务改，
>   本文对它们的行号引用在写就时逐条复核过，但读者看到时可能已位移。）
> - 工作区当时的状态（`git status --short`）：`M frontend/src/app/(app)/products/page.tsx`、
>   `D frontend/src/app/(app)/products/hooks/use-products.ts`、`?? frontend/src/lib/products/`、
>   `M backend/orchestrator/app/api/files.py`、`M backend/worker/src/ws_files.py`、
>   `M backend/orchestrator/app/api/trade_docs.py`、`M backend/kaas_common/files/__init__.py`、
>   `?? backend/kaas_common/files/s3.py`。**本文一个都没改。**
> - 下文凡引用 `frontend/src/app/(app)/products/page.tsx` 与 `frontend/src/lib/products/use-products.ts` 的行号，
>   指的是**上面这份工作区快照**，不是已提交版本。

---

## 结论速览（TL;DR）

1. **【已核实】"两套真相"不在"页面 vs 页面"，而在"代码注册表 vs `tenant_products` 表"**：
   `/products` 的产品清单**只**来自代码里的 `ProductSpec` 注册表（`files.py:232` 的 `for key in product_keys()`），
   而 `tenant_products` 是**能被创建、却进不了算价引擎**的平行账本 —— 唯一会读它 `spec` 的 `TenantProductLoader`
   **在整仓里没有任何调用点**。所以合并的本质是**把平行账本接回来或明确废掉**，不是搬两个页面。
2. **【已核实】可视化编辑器不能按任务描述里的"规格轴"做**：三个真实产品（勾花网/牛栏网/鹿网）
   的 `axes` **全是空列表**（`chain_link.py:76`、`field_fence.py:80`、`deer_net.py:83`）；
   实际规格维度是 `numeric_inputs`（连续值）+ `variants`（枚举包）+ `pricing_key`。
   照 `Axis` 设计会做出一张**永远为空**的表单。
3. **【已核实】"租户一改就被冻住"的机制已经写在代码里**：`TenantProductLoader.load` 命中 DB 行就
   `return spec_from_dict(row["spec"])`（`services/export_quote/tenant_products.py:70-76`），**整体遮蔽**代码定义。
   项目自己已经把这条风险记录了两遍（`models.py:618-620`、`PROBLEM_STATUS_2026-10-11.md:1505-1506`）。
4. **【推测】建议方案**：一个工位（保留 `products`/`/products`）+ 两个 tab（`定义` / `图片与基础信息`），
   以 `product_key` 为主键；**系统级（key 在代码注册表里）存差异、租户自建存整份**；
   差异语义**复用已有的 `team_option_overrides` 模板**，不发明新语义。
5. **【已核实】合并不宜现在动手**：要改的 4 个文件里 3 个正在被另一条任务改，且**用户还没拍板两件事**
   （合并后的可见性粒度、存储模式）。前置条件见 §8。

---

## 1. 两个模块各自的数据来源（任务第 1 条）

### 1.1 `/products`（"产品"工位，业务组，人人可见）

页面文件：`frontend/src/app/(app)/products/page.tsx`

| 维度 | 事实 | 证据 |
|---|---|---|
| 产品清单来源 | **代码里的 `ProductSpec` 注册表**，页面不读任何产品主数据表 | `backend/orchestrator/app/api/files.py:229-241`（注释 + `for key in product_keys()`）<br>`backend/worker/src/ws_files.py:245-269`（两端同构） |
| 清单里"有哪些产品"的裁决者 | 注册表 `keys()`（`chain_link` / `field_fence` / `deer_net`） | `backend/orchestrator/app/services/export_quote/products/__init__.py:34-52` |
| 图片数 | `file_objects` 聚合（`owner_type='product' AND kind='product_photo' AND is_current`） | `files.py:216-221` |
| 基础信息 | `product_profiles.info`（JSONB） | `files.py:223-228`、`files.py:249-272` |
| 前端调用 | `GET /products`、`GET/PUT /products/{key}/profile`、`GET/POST /products/{key}/media`、`PATCH/DELETE /file-objects/{id}` | `frontend/src/lib/products/use-products.ts:53-63, 65-89, 91-102, 112-162, 172-192` |
| 页头自述 | 「产品清单来自**代码里的 ProductSpec**……页面不新建产品主数据 —— 避免"两套真相"」 | `page.tsx:13-14`；卡片描述 `page.tsx:106`；空态文案 `page.tsx:112` |
| 基础信息字段 | 6 个固定键：`material` / `surface` / `usage` / `hs_code` / `packing` / `origin` | `page.tsx:43-50` |
| 图片归类 | `media_kind` ∈ production/size/weight/finished/other，同一类型可多张，主图唯一 | `page.tsx:52-58, 174-214`；`kaas_common.files.MEDIA_KIND_LABELS`（`files.py:46`） |
| 写接口（图片） | `POST /products/{key}/media`（multipart）+ 预签名直传 `POST /file-objects/presign` → `register` | `files.py:294-311`；`use-products.ts:112-162` |

### 1.2 `/settings/tenant-products`（"产品定义管理"工位，管理组，**仅内部账号**）

页面文件：`frontend/src/app/(app)/settings/tenant-products/page.tsx`

| 维度 | 事实 | 证据 |
|---|---|---|
| 产品清单来源 | **`tenant_products` 表**（本租户行 + `is_system=true` 行） | 后端 `backend/orchestrator/app/api/tenant_products.py:68-88`；前端 `page.tsx:48-54` 调 `GET /tenant-products` |
| 新建产品 | `POST /api/v1/tenant-products` —— **真的能新建产品主数据** | `tenant_products.py:91-121`（`TenantProduct(...)` 落库，`:115` 强制 `is_system=False`） |
| 编辑 | `PUT /api/v1/tenant-products/{id}`（系统级 403、跨租户 404） | `tenant_products.py:124-149`（`:136-140`） |
| 删除 | `DELETE /api/v1/tenant-products/{id}`（同上两条闸门） | `tenant_products.py:152-169` |
| 规格 | `spec` 为 **JSONB**，落库前必须能过 `spec_from_dict` | `models.py:597-598`；`tenant_products.py:98-101, 141-144` |
| 前端表单 | 产品 Key / 名称 / 利润模式 / 利润率 / 综合税费系数 / 成本口径 共 6 个控件 + 一个**裸 JSON 文本框** | `page.tsx:117-205`（JSON 文本框在 `:197-205`，label 文案「规格定义 (JSONB)」） |
| 前端列表 | 表格 7 列（Key/名称/利润模式/利润率/税费系数/状态/操作） | `page.tsx:227-293` |
| 工位登记 | key `tenant-products`，`group:admin`、`adminOnly:true`、`status:active` | `shared/contracts/workstations.ts:308-318`；后端镜像 `backend/orchestrator/app/domain/workstations.py:124-131` |

### 1.3 Worker（生产）侧同构

**【已核实】** 两端**都有**这套路由，不存在"本地有线上没有"的漂移：
`backend/worker/src/ws_products.py:141-274`（tenant-products CRUD）、`:290-357`（workstation-products）、
`backend/worker/src/ws_files.py:245-334`（products/media）。`scripts/route-parity-allowlist.txt` 里**没有**
products 相关条目（该文件全文 43 行），与"两端齐全"一致。

---

## 2. 字段级对照表（任务第 2 条）

### 2.1 两个 DTO / 两张表

**A 侧：`/products`（无自己的表；3 个来源拼装）**

| 输出字段 | 真实来源 | 证据 |
|---|---|---|
| `product_key` | `ProductSpec.key`（代码） | `files.py:232-234` |
| `name` / `name_en` / `category_code` | `ProductSpec`（代码） | `files.py:236-238` |
| `media_count` | `file_objects` 聚合 | `files.py:216-221, 239` |
| `profile` | `product_profiles.info`（JSONB） | `files.py:225-227, 240` |
| `media_kinds` | `kaas_common.files.MEDIA_KIND_LABELS` | `files.py:242` |

`ProductRow` 类型：`frontend/src/lib/products/use-products.ts:36-43`。

**B 侧：`/settings/tenant-products`（表 `tenant_products`）**

| 列 | 类型/默认 | 证据 |
|---|---|---|
| `id` | BIGSERIAL PK | `models.py:584`；迁移 `202610100006_tenant_products.py:26,45` |
| `tenant_id` | TEXT NOT NULL（**恒为 `"default"`**） | `models.py:585`；`backend/orchestrator/app/core/auth.py:66, 218` |
| `product_key` | TEXT NOT NULL | `models.py:586` |
| `product_name` / `product_name_en` | TEXT | `models.py:587-588` |
| `category_code` | TEXT | `models.py:589` |
| `cost_field` / `cost_basis` / `cost_unit` | TEXT（默认 raw_price / pretax） | `models.py:590-592` |
| `profit_mode` / `profit_value` / `misc_fee_rate` | TEXT / NUMERIC(10,6) / NUMERIC(10,6) | `models.py:593-596` |
| `spec` | **JSONB NOT NULL**，注释写「完整 ProductSpec」 | `models.py:597-598`；迁移 `:39-40` |
| `is_system` | BOOLEAN NOT NULL default false | `models.py:599` |
| `is_active` | BOOLEAN NOT NULL default true | `models.py:600` |
| `created_at` / `updated_at` | TIMESTAMPTZ | `models.py:601-602` |
| 唯一键 | `(tenant_id, product_key)` | `models.py:604-607`；迁移 `:47-52` |

DTO：入参 `TenantProductIn`（`tenant_products.py:23-35`）、出参 `TenantProductOut`（`:38-52`）。
Worker 侧逐字段镜像：`ws_products.py:119-131`（In）、`:97-114`（Out）。

### 2.2 重叠与冲突

| 语义 | A 侧（`/products`） | B 侧（`tenant_products`） | 判定 |
|---|---|---|---|
| 产品标识 | `product_key`（代码 `ProductSpec.key`） | `product_key`（DB 行） | **同名、不同来源**。唯一键只约束"同租户内不重复"，**不阻止与代码 key 重名** → 产生"影子行"（§3.2） |
| 显示名 | `name`（`files.py:236`） | `product_name`（`tenant_products.py:25,57`） | **字段名不同、语义相同** → 合并必须选一个名字 |
| 英文名 | `name_en` | `product_name_en` | 同上 |
| 分类 | `category_code` | `category_code` | **同名同义、两处存** → 重复真相（哪边是权威未定义） |
| 包装 | `product_profiles.info.packing`（`page.tsx:48`） | 无此列；但 `ProductSpec.constants["packing"]` 又存一份（`products/chain_link.py:65-73`，`"packing": "无包装"`） | **同一语义两处存**（且都不在 B 侧）→ 单证取哪个值未定义 |
| 成本口径 | 无 | `cost_field` / `cost_basis` / `cost_unit` 列 **+** `spec` 内同名字段 | **同一语义在 B 侧存两遍**（见 2.3） |
| 利润口径 | 无 | `profit_mode` / `profit_value` / `misc_fee_rate` 列 **+** `spec` 内同名字段 | 同上 |
| 规格定义 | `ProductSpec`（代码，唯一驱动算价） | `spec` JSONB | **真正的分叉点**（§3） |
| 系统级 | **无此概念**（"系统级"= 代码注册表） | `is_system` 列 | 语义错位：B 侧用它表示"代码产品"，但代码产品**根本不在这张表里** |
| 启用/停用 | 无此概念 | `is_active` 列 | 只有 B 侧有；`/products` 列表**不读它** |
| 租户自建 vs 系统 | 无 | `is_system=false` 恒成立（唯一写入路径强制） | 见 §3.3 |
| 图片 | `file_objects`（有 `team_id` 列） | 无 | 合并后图片仍需一条归属路径 |
| 基础信息 | `product_profiles.info`（**无 `team_id` 列**） | 无 | 见 §2.4 |

### 2.3 B 侧自身的重复：列 vs `spec`

**【已核实】** `cost_field` / `cost_basis` / `cost_unit` / `profit_mode` / `profit_value` / `misc_fee_rate`
**同时存在两处**：

- 表列：`models.py:590-596`
- `spec` JSONB 内：`services/export_quote/tenant_products.py:26-28`（cost_*）、`:41-43`（profit_* / misc_fee_rate）

而**唯一**会把 DB 行变成 `ProductSpec` 的读取函数 `spec_from_dict` **只读 `spec`**，完全忽略这些列
（`services/export_quote/tenant_products.py:19-44`，`:74` 调用）。

**【已核实】** 前端编辑时也不会把利润值写进 `spec`：点「编辑」只把 JSON 文本框初始化为
`{key, name}`（`page.tsx:264-274`），保存时把该文本解析后原样作为 `spec` 提交（`page.tsx:56-69`）。

> **推论（【推测】）**：即使将来把 `TenantProductLoader` 接进引擎，**在 UI 里改利润率也不会生效** ——
> 引擎会读到 `spec.profit_value`（默认 0.06），而不是用户填的那一列。合并时这是**必须先解决的**一致性问题。

### 2.4 隔离粒度：产品数据当前是"实例级"，不是"团队级"

**【已核实】**
- `tenant_id` 恒为 `"default"`、不参与业务鉴权（`app/core/auth.py:66`，`:218` 赋 `DEFAULT_TENANT`）。
- `product_profiles` 主键是 `(tenant_id, product_key)`，**没有 `team_id`**（迁移 `202610110016…py:86-95`）。
- 产品图查询**只按 `tenant_id` 过滤，不带 `team_id`**：
  - 列表聚合 `files.py:216-222`（`WHERE tenant_id=:t AND owner_type='product' …`）
  - 图片列表 `files.py:282-291`（同）
  - Worker 侧同构：`ws_files.py:248-256`
- 与之对照，`file_objects` **有** `team_id` 列（迁移 `202610110016…py:42`），上传时也会写入（`files.py:200-206`）。

> **结论（【已核实】行为 + 【推测】定性）**：由于 `tenant_id` 恒为 `"default"`，产品图与产品基础信息目前是
> **全实例共享**的；`team_id` 只是被写了、没被用来过滤。合并方案必须显式回答"产品图是公司共享还是团队私有"，
> 否则会把一个错误粒度抄进新模块。

---

## 3. 键空间与"两套真相"到底在哪一侧（任务第 3 条）

### 3.1 事实上存在**三个**"产品是什么"的来源

| # | 来源 | 谁读它 | 谁写它 | 是否驱动算价 |
|---|---|---|---|---|
| 1 | **代码注册表** `products/*.py`（3 个真实产品） | `/products` 列表（`files.py:232`）、报价引擎（`get_product`） | 改代码 + 重启 | ✅ **是唯一** |
| 2 | **`tenant_products` 表** | `/tenant-products` 列表、`/workstation-products` 矩阵 | `/settings/tenant-products` 页面（POST/PUT/DELETE） | ❌ **否** |
| 3 | **`tenant_workstation_products` 表** | `/workstation-products` | `/workstation-products` POST | ❌ 否（且**前端无人调用**） |

### 3.2 来源 2 为什么"进不了算价"（关键证据链）

1. **算价入口只认代码注册表**：
   `_effective_product` 只做 `product = get_product(product_key)`（`app/api/export_quote.py:741-758`，`:755`），
   随后只叠加"客户自加档位"（`:692-713`）与"团队级覆盖"（`:716-738`），**没有任何一处查 `tenant_products`**。
   Worker 侧同样只 `get_product`（`backend/worker/src/quote_api.py:317, 329, 543, 579`）。
2. **唯一会读 `tenant_products.spec` 的类没有调用点**：
   `TenantProductLoader` 定义在 `services/export_quote/tenant_products.py:53-103`（`load` 在 `:64-85`，
   DB 优先在 `:70-76`）。全仓检索 `TenantProductLoader` → **只有定义处**（见 §9 未查到清单）。
3. **列表 API 也证实了这个分叉**：
   `/products` 只遍历 `product_keys()`（`files.py:232`），所以**租户在 `/settings/tenant-products` 建的产品
   永远不会出现在 `/products` 页**；反之，代码里的 3 个产品也**不会**出现在 `/tenant-products` 列表里
   （那张表没数据，见 3.3）。
4. **`/workstation-products` 的清单来源是表**（`workstation_products.py:49-59`：系统级行 + 本租户 `is_system=false` 行），
   于是这个"选择启用产品"的矩阵里**也看不到那 3 个真实产品**。

### 3.3 `is_system=true` 目前**不可达**

**【已核实】**
- 表结构有 `is_system`（`models.py:599`），注释声称"系统级产品所有租户可见、仅平台管理员可编辑"（`:578-580`）。
- 但**唯一**构造 `TenantProduct(...)` 的地方是 `tenant_products.py:102-117`，其中 `is_system=False`（`:115`）；
  `TenantProductIn` 里**根本没有 `is_system` 字段**（`:23-35`）。
- Worker 侧 `INSERT INTO tenant_products … VALUES (…, false, $13)`（`ws_products.py:180-191`，`false` 在 `:185`）。
- 迁移目录里 `202610100006`（建表）、`202610100007`（矩阵表）**都只建表、不插数据**；
  全仓检索 `INSERT INTO tenant_products` → 只有 `ws_products.py:181` 一处（值恒为 false）。
- 因此：【已核实】**没有任何代码路径能创建 `is_system=true` 的行**。
  【未查到】生产库里是否有人工插入的 `is_system=true` 行（见 §9）。

### 3.4 所以"两套真相"在哪一侧 —— 明确回答

- **不在"`/products` 页 vs `/settings/tenant-products` 页"这一层**：两个页面没有互相复制数据。
- **在"代码 vs 表"这一层**：`tenant_products` 是一条**只写不读（对引擎而言）的平行账本**，
  它自己能新建产品主数据（`tenant_products.py:91-121`），却与"哪些产品能被报价"完全脱钩。
- **风险的正确定位**：`/products` 的页头注释（`page.tsx:13-14`「页面不新建产品主数据」）**是对的**（该页确实不新建）；
  但"整个平台不新建产品主数据"这句话**不成立** —— 隔壁 `/settings/tenant-products` 就在新建。
  **两句话都是真的，合起来才是那个坑。**
- **“冻住”何时真的发生**：`TenantProductLoader` 一旦被接进读取路径（它本来就是为此写的），
  同 `product_key` 的 DB 行会**整体遮蔽**代码定义（`services/export_quote/tenant_products.py:70-76`：
  命中即 `return spec_from_dict(row["spec"])`，不再回退）。

---

## 4. 合并形态建议（任务第 4 条）

> 以下为【推测】方案，不是已核实事实。

### 4.1 结构：一个工位 + 两个 tab，主键 `product_key`

| | tab `定义` | tab `图片与基础信息` |
|---|---|---|
| 主键 | `product_key` | `product_key`（= `file_objects.owner_id` / `product_profiles.product_key`） |
| 行来源 | 代码注册表 `keys()` ∪ 本租户 `tenant_products`，按 `product_key` 去重 | 同左（同一份行集合，避免第二个清单来源） |
| 读 | 系统级：`get_product(key)`；租户级：该行的 `spec`（经统一的有效 spec 装配） | `GET /products/{key}/profile`、`GET /products/{key}/media` |
| 写 | 系统级：**只读**（显示"来自代码定义"）；租户自建：可视化编辑器 | `PUT /products/{key}/profile`、媒体上传/改名/主图/下线 |
| 现有页面 | 现在这个能力**不存在**（只有裸 JSON 文本框） | 已经存在，整页搬进来即可 |

**必须新增的字段**：每行带一个 `source: "code" | "tenant"`（【推测】）。
理由：只要"行从哪来"不可见，就还会出现"我建的产品怎么不见了/算不了价"的同一类困惑（§3.2 第 3、4 条）。

### 4.2 读写路径建议

- **保留 `/api/v1/products*` 作为唯一对外读路径**，把它扩展为"注册表 ∪ 本租户行"（现在只遍历注册表，`files.py:232`）。
- **定义写入仍走 `/api/v1/tenant-products*`**（阶段 1 不动它，避免破坏 `route-parity` 与两端对等），
  但**加一列 `source` 到出参**，并**把 `spec` 加进出参**（现在 `TenantProductOut` 没有 `spec`，见 §2.1 / §2.3 的后果）。
- **长期（阶段 2）**：把 `/api/v1/tenant-products` 收敛为 `/api/v1/products/{key}/definition`，
  只留一套面；【推测】这一点**不要和合并同一轮做**，否则出问题时无法二分定位。

### 4.3 所有权（系统级 vs 租户级）

| 对象 | 所有权 | 编辑权 | 依据 |
|---|---|---|---|
| `product_key` ∈ 代码注册表 | 平台（= 代码） | 租户**只能覆盖**（差异），不能改本体 | `products/__init__.py:34-39` 的 `keys()` 就是判据 |
| `product_key` ∉ 代码注册表（租户自建） | 该租户 | 租户全权（整份） | 现有 POST 行为（`tenant_products.py:91-121`） |
| 图片 / 基础信息 | **需用户裁决**（现在是实例级，§2.4） | 同左 | 迁移 `202610110016…py:86-95`、`files.py:216-222` |

### 4.4 侧边栏 / 契约收口（**必须成对改**）

**【已核实】** 两个入口**同时存在且都上侧边栏**：
- `products`：`group:'business'`、`adminOnly:false`、`status:'active'`（`workstations.ts:192-205`；`domain/workstations.py:72-78`）
- `tenant-products`：`group:'admin'`、`adminOnly:true`、`status:'active'`（`workstations.ts:308-318`；`domain/workstations.py:124-131`）
- 而 `admin` 组是 `internalOnly:true`（`workstations.ts:73`），侧边栏对非 internal 用户整组跳过
  （`frontend/src/components/layout/sidebar.tsx:137-138`）。

> **【已核实】权限粒度冲突**：`/products` 是**人人可见**，"产品定义管理"是**仅内部**。
> 合并成一个工位就必须选一个（这是**策略不确定 → 需弹窗**，见 §8 前置条件 3）。
> 【推测】建议：工位保持"人人可见"，`图片与基础信息` tab 全员可用（单证要引用产品图），
> `定义` tab 对非内部账号只读。

改两处镜像（`workstations.ts` + `domain/workstations.py`）会被 `contracts:check` 的 R2 强制
（`scripts/contracts-check.ts:127-135, 324-356`），这是好事：漏改一边会直接红。
同时 `SUB_ROUTE_LABELS['tenant-products']`（`workstations.ts:86`）与
`可访问路径白名单`（`backend/kaas_common/workstation/subscriptions.py:67`）也要一起看。

---

## 5. 可视化编辑器：落位、控件清单、工作量（任务第 5 条）

### 5.1 先纠正一个前提（避免做出空表单）

**【已核实】** 任务描述里的"规格轴"在**三个真实产品里全部为空**：

| 产品 | `axes=` | 证据 |
|---|---|---|
| 勾花网 `chain_link` | `[]` | `products/chain_link.py:76` |
| 牛栏网 `field_fence` | `[]` | `products/field_fence.py:80` |
| 鹿网 `deer_net` | `[]` | `products/deer_net.py:83` |

代码里连 `Axis(` 的构造都没有（`products/*.py` 中 `Axis(` 出现 0 次）。
`docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md:26` 的示例写的是 `axes=[Axis("height_m", …)]`，
**那是 2026-10-10 的旧口径，已被后来的"自由数值规格参数"改造取代**
（见 `models.py:90-122` 的 `NumericInput` docstring：「可枚举的继续用 Axis / VariantGroup；连续的用 NumericInput」）。

> **编辑器第一版必须覆盖的是 `numeric_inputs` + `variants` + `pricing_key`，不是 `Axis`。**
> `Axis` 可以保留入口但标"当前产品未使用"。

### 5.2 控件清单（按 `ProductSpec` 字段，`models.py:195-238`）

| # | 分组 | 控件 | 子字段 | 量级（当前 3 个产品） |
|---|---|---|---|---|
| 1 | 头部 | key（编辑时只读）、名称、英文名、分类、HS 编码（多值） | 5 | — |
| 2 | 成本口径 | `cost_field`、`cost_basis`（下拉 pretax/incl_tax）、`cost_unit`、`profit_mode`（下拉）、`profit_value`、`misc_fee_rate` | 6 | — |
| 3 | **自由数值规格** | 可增删行的表格 | `key/label/label_en/unit/ui_unit/ui_scale/default/min_value/max_value/decimals/unit_factors/note`（`models.py:108-122`） | **5 / 8 / 9 条**（chain_link / field_fence / deer_net） |
| 4 | **变体包** | 组表格 + 每组的 `options` 子表（`options` 是 **dict 列表**，键随产品变） | `name/label/label_en` + options | **1 / 2 / 1 组** |
| 5 | 规格轴（低优先） | 表格 | `name/options/label/label_en`（`models.py:32-39`） | **0 条**（见 5.1） |
| 6 | **公式** | 三张表（`derived` / `piece_metrics` / `order_metrics`） | `name/expr/decimals/integer/label/label_en/unit/note`（`models.py:13-29`） | derived **14 / 19 / 14** 条 |
| 7 | 体积扣减 | 模式下拉（fixed/median/mean/formula/ratio）+ 条件字段 | `mode/value/range/expr/note`（`models.py:161-185`） | 1 条/产品 |
| 8 | **输出列** | 表格（**含 `internal` 勾选，必须显式警示**） | `key/label/label_en/decimals/internal/width`（`models.py:136-149`） | **22 / 38 / 25** 条 |
| 9 | 约束 | 表格 | `name/expr/severity(error|warning)`（`models.py:152-158`） | **9 / 20 / 7** 条 |
| 10 | 其它 | `params`（四元组列表）、`notes`（字符串列表）、`constants`（键值对，含 `packing`） | — | params/notes 每产品各 1 段 |

**量级来源**：`products/chain_link.py`(266 行) / `field_fence.py`(436 行) / `deer_net.py`(308 行)，
按构造次数统计（`FormulaSpec(` / `NumericInput(` / `VariantGroup(` / `Column(` / `Invariant(`）。

> **第 8 项不是普通字段**：`Column.internal=True` 是"对外展示不得暴露成本利润率"这条铁律的落地点
> （`models.py:137-141` 的 docstring）。编辑器必须把这个开关做得**显眼且不可误点**，
> 否则合并会亲手开一条泄露成本的口子。

### 5.3 两个必须补的能力（现在没有）

1. **`spec` 回显**：【已核实】`TenantProductOut` **不含 `spec`**（`tenant_products.py:38-52`，Worker 同 `ws_products.py:97-114`），
   前端点「编辑」时把 JSON 文本框重置成 `{key, name}`（`page.tsx:264-274`）→
   **保存会把原有 spec 整体覆盖成两字段对象**（校验能过，因为 `spec_from_dict` 只要 `key`，见 §6.2）。
   可视化编辑器上线前必须先把 `spec` 加进出参，否则编辑器是"打开即丢数据"。
2. **公式合法性校验**：【未查到】是否存在现成的"spec 试算/诊断"纯接口（§9）。
   `spec_from_dict` **只构造、不校验 `expr`**（`services/export_quote/tenant_products.py:19-44`），
   所以 422 闸门挡不住写错的公式 —— 【推测】需要一个"试算一行"的后端接口，否则编辑器只是把 JSON 打字错误
   换成了表单打字错误。

### 5.4 工作量量级（【推测】，单位=轮次）

| 步骤 | 轮次 |
|---|---|
| 后端：`spec` 加进出参 + 有效 spec 装配 + 差异合并 + 422 闸门复用 | 2–3 |
| 前端：工位合并成两个 tab、数据层合并（`lib/products` + `settings` 两套 hook 收敛成一套） | 1–2 |
| 表单：头部/成本口径/数值规格/变体包/三张公式表/列/约束/体积扣减/params/notes/constants | 4–6 |
| 公式试算与错误提示（含后端试算接口） | 1–2 |
| 门禁全绿（两端 pytest + contracts R2 + route-parity + 前端 typecheck/lint/test + `NEXT_EXPORT=1 pnpm build`） | 1–2 |
| **合计** | **8–13 轮** |

> 不含"用户看到第一版后返工"的轮次；按本项目历史，界面类返工通常再加 2–4 轮。

---

## 6. 存储语义：整份快照 vs 差异（任务第 6 条）

### 6.1 现状 = 整份快照（已核实）

- 列注释即口径：「完整 ProductSpec（JSONB，含 axes/variants/derived/columns/invariants）」`models.py:597-598`；
  迁移同文 `202610100006_tenant_products.py:39-40`；`spec` **NOT NULL**。
- 文档口径一致：`docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md:61-62`。
- 风险已被记录**两遍**：
  - `models.py:618-620`（`TeamOptionOverride` docstring）：「那张表存的是**完整 ProductSpec 快照**，
    把几个档位的改名写进去，会让该租户的产品定义**冻成快照** —— 以后代码改了产品定义它不跟着变。」
  - `docs/PROBLEM_STATUS_2026-10-11.md:1505-1506`（同一句话的决策记录）。
- 机制在 `services/export_quote/tenant_products.py:70-76`：命中 DB 行 → 直接用快照，**不回退代码**。

### 6.2 `spec_from_dict` 的合并语义注意点（逐条，均已核实源码行为）

```python
# backend/orchestrator/app/services/export_quote/tenant_products.py:19-44（节选）
def spec_from_dict(data: dict) -> ProductSpec:
    return ProductSpec(
        key=data["key"],                                   # ← 硬要求
        name=data.get("name", ""),                         # ← 缺失 = 静默取默认
        ...
        axes=[Axis(**a) for a in data.get("axes") or []],  # ← 多/少字段 → TypeError
        derived=[FormulaSpec(**f) for f in data.get("derived") or []],
        ...
        profit_value=data.get("profit_value", 0.06),       # ← 列里的值被忽略
    )
```

| # | 注意点 | 证据 | 对"差异存储"的影响 |
|---|---|---|---|
| 1 | **它不是合并函数，是整体构造**；缺失字段**静默落默认值** | `:19-44` 全程 `data.get(...)` | 差异**不能直接喂** `spec_from_dict`；必须"取系统级 spec → 套差异 → （可选）序列化" |
| 2 | **列表字段 `or []`**：传 `null` 与不传**等价** | `:30-37` | "删掉一条公式"在整份快照里 = "不写它"；在差异模型里**必须显式建模**（如 `{"remove": {...}}`），不能靠"键不出现" |
| 3 | **字段改名 → 静默退化，不报错** | `:21-44` 认的是固定字段名 | 旧快照遇到改名会**悄悄变成默认值**；这是本项目最怕的"看起来像结论"。必须有 `spec_version` / 形状校验 |
| 4 | `key` 缺失 → `KeyError`，被路由包成 422 | `:22`；`tenant_products.py:98-101, 141-144` | 可以当"最低限度闸门"，但**不足以**当形状校验 |
| 5 | `Axis(**a)` / `VariantGroup(**v)` / `FormulaSpec(**f)` 是**鸭子构造** | `:30-37` | 多一个键就 `TypeError`；差异合并后**必须再喂一次** `spec_from_dict` 当形状闸门（两端已有此习惯：`tenant_products.py:99`、`ws_products.py:74-79`） |
| 6 | `spec_to_dict` 只是 `dataclasses.asdict` | `:47-50` | 序列化会**补齐所有默认值**（把"没写"变成"写了默认值"）→ 一旦序列化回存，就再也分不清"用户设的默认值"和"没设" |

> **第 3 条要特别当心**：`PROBLEM_STATUS_2026-10-11.md:34-35` 记录的教训正是"用关键字 grep / 过滤后的输出
> 得出看起来像结论的东西"。`spec_from_dict` 的静默默认值有完全相同的性质 —— **不会报错**。

### 6.3 建议模式（【推测】）

> **系统级产品（`product_key ∈ product_keys()`）存差异；租户自建产品（key 不在注册表里）存整份。**

理由：系统级产品的"本体"是代码，差异保证"上游改公式/加列仍然生效"（这就是 `models.py:618-620` 想要的性质）；
租户自建产品没有上游，整份才是完整定义。

**差异的颗粒度建议（分两步，不要一次做满）**：

- **第一步（低风险，语义现成）**：只做"**档位/选项层**的覆盖" —— 改显示名 + 软停用。
  已有**可直接对齐的先例**：表 `team_option_overrides`（`models.py:610-649`）、
  服务 `services/option_overrides.py`（`normalize_overrides:40-57`、`merge_override:112-154`，
  其中 `:128-138` 定义了"传空串 = 取消改名"、`:147-150` 定义了"空了就删键"的语义）、
  应用 `models.apply_option_overrides`（`models.py:447`）+ 接线 `export_quote.py:716-738`。
- **第二步（高风险，须单独立项）**：改公式 / 加列 / 改约束。
  【推测】不建议现在做：这是 list-of-dataclass 的 diff，"删一条公式"会直接影响历史报价单重算口径，
  且 `spec_from_dict` 对改名静默退化（§6.2 #3），没有版本化就会埋雷。

**差异模型的必备字段（【推测】）**：`product_key`、`scope`（团队 or 实例）、`override` JSONB、
`base_spec_hash`（记录写差异时对应的代码 spec 指纹，用于发现"上游已变"）、`updated_by/at`。

### 6.4 是否需要迁移（【已核实】+【未查到】）

**【已核实】的事实**：
- `tenant_products.spec` 是 `NOT NULL`（`models.py:598`、迁移 `:40`）。
- **没有任何种子数据**：迁移目录里只有 `202610100006`（建表）与 `202610100007`（矩阵表）两个相关文件，
  都不插数据；全仓唯一的 `INSERT INTO tenant_products` 在 `ws_products.py:181`，且 `is_system=false`。

**【未查到】的事实**：生产库里 `tenant_products` 到底有没有行、有没有 `is_system=true` 的行。
（本机 5432 无监听 —— `Test-NetConnection 127.0.0.1:5432` 返回 False；根目录无 `.env`；
`docker-compose.yml:7-15` 的 postgres 端口映射是 `5432:5432`，即本地开发库当前没起。**本轮不访问生产库**。）

**因此迁移口径（【推测】）**：
- 若生产库**没有**"key ∈ 代码注册表"的租户行 → **不需要数据迁移**，只需加列（`override` JSONB / `base_spec_hash`），
  且**不要动 `spec` 旧值**（留着可回滚）。
- 若有这类"影子行" → 需要一次性把它们从"整份快照"降级为"与系统级 spec 的差异"，且**必须人工复核**：
  自动 diff 无法区分"用户故意改成这个值"和"当年复制快照时的默认值"。
  取证方法：`SELECT product_key, is_system, is_active, updated_at FROM tenant_products;`
  再与 `product_keys()`（= `chain_link/field_fence/deer_net`）求交集。

---

## 7. 风险与落地顺序（任务第 7 条）

### 7.1 冲突面（【已核实】来自工作区 `git status --short` 快照）

合并要碰的文件里，**正在被另一条任务改**的有：

| 文件 | 状态 | 合并是否需要它 |
|---|---|---|
| `frontend/src/app/(app)/products/page.tsx` | `M`（已改 22 行） | ✅ 必须改（tab 化） |
| `frontend/src/app/(app)/products/hooks/use-products.ts` | `D`（已移到 `frontend/src/lib/products/use-products.ts`，`??`） | ✅ 必须改 |
| `backend/orchestrator/app/api/files.py` | `M`（+178 行） | ✅ 必须改（读路径合并） |
| `backend/worker/src/ws_files.py` | `M`（+163 行） | ✅ 必须改（两端对等） |
| `backend/orchestrator/app/api/trade_docs.py` | `M` | ⚠️ 间接（产品图引用） |
| `backend/kaas_common/files/*` | `M` / `??` | ⚠️ 间接（`sync-shared.ps1` 要跑） |
| `docs/PROBLEM_STATUS_2026-10-11.md` | 干净（但按其"每完成一项就更新"的规则，另一条任务**一定会改**） | ✅ 收口时要改 |

> **【已核实】本次分析没有碰任何上述文件**（见 §10 的 `git status` 证据）。

### 7.2 「何时才能动手」的前置条件（全部满足才开工）

1. **另一条任务已提交并推送**：`git status --short` 里 `products/**`、`lib/products/**`、
   `files.py`、`ws_files.py`、`trade_docs.py`、`kaas_common/files/**` 全部干净。
2. **另一条任务的门禁结果已知**（至少前端 `typecheck`/`test` 与 worker `pytest` 的状态明确）；
   否则合并后的失败无法二分定位到是谁引入的。
3. **用户拍板两件策略**（**策略不确定 → 必须弹窗，不自行决定**）：
   - (a) 合并后工位的**可见性粒度**：人人可见还是仅内部？（现在一个是一个人可见、一个是仅内部，§4.4）
   - (b) **存储模式**：系统级存差异 + 租户自建存整份（本方案建议）还是继续整份快照？
   - (c) 附带：产品图/基础信息是**公司共享**还是**团队私有**？（现状是实例级共享，§2.4）
4. **生产库取证**：`tenant_products` 行数与 `is_system` 分布（决定是否要数据迁移，§6.4）。
5. **`frontend/src/app/(app)/products/page.tsx` 同一时刻只允许一个人改**（本文件、`files.py`、`ws_files.py`、
   `workstations.ts`、`domain/workstations.py` 都是单写者文件）。

### 7.3 最小冲突的落地顺序（【推测】；每步一个提交 + 跑门禁）

| 步 | 内容 | 触碰范围 | 依赖 |
|---|---|---|---|
| S1 | 本文档 + 用户拍板（§7.2 的 3 个问题） | `docs/` 新增 1 个文件 | 无 |
| S2 | 后端**只读**合并：`/api/v1/products` 返回"注册表 ∪ 本租户行"并带 `source`；`TenantProductOut` 补 `spec` | `files.py`、`ws_files.py`、`tenant_products.py`、`ws_products.py` | 前置 1–2 |
| S3 | 前端**行为等价**重构：一个工位两个 tab，把现有两页内容搬进去，**JSON 文本框原样保留** | `products/page.tsx`、新 `products/**` 组件 | S2 |
| S4 | 契约收口：删 `tenant-products` 工位条目（ts+py 双镜像）、`/settings/tenant-products` 改 redirect、跑 `contracts:check` | `workstations.ts`、`domain/workstations.py`、`settings/**` | S3 + §7.2-(a) |
| S5 | 存储语义：差异模型（对齐 `team_option_overrides`）+ 迁移（视取证结果） | `models.py`、新迁移、`services/**`、两端 api | §7.2-(b)(c) + S2 |
| S6 | 可视化编辑器，分 2–3 小步：先 `numeric_inputs`/`variants`/`derived` → 再 `columns`/`invariants`/`space_deduction` → 再 `params`/`notes`/`constants` + 公式试算 | 前端组件 + 后端试算接口 | S5 |
| S7 | 收口：更新 `PROBLEM_STATUS_2026-10-11.md:1844`（该行正写着"⏸ 待用户输入"）与 `PRODUCT_CONFIG_TENANT_UNFINISHED.md:13, 97` | `docs/` | 全部 |

> **不要跳步**：S3 与 S5 若合并成一轮，一旦出问题，"是搬家搬坏了还是差异合并算错了"无法区分。

---

## 8. 未查到清单（明确标注，不含猜测）

| # | 我没查到什么 | 尝试过什么 | 怎么才算查到 |
|---|---|---|---|
| 1 | 生产库 `tenant_products` 的行数 / `is_system=true` 是否存在 / `spec` 的实际形状 | 本机无 Postgres 监听（`127.0.0.1:5432` → False）、根目录无 `.env`、迁移里无种子数据、全仓无第二处 INSERT | 在生产库执行 `SELECT count(*), count(*) FILTER (WHERE is_system) FROM tenant_products;` |
| 2 | `/api/v1/workstation-products` 的**前端调用者** | 对 `frontend/src` 全量检索字面量 `workstation-products` → **0 命中** | 需要看到某个前端模块构造该 URL（含变量拼接）；否则按"无调用者"处理 |
| 3 | `TenantProductLoader` 的**调用者** | 全 `backend/**` 检索 `TenantProductLoader` → 只有定义处 `services/export_quote/tenant_products.py:53` | 需要看到 `TenantProductLoader(` 的实例化点 |
| 4 | 现成的**公式试算/诊断**纯接口（给可视化编辑器校验 `expr`） | 只确认了 `spec_from_dict` 不校验 `expr` | 需要找到可直接调用的诊断函数/路由 |
| 5 | `/products` 与 `/settings/tenant-products` 的**测试覆盖** | `frontend/e2e/*.spec.ts` 8 个文件里**没有** products 相关用例；`frontend/src` 里检索 `useProducts`/`productKeys`/`useProductMedia` → 0 命中；`settings.spec.ts` 只覆盖 `/settings` 的 tab 切换与租户列表 | 需要新增；也说明这块**合并时没有测试网** |
| 6 | Worker 端 `spec_to_dict` 是否被使用 | `tenant_products.py:18` 同时 import 了 `spec_from_dict, spec_to_dict`，但全文件只见 `spec_from_dict` 被调用（`:99, :142`） | 需要确认是否遗留死导入（**未核实是否真的无其他引用**） |

---

## 9. 交付门禁（改完必须全绿，来自 `AGENTS.md`）

orchestrator `pytest -m unit`；worker `pytest`；前端 `typecheck` / `lint` / `test`；
`contracts:check`（R2 会强制 `workstations.ts` ↔ `domain/workstations.py` 一致）；
`python scripts/route-parity.py`；`pwsh scripts/sync-shared.ps1 -Check`；`NEXT_EXPORT=1 pnpm build`。

环境（无 `pnpm`/`npm` 直接可用）：

```
C:\Users\HJ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe \
C:\Users\HJ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs <cmd>
# 跑 .ps1 前先：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

---

## 10. 本任务的自证（只读、只加一个文件）

本分析**只新增 `docs/PRODUCT_MODULE_MERGE_PLAN.md`**，未修改任何代码/文档。
`git status --short` 在本文件存在后应显示：除该文件为新增（`??`）外，
只有**另一条任务的**改动，**没有本任务对任何已有文件的修改**。

复核命令（任何人可复跑）：

```powershell
git status --short
git diff --stat      # 本任务的文件不会出现在这里（它是未跟踪的新文件）
```
