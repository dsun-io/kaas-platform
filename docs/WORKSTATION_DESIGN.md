# KaaS 平台工作站总体设计

> **KaaS (Knowledge as a Service)** —— 为传统制造业提供 AI 岗位能力托管。
> 平台以「工作站 (Workstation)」为最小交付单元：每个工作站是一个垂直业务域，
> 既能**独立运行**，又能通过统一的数据层与其它工作站**上下游联通**。
>
> 本文档定义工作站体系结构、数据连通契约与演进路线，是后续所有工位开发的**不变参照**。

---

## 1. 术语定义

| 术语 | 含义 |
|------|------|
| **工作站 (Workstation)** | 一个面向特定业务目标的 AI 能力单元，含前端页面 + 后端 API + 数据表 |
| **工位** | 与「工作站」同义，口语表达 |
| **上下游联通** | 工作站间通过共享数据库键引用、事件流或 API 调用形成数据链路 |
| **独立运行** | 单个工作站不依赖其它工作站即可交付完整价值（自洽的表 + 接口 + 页面） |
| **口子 (Schema 预留)** | 在数据库中预先建立跨工位引用的外键/关联表，使后续工位无需破坏性变更即可接入 |
| **KaaS 数据链** | 平台统一的领域数据骨架：`客户 → 产品(SKU) → 报价 → 订单 → 票据 → 货运` |

---

## 2. 工作站全景视图

### 2.1 已交付

| 工作站 | 域 | 状态 | 说明 |
|--------|----|------|------|
| **商情雷达** (Intel Radar) | 贸易情报 | ✅ 已上线 | 海关/贸易数据采集、货运记录、竞争分析。数据链起点：发现「谁 在什么地区 买什么货」 |

### 2.2 规划中（按优先级）

| 工作站 | 域 | 优先级 | 与现有数据链的关系 |
|--------|----|--------|-------------------|
| **客户管理** (Customers，含询盘入口) | 客户全生命周期 | P0 | 询盘录入→建档→阶段跟踪→成交→自动生成订单；统一底座 |
| **产品市场对照** (Market，含港口情报) | 地区×产品×规格知识 | P0 | 支撑客户工位询盘匹配：地区/品名/用途→规格/港口 |
| **智能报价工位** (Smart Quote) | 智能报价 | P0 | 输入=客户工位成交意向 + 规格；输出=三档方案 + FOB/CFR/CIF |
| **订单工位** (Orders) | 订单履约 | P0 | 输入=客户工位"已成交"询盘；输出=履约订单 |
| **外贸单证工位** (Trade Docs) | 外贸单证 | P1 | **全周期横向工位**：输入=询盘/报价单/订单任一上游实体；输出=Quotation/PI/合同/CI/PL/B/L/CO 等全套单证 |

> 优先级不代表开发顺序，实际排期由业务驱动。各工位可**独立先行**开发，
> 只要遵循 §5 的数据连通契约即可保证后续无缝集成。

---

## 3. 核心设计原则

### 3.1 单工位自洽 (Independent)
每个工作站拥有自己的表（`{domain}_*` 前缀）、API（`/api/v1/{domain}/*`）与前端路由（`/{domain}`）。
- 商情雷达：`intel_*` 表 + `/api/v1/intel/*` + `/intel`
- 报价工位：`quote_*` 表 + `/api/v1/quote-orders/*` + `/quote-orders`
- 订单工位：`orders_*` 表 + `/api/v1/orders/*` + `/orders`
- 单证工位：`trade_docs_*` 表 + `/api/v1/trade-docs/*` + `/trade-docs`

任何工位可单独上线、单独灰度、单独回滚，不阻塞其它工位。

### 3.2 数据连通 (Connected)
跨工位不共享表，通过**稳定业务键**引用：
- 实体主键 `id`（全局自增，跨库唯一）
- 业务编码 `order_no` / `quote_no` / `doc_no`（人类可读，幂等键）
- 租户键 `tenant_id`（多租户隔离不变量）

上游写入、下游读取时，用外键或关联表显式记录引用关系（见 §5）。

### 3.3 松耦合接口 (Loose Coupling)
- **同步联通**：下游工位直接读取上游工位的表（只读视图/查询），通过 `*_refs` 关联表显式建模
- **异步联通**（预留）：事件表 `domain_events`，工位发布领域事件，下游订阅消费
- **禁止**：跨工位直接 UPDATE/DELETE 对方数据；写操作必须经本工位 API

### 3.4 渐进式交付 (Progressive)
先建「口子」（表结构 + 只读引用），后填「血肉」（业务逻辑）。每个工位 MVP 只需：
1. 建表（含跨工位引用键）
2. 实现本工位 CRUD
3. 实现读取上游数据的只读接口

---

