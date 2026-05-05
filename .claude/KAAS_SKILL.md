# KaaS 项目 · 开发技能参考

> 适用于 Claude Code 在当前 v2 重构期的开发模式参考。
> 最后更新：2026-05-04

---

## S1. 报价引擎开发模式

### 数据流
```
用户输入 → Step 0: 品类校验
  → Step 1: spec 匹配（spec_matcher.py）
  → Step 2: 成本计算（niulanwang_pricing.py）
  → Step 3: 三档定价（calculate_tiers）
  → Step 4: 配件计价（price_accessories）
  → Step 5: 运费计算（freight_calculator.py）
  → Step 6: 话术渲染（render_quote_script）
```

### 关键服务文件
| 文件 | 职责 |
|------|------|
| `app/services/quote_engine.py` | 报价编排主入口 |
| `app/services/spec_matcher.py` | 规格匹配（AND 条件过滤） |
| `app/services/niulanwang_pricing.py` | 成本 + tier 定价计算 |
| `app/services/freight_calculator.py` | 运费公式计算 |

### 种子数据模式
1. 数据来源标注 `source` 字段
2. 不确定字段标记 `pending_review`
3. 矩阵数据用程序生成，不用手工逐条写
4. seed 脚本幂等（依赖 DB 唯一约束或 hash 检查）

---

## S2. 外部 API 集成模式

### Notion 数据读取
```bash
curl -s "https://api.notion.com/v1/blocks/{page_id}/children?page_size=100" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28"
```
- 使用 HTTPS REST API 直连
- Token 保存在 `notion_token.md`
- PostgreSQL 数据通过 Docker Compose 访问

---

## S3. 种子数据开发模式

1. 从 Notion 提取原始数据（表格/列表）
2. 转换为程序化数据矩阵（Python dict / list）
3. 写入 `backend/orchestrator/scripts/seed_dev.py`
4. 运行 seed 脚本入库
5. 运行测试验证

### 种子数据标注规范
- `source: "notion:lianjai_knowledge_base"` — Notion 直接提取
- `source: "seed"` — 程序默认值或测试数据
- `source: "manual"` — 手工录入
- 不确定值标注 `pending_review` 在 notes/comments 中

---

## S4. 前端开发模式（v2-quote）

### 组件结构
```
v2-quote/
├── components/
│   ├── quote-form.tsx    # 报价表单（品类选择 + 规格选择 + 配件 + 运费）
│   └── quote-result.tsx  # 报价结果（匹配状态 + 价格表格 + 话术）
├── hooks/
│   └── use-v2-quote.ts   # API 调用（useProductSpecs + useQuoteV2）
└── page.tsx              # 页面入口
```

### 关键模式
- 品类枚举从 `@contracts/categories` 导入（唯一真相源）
- 规格选项从 API 动态获取（不硬编码）
- API 请求/响应类型共享自 `@contracts/quote`

---

## S5. DB 设计模式

### 表结构
| 表 | 写入模式 | 说明 |
|------|----------|------|
| product_specs | 幂等 INSERT | 平台规格目录，通过 spec_hash 去重 |
| customer_cost_items | INSERT | 客户私有成本，按 spec_hash 关联 |
| customer_pricing_profiles | INSERT | 加价倍率 + 税点 |
| customer_freight_rates | INSERT | 运费规则 |
| events | INSERT-only | 事件溯源，永不删除 |
| quotations | INSERT-only | 报价事实表 |
| customer_capabilities | INSERT-only | 客户能力边界 |
| customer_sale_price_items | INSERT | 售价覆盖（override） |

---

*技能文件结束。按需参考对应章节。*
