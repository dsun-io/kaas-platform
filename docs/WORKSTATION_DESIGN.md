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

### 2.0 命名口径（2026-09-22 变更）

| 原名称 | 最终名称 | 性质 |
|--------|---------|------|
| 商情雷达 | **进出口情报** | 改名，不重建 |
| 客户开发 | **地图源客户信息获取** | 改名 |
| （无） | **市场调研** | 新建 |

> 所有文档、代码、界面、订阅编码统一使用最终名称。
> URL / API 前缀 / 表名不变（`/intel`、`/leadgen`、`intel_*`、`lead_candidates`），
> 改名只影响展示层命名，避免破坏性迁移。

### 2.0.1 情报体系（三工位）

情报体系由三个工位组成，层次为「宏观 → 微观 → 源头」：

```
情报体系
├── 进出口情报             （宏观）海关/贸易数据、货运记录、竞争格局
├── 市场调研               （微观）从地图源挑选数据并深化：规格/价格/能否提供
└── 地图源客户信息获取     （源头）Google Places 抓取店铺 + 爬官网提取产品
```

**地图源客户信息获取是双重身份**：属于情报体系，同时是主业务链起点。
前端菜单归入「情报体系」，产出（线索池）被业务链消费。

### 2.0.2 分工原则：脚本为主，AI 为辅

两个数据加工工位共用同一条原则 —— **能算的用脚本，难量化的才用 AI**：

| 环节 | 手段 | 理由 |
|------|------|------|
| 店铺信息（名称/地址/电话/评分/类型/link） | Google Places API | 权威、结构化 |
| 产品信息（图片/当地叫法/规格） | **爬官网 + 正则提取** | Google Places 看不到产品 |
| 规格结构化（尺寸/材质） | **脚本正则**（`_template_spec_extract`） | 确定性、可复现、零成本 |
| 中文对照（当地叫法→中文） | AI 翻译（`product_translate`） | 难量化，AI 未启用则留空待人工填写 |
| 能否提供 | **用户手动判定** | 商业判断，禁止 AI 推断 |
| 产品品类归类 | 用户选择 | 枚举约束，避免漂移 |

> AI 未绑定时的降级路径已定义：规格仍由脚本产出，中文对照留空，
> 系统不阻塞、不臆测、不写错数据。

### 2.1 已交付

| 工作站 | 域 | 状态 | 说明 |
|--------|----|------|------|
| **进出口情报** (原 Intel Radar) | 贸易情报 | ✅ 已上线 | 海关/贸易数据采集、货运记录、竞争分析。发现「谁 在什么地区 买什么货」 |
| **地图源客户信息获取** (原 客户开发) | 线索获取 | ✅ 已上线 | Google Places 抓取店铺 → 线路池；官网爬取补产品信息 |
| **线索池** | 线索共享 | ✅ 已上线 | `lead_candidates` 共享池，三工位唯一通信接口 |
| **客户管理 / 询盘** (customers) | 客户全生命周期 | ✅ 已上线 | 询盘录入→建档→阶段跟踪→成交→自动生成订单 |
| **智能报价工位** (quote_orders) | 智能报价 | ✅ 已上线 | 三档方案 + FOB/CFR/CIF，锁汇率快照 |
| **订单工位** (orders) | 订单履约 | ✅ 已上线 | 报价转化、履约状态机、应收与汇兑损益 |
| **外贸票据工位** (trade_docs) | 单证票据 | ✅ 已上线 | 从订单/报价/询盘生成 PI/CI/PL 等 |
| **客户触达工位** (outreach) | 邮件触达 | ✅ 已上线 | 发件邮箱/活动/消息、回写 `outreach_status` |
| **AI 层** | AI 能力托管 | ✅ 已上线 | 5+ 任务注册表、Provider 绑定、互备降级、用量落库 |
| **市场调研** (research) | 微观市场数据 | ✅ 已上线 | 从地图源挑选 → 深化（品类/价格/观察/能否提供） |

### 2.2 规划中（按优先级）