## 4. 平台数据链

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        KaaS 统一数据链                                   │
│                                                                         │
│  客户管理(customers) ──► 市场对照(market) ──► 智能报价(quote_orders)     │
│   询盘录入/客户建档    产品×地区×规格        体积重量→FOB/CFR/CIF         │
│   阶段: 询盘中→成交       最近港口匹配          三档方案                  │
│        │                  │                      │                      │
│        │ 已成交           │                      │ 买家确认             │
│        ▼                  ▼                      ▼                      │
│        │                  │              订单工位(orders)                │
│        │                  │              履约订单/订单项                  │
│        │                  │                      │                      │
│  商情雷达(intel) ──(买家信号/品名验证)──► market / inquiries              │
│   货运记录                  (下游读取，回写双向)                          │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │     外贸单证工位 (trade_docs) —— 全周期横向覆盖，非线性末端        │  │
│  │  ┌────────────┬──────────────┬───────────────────────────────┐    │  │
│  │  │ 询盘/报价   │   订单       │          履约/出运             │    │  │
│  │  │ Quotation  │  销售合同    │  PI / CI / PL / B/L           │    │  │
│  │  │ PI 形式发票 │  PI 形式发票 │  产地证 CO / 保险单            │    │  │
│  │  └────────────┴──────────────┴───────────────────────────────┘    │  │
│  │  可从任一上游实体生成: inquiry / quote_order / order               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│   ┌─────────────────────────────────────────┐                           │
│   │  统一底座: customers + product_skus      │                           │
│   │  (客户档案 + 产品规格, 全工位共享只读引用) │                           │
│   └─────────────────────────────────────────┘                           │
└─────────────────────────────────────────────────────────────────────────┘
```

> **单证工位非线性说明**：主干链路是「询盘→报价→订单」，但单证需求贯穿**全周期**——
> 报价阶段即可出 Quotation/PI，订单阶段出销售合同，履约出运阶段出 CI/PL/B/L/CO 等。
> 因此 trade_docs 不从属于订单工位，而是从**任一上游实体**（询盘/报价单/订单）生成，
> 各阶段通过 `trade_doc_*_refs` 关联表溯源。

> **端口距离查询**（属市场/询盘工位能力）：客户地址落库后，根据地址/国家自动匹配
> 最近的出口/目的港口（`market_ports` 表 + 地理距离计算），供货代询价与物流方案使用。

---

## 5. 跨工位数据连通契约

> 以下关联键在数据库迁移 `20260919_workstation_links` 与 `20260921_trade_doc_upstream_refs`
> 中已建立，是所有工位的**接入点**。

### 5.1 关联表总览

| 关联表 | 上游 → 下游 | 语义 |
|--------|------------|------|
| `quote_order_shipment_refs` | intel → quote_orders | 报价单依据哪些货运记录生成（买家/产品信号溯源） |
| `order_quote_refs` | quote_orders → orders | 销售订单由哪些报价单转化而来 |
| `order_shipment_refs` | orders ↔ shipments / intel | 订单关联的实际出运记录（`shipments` 自有出运台账，见 §10.6；亦支持回写 intel 海关情报，双向） |
| `trade_doc_order_refs` | orders → trade_docs | 单证由哪些订单生成（履约/出运阶段） |
| `trade_doc_quote_refs` | quote_orders → trade_docs | 单证由哪些报价单生成（报价/订单阶段，出 Quotation/PI/合同） |
| `trade_doc_inquiry_refs` | cust_inquiries → trade_docs | 单证由哪些询盘生成（询盘/报价阶段，出 Quotation/PI） |

### 5.2 引用键约定

每个关联表遵循同一模式：
```sql
id          BIGSERIAL PRIMARY KEY
tenant_id   TEXT NOT NULL                -- 多租户隔离
{domain}_id BIGINT NOT NULL              -- 上游记录 id
ref_type    TEXT NOT NULL                -- 引用语义标签 (如 'buyer_signal', 'converted_from', 'actual_shipment')
ref_target_id BIGINT                     -- 下游记录 id
ref_no      TEXT                         -- 冗余业务编码 (人类可读，如订单号)
created_at  TIMESTAMPTZ DEFAULT now()
UNIQUE(tenant_id, {domain}_id, ref_type, ref_target_id)   -- 幂等
```

### 5.3 未来扩展位
- 在 `quote_orders` / `orders` / `trade_docs` 主表上预留 `linked_{domain}_id` 冗余外键，
  便于高频查询场景下避免 JOIN 关联表。
- 关联表 `ref_type` 用开放字符串，新业务语义无需 ALTER TABLE 即可接入。

### 5.4 订阅化改造（Phase 6 前置设计）

> 工位独立不仅是逻辑分层，更是**商业边界**。客户可单独订阅任一工位，
> 也可订阅场景包（多工位组合）。不订阅的工位代码不执行、接口不暴露、数据不写入。

**订阅模型**：

```sql
-- 订阅主表
subscriptions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plan_code TEXT NOT NULL,          -- 'intel' / 'customers' / 'market' / 'quote' / 'orders' / 'docs'
  plan_type TEXT NOT NULL,          -- 'single' / 'bundle' / 'enterprise'
  bundle_code TEXT,                 -- 场景包编码, 如 'export_starter'
  status TEXT NOT NULL,             -- 'active' / 'expired' / 'cancelled'
  started_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  UNIQUE(tenant_id, plan_code, status)   -- 同一工位同时只有一条有效订阅
)

-- 场景包定义（哪几个工位组合成一个包）
subscription_bundles (
  id BIGSERIAL PRIMARY KEY,
  bundle_code TEXT UNIQUE NOT NULL,  -- 'export_starter' / 'export_pro' / 'full_chain'
  name TEXT NOT NULL,
  description TEXT,
  plan_codes TEXT[] NOT NULL,        -- ['customers','market','quote']
  price_cny NUMERIC,
  is_active BOOLEAN DEFAULT true
)
```

**订阅场景包示例**：

| 场景包 | 包含工位 | 目标客户 |
|--------|---------|---------|
| `export_starter` | customers + market + quote | 刚起步外贸企业 |
| `export_pro` | customers + market + quote + orders + docs | 成熟外贸企业 |
| `full_chain` | intel + customers + market + quote + orders + docs | 全链路数字化 |

**订阅生效控制三层防线**：

```
① API 层：中间件检查 subscription，未订阅 → 404（不是 403，不暴露存在性）
② 前端层：侧边栏只渲染已订阅工位入口，路由未订阅 → 重定向到订阅页
③ 数据层：跨工位写入前检查订阅，未订阅工位不产生任何写入
```

**订阅状态判定规则**：

| 场景 | 判定 |
|------|------|
| 单工位订阅 | `subscriptions.plan_code = X AND status = 'active'` |
| 场景包订阅 | `subscription_bundles.plan_codes @> ARRAY[X] AND 对应 subscription.status = 'active'` |
| 企业版 | 所有工位默认生效，跳过单工位检查 |

**降级行为（关键体验约束）**：

| 未订阅工位被触发 | 行为 |
|----------------|------|
| 前端路由访问 | 显示"该工位未订阅"引导页，提供订阅入口 |
| API 直接调用 | 返回 `{"error": "workstation_not_subscribed", "plan_code": "X"}`，HTTP 404 |
| 下游工位依赖未订阅上游 | 显示降级提示，不阻断当前工位已订阅功能 |

**新增工位接入订阅的检查清单**：

- [ ] `subscription_bundles.plan_codes` 数组加入新工位编码
- [ ] 该工位所有 API 路由加订阅中间件
- [ ] 前端侧边栏入口加订阅条件渲染
- [ ] 跨工位写入点加订阅检查（防绕过）
- [ ] 未订阅时前端展示引导页而非空白

---

## 6. 各工位 Schema 概要

### 6.1 智能报价工位 `quote_orders`（预留口子 + 报价引擎 V2 规划）

承载从商情雷达信号 / 询盘意向 → 结构化报价单的全链路。当前已建表，业务逻辑按下方报价引擎设计填充。

**核心表**：
- `quote_orders` — 报价单头（客户、币种、有效期、状态机）
- `quote_order_items` — 报价单行项（SKU 引用、数量、单价、行金额）
- `quote_freight_charges` — 运费记录（海运费、本地费、币种、供应商）
- `quote_raw_material_refs` — 原材料参考价历史（来源：manual / auto / historical）
- 关联：`quote_order_shipment_refs`（上游=商情雷达货运记录）

**报价引擎 V2 核心逻辑**：

```
选择产品 + 输入规格
        │
        ▼ ① 自动计算体积和重量
   ┌─────────────────────────────────────┐
   │ 体积 = 数量 × 单件体积（或包装尺寸推算）│
   │ 重量 = 数量 × 单件重量（SKU 命中则回填）│
   └─────────────────────────────────────┘
        │
        ▼ ② 原材料成本（三选一，用户主动选择）
   ┌────────────────────────────────────────────────────┐
   │ A. 手动输入成本价                                   │
   │ B. 不输入（跳过成本计算，仅按历史价/SKU价）          │
   │ C. 应用系统参考价（系统计算，展示但需用户确认后才用）│
   └────────────────────────────────────────────────────┘
        │
        ▼ ③ 成本加成报价
   报价 = (原材料成本 + 额外加工费) × (1 + 税率) × (1 + 利润率)
        │
        ▼ ④ 国际贸易条款价（用户选择条款 + 录入/读取运费）
   ┌─────────────────────────────────────────────────────┐
   │ EXW  = 出厂价（不含运费）                            │
   │ FOB  = EXW + 本地费（内陆运费 + 港杂费 + 报关费）    │
   │ CFR  = FOB + 海运费                                 │
   │ CIF  = CFR + 保险费                                 │
   └─────────────────────────────────────────────────────┘
        │
        ▼ ⑤ 输出三档报价方案（已有 V2 逻辑）
   逼单方案(low) / 让利方案(standard) / 优选方案(high)