| 工作站 | 域 | 优先级 | 与现有数据链的关系 |
|--------|----|--------|-------------------|
| **产品市场对照** (market) | 地区×产品×规格知识 | P1 | 支撑报价工位：地区/品名/用途→规格/港口 |
| **事件流联通** | 异步联动 | P2 | 引入 `domain_events`，替代手动触发扫描 |

> 优先级不代表开发顺序，实际排期由业务驱动。各工位可**独立先行**开发，
> 只要遵循 §5 的数据连通契约即可保证后续无缝集成。

---

## 3. 核心设计原则

### 3.1 单工位自洽 (Independent)
每个工作站拥有自己的表（`{domain}_*` 前缀）、API（`/api/v1/{domain}/*`）与前端路由（`/{domain}`）。
- 商情雷达：`intel_*` 表 + `/api/v1/intel/*` + `/intel`
- 报价工位：`quote_*` 表 + `/api/v1/quote-orders/*` + `/quote-orders`
- 订单工位：`orders_*` 表 + `/api/v1/orders/*` + `/orders`
- 票据工位：`trade_docs_*` 表 + `/api/v1/trade-docs/*` + `/trade-docs`

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
│        │ 已成交           │                      │                      │
│        ▼                  │                      │                      │
│        │                  │                      ▼                      │
│        │                  │              订单工位(orders)                │
│        │                  │              履约订单/订单项                  │
│        │                  │                      │                      │
│        │                  │                      ▼                      │
│        │                  │              外贸票据工位(trade_docs)         │
│        │                  │              规格确认单→PI/CI/PL/B/L          │
│        │                  │                                             │
│  商情雷达(intel) ──(买家信号/品名验证)──► market / inquiries              │
│   货运记录                  (下游读取，回写双向)                          │
│       │                                                                 │
│       ▼                                                                 │
│   ┌─────────────────────────────────────────┐                           │
│   │  统一底座: customers + product_skus      │                           │
│   │  (客户档案 + 产品规格, 全工位共享只读引用) │                           │
│   └─────────────────────────────────────────┘                           │
└─────────────────────────────────────────────────────────────────────────┘
```

> **端口距离查询**（属市场/询盘工位能力）：客户地址落库后，根据地址/国家自动匹配
> 最近的出口/目的港口（`market_ports` 表 + 地理距离计算），供货代询价与物流方案使用。

---

## 5. 跨工位数据连通契约

> 以下关联键在数据库迁移 `20260919_workstation_links` 中已建立，是所有工位的**接入点**。

### 5.1 关联表总览

| 关联表 | 上游 → 下游 | 语义 |
|--------|------------|------|
| `quote_order_shipment_refs` | intel → quote_orders | 报价单依据哪些货运记录生成（买家/产品信号溯源） |
| `order_quote_refs` | quote_orders → orders | 销售订单由哪些报价单转化而来 |
| `order_shipment_refs` | orders → intel | 订单关联的实际出运记录（商情雷达回写） |
| `trade_doc_order_refs` | orders → trade_docs | 票据由哪些订单生成 |
| `order_shipment_refs` | intel → orders | 订单引用货运记录作为物流依据（双向） |

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
| `full_chain` | 全工位 | 全链路数字化 |

### 5.4.1 实际落地的订阅编码（2026-09-22 口径）

> **本期不激活订阅治理**：`tenant_subscriptions` 保持 `default = full_chain`，
> 前端不暴露订阅入口。编码已在 `chain.py` `SUB_CODES` 登记，填行即生效。

| 编码 | 包含 | 工位 key |
|------|------|---------|
| `intel_trade_starter` | 进出口情报 | `intel` |
| `intel_research_starter` | 市场调研 | `research` |
| `intel_full` | 情报体系三工位 | `intel` + `research` + `leadgen` |
| `leadgen_starter` | 地图源客户信息获取 + 线索池 | `leadgen` |
| `outreach_starter` | 客户触达（含产品手册附件） | `outreach` |
| `full_chain` | 全工位 | 全部 |

**生效方式**（未订阅 → 404 `SUBSCRIPTION_REQUIRED`）：

```python
SUB_CODES = {
    "leadgen":  ["leadgen_starter", "full_chain"],
    "outreach": ["outreach_starter", "full_chain"],
    "intel":    ["intel_trade_starter", "intel_full", "full_chain"],
    "research": ["intel_research_starter", "intel_full", "full_chain"],
}
```

> 历史遗留：`leadgen_pro` / `outreach_pro` 为预留档位，保留在 `SUB_CODES` 中向后兼容。

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

### 6.3 外贸票据工位 `trade_docs`（预留口子）
基于订单生成外贸全套票据。当前仅建表。

核心表：
- `trade_docs` — 票据主表（类型、编号、签发信息、金额）
- `trade_doc_items` — 票据行项（品名、数量、包装）
- `trade_doc_order_refs`（上游=订单）

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

### 6.6 市场调研工位 `research`（已上线，2026-09-22）

> 情报体系 · 微观层。定位：**从「地图源」产出中挑选有价值的数据，再深入细化。**

**核心表**：

| 表 | 作用 | 关键字段 |
|----|------|---------|
| `research_products` | 挑选 + 深化结果 | `source_ref`（→ `lead_candidates.id`）、`product_category`、`price_local`、`market_note`、`can_supply`、`spec_normalized` |
| `research_runs` | 运行记录（幂等 + 审计） | `config` / `config_hash` UNIQUE、`leads_scanned` / `products_found` / `products_kept` |

**字段分工（与地图源的关系）**：

```
地图源 lead_candidates（信息最全的原始层）
    ├─ Google Places 采集：company_name / address / phone / website /
    │                      place_id / google_rating / shop_type
    └─ 爬官网提取：product_image_url / product_name / spec_raw / link_url
         ↓ 用户挑选（UNIQUE(tenant_id, source_ref) 防重复挑选）