```

**原材料参考价计算规则**：

| 来源 | 规则 | 可信度权重 |
|------|------|-----------|
| 用户手动输入 | 直接采用 | 最高（显式指定） |
| 系统历史均值 | 近 N 次报价中实际采用成本的加权均值（时间越近权重越高） | 高 |
| SKU 关联参考价 | 该 SKU 最近一次成功报价的原材料成本 | 中 |
| 无历史 | 提示用户手动输入，不自动填充 | — |

**关键设计约束**：
- 系统**永不自动应用**参考价——必须用户主动选择"应用参考价"才生效
- 参考价**只作建议展示**，与应用值分开存储（`suggested_cost` vs `applied_cost`）
- 对外展示不得暴露成本利润率（已有铁律）

**运费数据来源**：
- 手动输入（货代报价单拍照/邮件）
- 市场对照工位港口情报推荐（Phase 6）
- 历史运费均值（同港口 + 同货类）

### 6.2 订单工位 `orders`（预留口子）
承接客户成交 → 履约订单。当前仅建表。

核心表：
- `orders` — 销售订单头（客户、币种、总金额、履约状态）
- `order_items` — 订单行项（SKU、数量、单价）
- 关联：`order_quote_refs`（上游=报价单）、`order_customer_refs`（上游=客户工位成交询盘）、`order_shipment_refs`（物流=商情雷达货运）

### 6.3 外贸单证工位 `trade_docs`（预留口子）
**全周期横向工位**：基于询盘 / 报价单 / 订单任一上游实体生成外贸全套单证。
当前仅建表。

核心表：
- `trade_docs` — 单证主表（类型、编号、签发信息、金额）
- `trade_doc_items` — 单证行项（品名、数量、包装）
- `trade_doc_order_refs`（上游=订单，履约/出运阶段）
- `trade_doc_quote_refs`（上游=报价单，报价/订单阶段）
- `trade_doc_inquiry_refs`（上游=询盘，询盘/报价阶段）

三张 refs 表同一模式：`ref_type` 为开放字符串（默认 `generated_from`），
复合唯一键 `UNIQUE(tenant_id, trade_doc_id, ref_type, {上游}_id)` 保证幂等。

**单证类型 × 生成阶段**：

| 业务阶段 | 单证类型 | 生成来源 |
|---------|---------|---------|
| 询盘/报价 | Quotation、PI（形式发票） | inquiry / quote_order |
| 订单 | 销售合同、PI | quote_order / order |
| 履约/出运 | PI、CI、PL、B/L、CO、保险单 | order |

### 6.4 客户管理工位 `customers`（规划中，统一底座）

承载客户全生命周期：从询盘录入 → 客户建档 → 阶段跟踪 → 成交转化。

核心表（规划）：
- `customers` — 客户主档（公司名、联系人、国家、地址、默认港口、信用等级）
- `customer_contacts` — 联系人多条（姓名、职位、电话、email、whatsapp、微信）
- `customer_inquiries` — **询盘记录**（从询盘入口直接录入，自动关联客户）
  - 询盘渠道（email/whatsapp/阿里/展会/其他）
  - 意向产品（品类 + 品名原文 + 数量 + 用途）
  - 询盘状态：`询盘中 / 已报价 / 已成交 / 已流失`
  - 成交后自动生成 `orders` 记录，客户阶段同步变更
- `customer_stage_log` — 阶段变更历史（何时从询盘→成交）

**询盘入口流程**：
```
收到询盘（邮件/WhatsApp/阿里/展会）
        │
        ▼ 录入询盘信息
客户是否存在？── 否 ──► 自动新建客户档案 + 首条询盘记录
        │
        是 ──► 关联已有客户，新增询盘记录
        │
        ▼ 匹配市场对照工位
   建议规格 / 品名对照 / 最近港口
        │
        ▼ 业务员跟进，更新询盘状态
   询盘中 → 已报价 → 已成交 / 已流失
        │
        ▼ 状态 = 已成交
   自动生成订单（转入订单工位）
   客户阶段 = 已成交
```

### 6.5 产品市场对照工位 `market`（规划中）

回答"什么地区卖什么产品、常用什么规格、当地人管这个产品叫什么"。支持按**地区**、**产品名（中英文/各语种）**、**用途**查询。

核心表（规划）：
- `market_region_products` — 地区×产品对照（需求等级、认证要求、执行标准、季节规律）
- `market_region_product_specs` — 常见规格参数对照（spec_key/spec_value/unit + 频率排序 + SKU 挂接）
- `market_product_name_mappings` — 中外品名对照（region + lang → 当地品名、别名 JSONB、HS 编码、是否核实）
- `market_product_usages` — 用途分类（fence / construction / agriculture / security…，与品名映射关联）
- `market_ports` — 港口情报库（**静态主档 + 动态运营数据两层**）

| 层 | 字段 | 说明 |
|----|------|------|
| **静态主档**<br>（地理位置、物理条件，确认后基本不变） | `name_cn` / `name_en` / `un_locode` | 港口中英文名 + UN/LOCODE 标准编码 |
| | `country_code` / `city` | 所属国家/城市 |
| | `lat` / `lng` | 经纬度（距离计算基础） |
| | `port_type` | 海港 / 河港 / 内陆港 / 空港 |
| | `position_desc` | 港口定位（如"美西门户""北欧枢纽""中东转口中心"） |
| | `characteristics` | 特点（天然深水良港/人工港、可泊船型、锚地条件） |
| | `berth_depth_m` / `max_vessel_size` | 泊位水深、可接纳最大船型 |
| | `suitable_cargo` | 适用货类（集装箱/散杂货/液体散货/冷链…） |
| | `suitable_shipping_modes` | 适合发货方式（整箱FCL/拼箱LCL/散货Bulk/滚装RoRo/空运/海铁联运…） |
| | `connected_corridors` | 经济腹地/主要集疏运通道 |
| **动态运营数据**<br>（随市场变化，需定期更新） | `throughput_rank` / `congestion_level` | 吞吐量排名、拥堵程度 |
| | `major_carriers` | 主要挂靠船司 |
| | `avg_dwell_days` / `port_charges_level` | 平均滞港天数、港杂费水平 |
| | `last_verified_at` / `source` | 数据核实时间与来源 |

  地址→最近港口匹配：按经纬度球面距离排序 + `port_type`/`suitable_cargo` 过滤（如大件货排除空港），输出 Top 3 候选供业务选择。
  静态主档一次整理长期使用；动态运营数据标注 `last_verified_at`，超期提醒重新核实。

数据填充路线：手工录入 → 商情雷达品名词频沉淀（`source=intel_signal`）→ AI 批量提取（Phase 7）。

### 6.6 与现有模型的关系
- 三个工位均通过 `customer_id` 关联到现有 `customers` 表（只读引用）
- 行项均通过 `sku_id` 关联到现有 `product_skus` 表（只读引用）
- 商情雷达 `intel_shipments` 作为订单/报价的**信号源**被引用，本身不变

---

## 7. 技术实现约束

| 层 | 约束 |
|----|------|
| **数据库** | PostgreSQL (Neon)，迁移用 alembic，表前缀 `{domain}_*` |
| **后端** | Cloudflare Workers (Python + FastAPI)，经 Hyperdrive 连接 PG；每请求 asyncpg 连接 |
| **前端** | Next.js 静态导出 → Cloudflare Workers Static Assets；新增工位页面挂在 `/{domain}` |
| **多租户** | 所有表带 `tenant_id`，查询强制按租户过滤 |
| **幂等** | 业务编码 (`order_no` 等) 全局唯一；关联表用复合唯一键 |
| **事件**（预留） | 未来引入 `domain_events` 表实现异步事件流，当前用同步关联表 |

---

## 8. 业务流程规划（后续细化）

以下为**方向性**业务流程，具体状态机、审批流、异常处理在工位开发时细化：

### 8.1 询盘录入 → 成交 → 订单/票据（核心链路）

```
收到询盘（邮件/WhatsApp/阿里/展会/其他渠道）
        │
        ▼ 录入询盘信息
客户管理工位
  ├─ 客户不存在 → 自动建档 + 首条询盘记录
  ├─ 客户已存在 → 关联客户，新增询盘记录
  │
  ▼ 匹配市场对照工位
┌──────────────────────────────────────┐
│ ① 地址 → market_ports 最近港口        │
│ ② 产品+地区 → 常见规格/品名对照       │
│ ③ 用途 → 适用产品类别                 │
└──────────────────────────────────────┘
  │
  ▼ 业务员跟进，更新询盘状态
询盘中 → 已报价（→ 智能报价工位生成报价单）
      → 已成交 ──► 自动生成订单（转入订单工位）
      → 已流失
  │
  ▼ 订单工位履约
发货 → 外贸单证工位自动生成 PI/CI/PL/B/L
```

各工位可**拆分开单独使用**（独立价值），组合后形成完整业务闭环。

### 8.2 商情雷达 → 报价工位
1. 商情雷达采集货运记录 / 买家询盘信号
2. 业务员在报价工位选取信号（引用 `intel_shipments`），触发报价单草稿
3. 报价工位结合 `product_skus` 定价，生成 `quote_orders` + `quote_order_items`
4. 写入 `quote_order_shipment_refs`，建立信号溯源
5. 报价单发送买家 → 确认/拒绝/过期

### 8.3 报价工位 → 订单工位
1. 买家确认报价单（状态 = accepted）
2. 业务员一键转化报价单 → 销售订单
3. 写入 `order_quote_refs`，复制行项到 `order_items`
4. 订单工位跟踪履约、收款、出运

### 8.4 外贸单证工位（全周期触发，非仅订单下游）
单证工位在**每个业务阶段**都可被触发，不是订单工位的专属下游：

1. **询盘/报价阶段**：业务员基于询盘或报价单一键生成 Quotation / PI（形式发票），
   供买家确认与付款安排
2. **订单阶段**：报价单转订单后，可生成销售合同 / PI
3. **履约/出运阶段**：根据订单行项生成 PI / CI / PL / B/L / CO / 保险单
4. 每次生成写入对应 `trade_doc_*_refs` 关联表，记录单证来源实体（询盘/报价/订单）
5. 单证可下载/发送/归档，模板按类型管理

### 8.5 订单工位 → 商情雷达（回写）
1. 订单实际出运后，业务员录入出运信息
2. 写入 `intel_shipments`（商情雷达作为下游接收）
3. 写入 `order_shipment_refs`，完成物流闭环

---

## 9. 演进路线

| 阶段 | 内容 | 出口标准 |
|------|------|---------|
| **Phase 1** ✅ | 商情雷达上线 | 已交付（见 DEPLOY.md） |
| **Phase 2** ✅ | 三工位 Schema 口子 | 本迁移 `20260919_workstation_links` |
| **Phase 3** | 报价工位 MVP | 报价单 CRUD + 信号引用 + 前端页面 |
| **Phase 4** | 订单工位 MVP | 报价转化 + 订单履约 + 前端页面 |
| **Phase 5** | 单证工位 MVP | 单证生成 + 下载 + 前端页面 |
| **Phase 6** | 事件流联通 | 引入 `domain_events`，实现异步联动 |
| **Phase 7** | 智能闭环 | AI 驱动的报价推荐、风险预警、自动单证 |

---

## 10. 通用业务设计

> 本章定义跨工位共享的业务规则与数据模型，是所有工位开发的**前置约定**。
> 先于任何工位 MVP 落地（见 §12 Phase 2.5）。

### 10.1 状态机定义

| 实体 | 状态字段 | 合法值与流转 | 驱动关系 |
|------|---------|-------------|---------|
| 询盘 `cust_inquiries` | `status` | `open` → `quoted` → `won` / `lost`；`open` 可直转 `won`/`lost` | **驱动方** |
| 客户 `cust_customers` | `stage` | `lead` → `inquiry` → `quoted` → `negotiating` → `won` / `lost` / `inactive` | **被询盘驱动** |
| 报价单 `quote_orders` | `status` | `draft` → `sent` → `accepted` / `rejected` / `expired` | 独立 |
| 订单 `orders` | `status` | `pending` → `confirmed` → `producing` → `shipped` → `completed` / `cancelled` | 独立 |
| 出运 `shipments` | `status` | `booking` → `in_transit` → `arrived` → `customs` → `delivered` | 独立 |

**询盘 ↔ 客户 联动规则（询盘驱动客户）**：

- 询盘 `open → won`：弹**二次确认**，确认后询盘置 `won`，**客户 stage 自动置 `won`**
- 询盘 `open → lost`：仅关闭该询盘，**客户 stage 不变**（避免误伤其它在谈询盘）
- 客户在客户页手动改 `won` / `lost`：弹出名下所有 `status='open'` 的询盘列表，
  勾选或「全部一并关闭」，**二次确认**后批量执行（询盘与客户 stage 同步变更）
- 联动动作写入 `cust_stage_log`，`reason` 记录来源（如 `inquiry#123 won 联动`）