市场调研 research_products（筛选 + 深化层）
    └─ 深化字段：product_category / price_local / price_currency /
                 market_note / can_supply / supply_notes / research_status
```

设计取舍：深化层**冗余**产品与店铺字段（不强制 JOIN），换取本工位可独立渲染；
`source_ref` 保留溯源能力。两条记录各存各的，互不覆盖。

**「能否提供」的归属**：由用户在**两个工位**都可编辑（地图源侧为线索级初判，
调研侧为最终结论）。数据库层 `can_supply` 三态：`TRUE` / `FALSE` / `NULL`（未填），
**不设默认值**，避免把"未填"误读为"不能提供"。

**API**：

| 端点 | 作用 |
|------|------|
| `GET /api/v1/research/products` | 列表（国家/城市/品类/能否提供/搜索 + 分页） |
| `POST /api/v1/research/products` | 手工录入，或带 `source_ref` 从线索挑选（字段自动回填） |
| `PATCH /api/v1/research/products/{id}` | 深化字段编辑 |
| `DELETE /api/v1/research/products/{id}` | 从调研集移除（不动地图源线索） |
| `POST /api/v1/research/from-leadgen` | 批量挑选（重复自动跳过） |
| `GET /api/v1/research/stats` | 按国家/品类/供给能力聚合 |
| `GET /api/v1/research/runs` | 运行记录 |
| `GET /api/v1/research/categories` | 品类枚举 |

### 6.7 官网爬取（地图源工位的产品信息通道）

**为什么必须爬官网**：Google Places 的字段全部是**店铺级**（名称/地址/电话/评分/
`primary_type`/`website`），**没有任何产品字段**。产品（图片、当地叫法、规格）
只能从官网 HTML 提取。

```
POST /api/v1/leads/{id}/crawl        单条爬取
POST /api/v1/leads/crawl-batch       批量（默认只爬 crawl_status='pending'，上限 20）
```

爬取管线（全部为**确定性脚本**，无 AI）：

```
GET website（js.fetch，浏览器 UA）
   ↓
去 <script>/<style> → 正则提取
   ├─ <meta property="og:image">       → product_image_url
   ├─ <h1> / <title>                   → product_name
   ├─ <meta name="description"> + 正文  → spec_raw（截断 1200 字符）
   └─ href 命中 /product|/catalog|…    → link_url
   ↓
规格结构化（脚本正则：尺寸/材质）
   ↓
crawl_status ← success | failed | no_website
```

**手动触发，不自动爬**：避免对目标站高频请求被封禁。

**CSV 导入**：地图源工位支持一次性导入完整业务表格（产品图片 URL、中文对照、
规格、国家、城市、店铺、店铺类型、电话、链接、官网、地址、能否提供），
无需逐条爬取。`能否提供` 列解析 `TRUE/FALSE/是/否/1/0`，**未知值一律落 NULL**。

### 6.8 情报体系数据回流闭环（第一版不接，接口预留）

```
地图源客户信息获取 ──→ 已抓取数 ──┐
市场调研           ──→ 已调研数 ──┤
客户触达           ──→ 已触达数 ──┼──→ 进出口情报计算空白指数
询盘               ──→ 已成交数 ──┘         ↓
                                    地图源工位消费（地区排序）
```

```
已开发量 = 已抓取数 + 已调研数 + 已触达数 + 已成交数
空白指数 = 需求量（进出口情报自有） − 已开发量
```

| 数据 | 来源工位 | 现有落点 |
|------|---------|---------|
| 需求量 | 进出口情报 | `intel_demand_index.demand_index` |
| 已抓取数 | 地图源客户信息获取 | `COUNT(lead_candidates)` |
| 已调研数 | 市场调研 | `COUNT(research_products)` |
| 已触达数 | 客户触达 | `COUNT(outreach_messages WHERE status='sent')` |
| 已成交数 | 询盘 | `COUNT(cust_inquiries WHERE status='won')` |

**当前状态**：四源的计数端点尚未实现；`intel_demand_index` 为空表（口子已建），
`/leads` 排序接口恒定返回 `demand_index=null` / `blank_index=null` 占位。
填数据即生效，无需改接口。

### 6.9 与现有模型的关系
- 工位通过 `customer_id` 关联到现有 `customers` 表（只读引用）
- 行项均通过 `sku_id` 关联到现有 `product_skus` 表（只读引用）
- 进出口情报 `intel_shipments` 作为订单/报价的**信号源**被引用，本身不变
- `research_products.source_ref` → `lead_candidates.id`：调研引用地图源，单向只读

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
发货 → 外贸票据工位自动生成 PI/CI/PL/B/L
```

各工位可**拆分开单独使用**（独立价值），组合后形成完整业务闭环。

### 8.2 进出口情报 → 报价工位
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

### 8.4 订单工位 → 外贸票据工位
1. 订单进入履约阶段，触发票据生成
2. 根据订单行项生成 PI / CI / PL / B/L 等票据
3. 写入 `trade_doc_order_refs`，记录票据来源
4. 票据可下载/发送/归档

### 8.5 订单工位 → 进出口情报（回写）
1. 订单实际出运后，业务员录入出运信息
2. 写入 `intel_shipments`（商情雷达作为下游接收）
3. 写入 `order_shipment_refs`，完成物流闭环

---

## 9. 演进路线

### 9.1 工位链开发顺序（2026-09-22 变更档口径）

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P1** | AI 层 | ✅ 已上线 |
| **P2** | 地图源客户信息获取工位（原「客户开发」改名） | ✅ 已上线 |
| **P3** | 线索池 | ✅ 已上线 |
| **P4** | 客户触达工位（含产品手册附件 ⏳） | ✅ 工位上线；附件待 P6 数据成熟 |
| **P5** | 询盘接入 | ✅ 已上线 |
| **P6** | 市场调研工位（新建） | ✅ 已上线 |
| **P7** | 进出口情报改名 + 接入口子 | ✅ 改名完成；回流闭环口子已建（未接） |
| **P8** | 联调 + E2E + 订阅编码 | ⏳ 进行中 |

> **P4 产品手册附件**依赖 P6 的市场调研数据（`research_products` 筛选：
> 地区 + 行业 + 店铺类型 + 产品 + 能否提供=是）。P6 已上线，附件功能可随时接入。
> 附件格式：PDF（第一版）；生成方式：浏览器端生成（Worker 无 PDF 库），
> 存 R2 后作为附件随邮件发送；匹配到 0 个产品时提示用户可跳过。

### 9.2 平台演进