**询盘列表规则**：按客户归类，列表内时间倒序；顶部可按 `status` 筛选；
客户卡片聚合状态规则：**只要名下有一条 `status='open'` 询盘，即显示「开启」**，
否则显示最近一条询盘的终态（won/lost）。

### 10.2 货币与汇率

**汇率表 `fx_rates`**：

```sql
fx_rates (
  id BIGSERIAL PRIMARY KEY,
  base_currency   TEXT NOT NULL,      -- 基准币，如 'CNY'
  quote_currency  TEXT NOT NULL,      -- 目标币，如 'USD'
  rate            NUMERIC(20,8) NOT NULL,  -- 1 base = rate quote
  rate_date       DATE NOT NULL,      -- 交易日
  source          TEXT,               -- 数据来源
  is_stale        BOOLEAN DEFAULT false,  -- 抓取失败沿用昨日时标记
  fetched_at      TIMESTAMPTZ,
  UNIQUE(base_currency, quote_currency, rate_date)
)
```

**抓取策略**：每日定时（如 08:00）从免费源（exchangerate.host / frankfurter.app）
拉 USD/CNY/EUR 等主要币种，按天落库；源失败沿用昨日数据并标 `is_stale=true`。

**多币种记账口径（报价/订单各自锁定汇率）**：

| 环节 | 币种 | 汇率处理 |
|------|------|---------|
| 报价单 | `currency`（原币） | 记录报价生成时 `fx_rate` / `fx_rate_date` 快照 |
| 订单 | `currency`（原币） | 订单确认时重新锁定 `fx_rate` / `fx_rate_date`（不用报价时旧汇率） |
| 应收台账 | 原币 + 本币双记 | `receivables` 记原币应收 + 按订单锁定汇率折算本币应收 |
| 实际收款 | 原币 | 收款时记实际收汇汇率，与本币应收差额 → `exchange_gain_loss`（汇兑损益） |

**外币应收本币折算**：老外欠 $10,000（订单原币），账上要知折本币多少。
口径先定「**下单时锁定汇率折算，收款时差额记汇兑损益**」，逻辑后续可再调。
KaaS 只记录应收/已收/汇兑差额，**不做收付款执行**（见 §10.4）。

### 10.3 数据可见范围（Owner Scope）

**模型**：每张业务表加 `owner_scope` 与 `owner_id`：

```sql
owner_id     TEXT NOT NULL,                    -- 创建/负责账号
owner_scope  TEXT NOT NULL DEFAULT 'private'   -- 'private' | 'tenant'
```

**可见范围规则**：

| 角色 | 可见数据 |
|------|---------|
| 普通成员 | ① 自己账号（`owner_id = 我`）的数据<br>② 全体成员标记 `owner_scope='tenant'` 的**基础数据**（共享只读） |
| 企业管理员 | 本小组/企业内**全部成员**的数据（管理范围按 `member.group_id` 界定） |
| 平台 admin | 全部 |

**写规则**：成员只能改 `owner_id=自己` 的数据；改数据时可选择本次保存为
`private`（仅自己）或 `tenant`（开放全员）。企业管理员可改组内任意成员数据，
并可将成员数据提升为 tenant 基础数据。

**角色规划（Phase 6 实现）**：新增 `enterprise_admin` 角色，可管理小组/企业内
成员的增删改查（建组、拉人、移出、设小组管理员），实现局域内顺滑协作。
Phase 3-5 先用 `member / admin` 两档，scope 字段先落库。

### 10.4 枚举字典

所有状态/类型字段的**合法值清单**（前后端共用一份常量，见 §11）：

| 类别 | 合法值 |
|------|--------|
| 询盘 status | `open` `quoted` `won` `lost` |
| 客户 stage | `lead` `inquiry` `quoted` `negotiating` `won` `lost` `inactive` |
| 报价单 status | `draft` `sent` `accepted` `rejected` `expired` |
| 订单 status | `pending` `confirmed` `producing` `shipped` `completed` `cancelled` |
| 出运 status | `booking` `in_transit` `arrived` `customs` `delivered` |
| 询盘渠道 channel | `email` `whatsapp` `alibaba` `expo` `website` `other` |
| 单证类型 doc_type | `quotation` `pi` `contract` `ci` `pl` `bl` `co` `insurance` `other` |
| 币种 currency | `USD` `CNY` `EUR` `GBP` `JPY` …（以 fx_rates 实际支持为准） |
| 可见范围 owner_scope | `private` `tenant` |

约定：数据库存开放字符串，但**写入前必须校验合法值**（后端统一校验函数，
前端用同一份常量做下拉/标签）。

### 10.5 付款计划（只记阶段，不做收付款执行）

新增 `payment_schedules` 表，挂订单或单证：

```sql
payment_schedules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  order_id       BIGINT,            -- 关联订单
  trade_doc_id   BIGINT,            -- 关联单证（PI）
  schedule_type  TEXT NOT NULL,     -- 'deposit' 定金 | 'balance' 尾款 | 'full' 全款
  ratio          NUMERIC(5,4),      -- 比例（如 0.3 = 30%）
  amount         NUMERIC(14,2),     -- 固定金额（与 ratio 二选一）
  currency       TEXT NOT NULL DEFAULT 'USD',
  due_date       DATE,              -- 预计收款日
  actual_date    DATE,              -- 实际收款日（可空）
  status         TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'paid' | 'overdue'
  fx_rate        NUMERIC(20,8),     -- 实际收汇汇率（收款时填）
  exchange_gain_loss NUMERIC(14,2), -- 汇兑损益（收款时按 §10.2 口径计算）
  notes          TEXT,
  created_at / updated_at TIMESTAMPTZ,
  owner_id / owner_scope
)
```

KaaS 职责边界：**只记录「该收哪几笔、计划何时、实际收没、汇率差额」**，
不负责发起/执行收款（对接支付渠道是后续独立工作）。

### 10.6 自有出运台账（shipments）

> 区别于 `intel_shipments`（海关情报，外部数据）。`shipments` 记**我们自己的出运**，
> 目标是**查数据能清晰还原客户当时的具体情况**——所以关键字段做**快照**，
> 不依赖关联表反查（关联变了历史也能还原）。

```sql
shipments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  shipment_no      TEXT NOT NULL UNIQUE,   -- 出运单号
  order_id         BIGINT,                 -- 关联订单
  customer_id      BIGINT,                 -- 关联客户（快照来源）
  -- 客户当时快照（冗余，防关联变更导致历史失真）
  customer_name    TEXT,                   -- 客户公司名（下单时）
  consignee        TEXT,                   -- 收货人（提单收货方）
  notify_party     TEXT,                   -- 通知方
  -- 货物当时快照（从订单行项复制）
  cargo_desc       TEXT,                   -- 货物描述汇总
  cargo_qty        NUMERIC,                -- 总数量
  cargo_qty_unit   TEXT,
  cargo_weight_kg  NUMERIC,                -- 总毛重
  cargo_volume_cbm NUMERIC,                -- 总体积
  -- 物流信息
  pol              TEXT,                   -- 起运港（关联 market_ports.un_locode）
  pod              TEXT,                   -- 目的港
  pol_name         TEXT,                   -- 港口名快照
  pod_name         TEXT,
  vessel           TEXT,                   -- 船名
  voyage           TEXT,                   -- 航次
  container_no     TEXT,                   -- 柜号
  so_no            TEXT,                   -- S/O 号
  booking_no       TEXT,                   -- 订舱号
  bl_no            TEXT,                   -- 提单号
  bl_type          TEXT,                   -- 'original' 正本 | 'telex' 电放 | 'seaway' 海运单
  etd              DATE,                   -- 预计开船
  eta              DATE,                   -- 预计到港
  atd              DATE,                   -- 实际开船
  ata              DATE,                   -- 实际到港
  status           TEXT DEFAULT 'booking', -- §10.4 出运状态
  freight_remark   TEXT,                   -- 运费/物流备注
  created_at / updated_at TIMESTAMPTZ,
  owner_id / owner_scope
)
```

**出运后回写**：`order_shipment_refs`（已有口子）建立订单↔出运关联；
`orders.status` 由 `producing` → `shipped`。

**简化原则**：不设计转运路由/拼箱拆分/多式联运，单一提单一条记录，够查即可。

### 10.7 单据号序列

**设计**：`doc_sequences` 计数表 + 单事务取号，并发安全。

```sql
doc_sequences (
  tenant_id  TEXT NOT NULL,
  doc_type   TEXT NOT NULL,        -- 'pi' | 'ci' | 'quote' | 'order' | 'shipment' ...
  period     TEXT NOT NULL,        -- '202609'（按月分段，避免单表热点）
  last_seq   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, doc_type, period)
)
```

取号逻辑（单事务）：
```sql
UPDATE doc_sequences SET last_seq = last_seq + 1
WHERE tenant_id=$1 AND doc_type=$2 AND period=$3
RETURNING last_seq;
-- 无行则 INSERT ... ON CONFLICT 初始化后重取
```

**编号格式**：`{TYPE}-{YYYYMM}-{SEQ:04d}`，如 `PI-202609-0001`、`QUO-202609-0123`。
`doc_no` / `quote_no` / `order_no` / `shipment_no` 均走此序列，全局唯一幂等。

### 10.8 单位体系

**单位选择框 + 受控列表**（回应「不同产品/报价单位不同」）：