| 阶段 | 内容 | 出口标准 |
|------|------|---------|
| **Phase 1** ✅ | 进出口情报上线（原商情雷达） | 已交付（见 DEPLOY.md） |
| **Phase 2** ✅ | 三工位 Schema 口子 | 迁移 `20260919_workstation_links` |
| **Phase 3** ✅ | 报价工位 MVP | 报价单 CRUD + 信号引用 + 前端页面 |
| **Phase 4** ✅ | 订单工位 MVP | 报价转化 + 订单履约 + 前端页面 |
| **Phase 5** ✅ | 票据工位 MVP | 票据生成 + refs 溯源 + 前端页面 |
| **Phase 5.5** ✅ | 工位链（AI/线索/触达/调研） | 迁移 `20260921_*` + `20260922_research_workstation` |
| **Phase 6** | 产品手册附件 + 事件流联通 | R2 附件 + 引入 `domain_events`，替代手动触发扫描 |
| **Phase 7** | 智能闭环 | AI 驱动的报价推荐、风险预警、自动单证 |
| **Phase 8** | 情报回流闭环 | 已开发量四源聚合 → 空白指数 → 地图源地区排序 |

---

## 10. 不变量 (Invariants)

> 新增工位时必须遵守，违反视为架构回归。

1. **表前缀**：`{domain}_*`，禁止无前缀表
2. **租户隔离**：所有表必含 `tenant_id`，查询必带租户过滤
3. **跨工位只读**：下游可读上游表，禁止跨工位写
4. **关联表幂等**：所有 `*_refs` 表必含 `UNIQUE(tenant_id, ...)`
5. **业务编码唯一**：`order_no` / `quote_no` / `doc_no` 等全局唯一，作为幂等键
6. **迁移单向**：生产库迁移只增不改历史表结构（允许新增列，禁止重命名/删除已有列）
7. **独立部署**：任何工位可单独部署/回滚，不影响其它工位
8. **订阅可见性**：未订阅工位的 API 返回 404（不暴露存在性），前端显示引导页
9. **订阅隔离**：未订阅工位的代码不执行、数据不写入、入口不渲染
10. **订阅防绕过**：跨工位写入前必须检查目标工位订阅状态
11. **脚本优先**：能确定性计算的（规格提取、去重、过滤、计数）用脚本，
    不用 AI。AI 只用于难量化环节，且必须有降级路径（模板/留空），禁止臆测写入
12. **人工判定优先**：商业判断字段（如 `can_supply`）由用户填写，三态存储
    （`TRUE`/`FALSE`/`NULL`），不设默认值，禁止 AI 推断
13. **改名不迁移**：展示层命名变更不改表名/URL/API 前缀，避免破坏性迁移
14. **绑定只在请求期读**：Worker 的 vars/secrets 在 import 期读一定是空值
    （`os.environ` 不可靠），必须走 `request.scope["env"]` / `_binding()`；
    **secret 一律不得保留公开默认值**（缺失则 503，宁可不服务）
15. **路由显式声明**：`/api/*` 与 `/health` 必须在 assets 的 `run_worker_first` 中声明，
    禁止依赖“资产未命中才落到 Worker”的隐式行为（否则健康检查会被 SPA 回退伪装成 200）
16. **默认闭合的鉴权**：新增端点必须带 `Depends(_get_current_user)`；
    公开端点仅限 `login` / `health`（`bootstrap-admin` 用一次性 token）；
    **actor/tenant 一律取自 token，绝不信任请求体**
17. **埋点不阻断业务**：事件上报失败必须静默吸收（不重试风暴），
    但写入权限受鉴权约束（未登录不上报）

---

## 11. 相关文档

- `DEPLOY.md` — 部署架构与操作手册
- `backend/worker/README.md` — 单 Worker `kaas` 详情（API 一览 / 已知限制）
- `backend/docs/schema-registry.md` — 数据字典
- `shared/contracts/` — 前后端共享契约（zod）
- `.github/workflows/deploy.yml` — push 自动部署（前端构建 + Worker 部署 + 生产冒烟）

---

**最后更新**: 2026-09-22
**维护者**: David Sun