| 层 | 设计 |
|----|------|
| **单位字典** | `units` 表：`code`（`sqm`/`roll`/`ton`/`kg`/`m`/`pcs`…）、`name_cn`、`name_en`、`category`（area/length/weight/count/volume） |
| **品类合法单位** | `product_categories` 加 `allowed_units TEXT[]`，定义该品类可报价的单位（丝网：`sqm,roll,ton,kg,m`） |
| **SKU 基准单位** | `product_skus.base_unit` + `unit_conversions` 换算表（`sku_id`/`from_unit`/`to_unit`/`factor`，如 1 roll = 50 sqm） |
| **报价录入** | 前端单位下拉只出该品类 `allowed_units`；无匹配可选 `custom`（自由文本，标记非标准） |
| **报价引擎** | 统一换算到 SKU 基准单位后算体积/重量/运费，再按客户所选单位输出 |

### 10.9 地址→港口匹配（分层兜底）

| 优先级 | 策略 | 准确度 |
|--------|------|--------|
| 1 | 客户档案**手选默认港口**（`default_port` 已有字段） | 最准，人工确认 |
| 2 | 录入时按**国家**从 `market_ports` 出该国主要港口列表，业务员挑 | 高 |
| 3 | 有详细地址无坐标时，按国家推荐 **Top3 最近候选**（按港口 lat/lng 与国家中心距排序），业务员确认 | 中 |
| 4 | 接 **geocoding API**（Google/高德）自动解析地址→坐标→最近港口 | 高（后续接入，先留接口不阻塞） |

### 10.10 订阅到期数据治理 + API 规范

**订阅到期数据策略**：

| 时机 | 行为 |
|------|------|
| 订阅到期当天 | 工位入口 404，前端引导续订；**数据保留 90 天宽限期**（可查可导出） |
| 90 天后 | 数据标记 `archived` 只读，不可再写入 |
| admin 决定 | 可导出后清理，或续订恢复 |

**统一 API 规范**：

- 路径：`/api/v1/{domain}/*`
- 分页：统一 `{items, total, page, page_size}`
- 错误：统一 `{error, code, detail}`
- 鉴权：JWT + `tenant_id` 强制过滤；admin 路由加 `adminOnly` 中间件
- 校验：写接口统一校验**枚举合法值**（§10.4）+ **owner_scope 可见范围**（§10.3）
- 审计：写接口记录 `created_by`/`updated_by`

---

## 11. 不变量 (Invariants)

> 新增工位时必须遵守，违反视为架构回归。

1. **表前缀**：`{domain}_*`，禁止无前缀表
2. **租户隔离**：所有表必含 `tenant_id`，查询必带租户过滤
3. **跨工位只读**：下游可读上游表，禁止跨工位写
4. **关联表幂等**：所有 `*_refs` 表必含 `UNIQUE(tenant_id, ...)`
5. **业务编码唯一**：`order_no` / `quote_no` / `doc_no` / `shipment_no` 等全局唯一，作为幂等键（走 §10.7 序列）
6. **迁移单向**：生产库迁移只增不改历史表结构（允许新增列，禁止重命名/删除已有列）
7. **独立部署**：任何工位可单独部署/回滚，不影响其它工位
8. **订阅可见性**：未订阅工位的 API 返回 404（不暴露存在性），前端显示引导页
9. **订阅隔离**：未订阅工位的代码不执行、数据不写入、入口不渲染
10. **订阅防绕过**：跨工位写入前必须检查目标工位订阅状态
11. **状态机合法值**：所有状态/类型字段只能取 §10.4 枚举值，写入前必校验
12. **可见范围过滤**：查询必带 `owner_id/owner_scope` 过滤（按 §10.3 角色规则）
13. **汇率快照**：涉及金额的实体必锁 `fx_rate/fx_rate_date`，禁止实时汇率回溯历史

---

## 12. 演进路线

| 阶段 | 内容 | 出口标准 |
|------|------|---------|
| **Phase 1** ✅ | 商情雷达上线 | 已交付（见 DEPLOY.md） |
| **Phase 2** ✅ | 三工位 Schema 口子 | 迁移 `20260919_workstation_links` + `20260921_trade_doc_upstream_refs` |
| **Phase 2.5** | 基础设计落地 | 建 `fx_rates`/`doc_sequences`/`shipments`/`payment_schedules`/`units`/`unit_conversions` 表 + `owner_id/owner_scope` 字段补齐 + 枚举常量双端落地 |
| **Phase 3** | 报价工位 MVP | 报价单 CRUD + 信号引用 + 前端页面 |
| **Phase 4** | 订单工位 MVP | 报价转化 + 订单履约 + 前端页面 |
| **Phase 5** | 单证工位 MVP | 单证生成 + 下载 + 前端页面 |
| **Phase 6** | 事件流联通 + 企业管理员角色 | 引入 `domain_events`；`enterprise_admin` 管理组内成员 CRUD |
| **Phase 7** | 智能闭环 | AI 驱动的报价推荐、风险预警、自动单证 |

---

## 13. 相关文档

- `DEPLOY.md` — 部署架构与操作手册
- `backend/worker/README.md` — 商情雷达 Worker 详情
- `backend/docs/schema-registry.md` — 数据字典
- `shared/contracts/` — 前后端共享契约（zod）

---

**最后更新**: 2026-09-19
**维护者**: David Sun
