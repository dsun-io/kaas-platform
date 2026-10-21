# 对外使用文档：REST API + MCP（W5 M4，2026-10-21）

> 面向外部脚本 / agent 的使用说明。**生产**：`https://kaas.powervoy.com`（或 `https://api.kaas.powervoy.com`）。
> 完整机器可读契约：`GET /openapi.json`（OpenAPI 3.1）；浏览器版：`/docs`。
> 鉴权：API token（`kaas_oat_…`）或登录会话 JWT（`Bearer`），同一 `Authorization` 头。

## 1. 获取 API token

1. 登录系统 → 设置 → **API 令牌** → 创建（选择 scope 与有效期）；
2. **明文只显示一次**（`kaas_oat_…`），请立即保存到密钥管理器；
3. 库中只存 sha256 哈希；遗失只能删除重建；撤销立即生效。

## 2. REST 调用示例

```bash
TOKEN='kaas_oat_xxx'   # 你的 token
BASE='https://kaas.powervoy.com'

# 列表（scope: customers:read）
curl -s "$BASE/api/v1/customers?page=1&page_size=20" \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json'

# 报价计算（scope: quotes:calc，引擎域经门面透传内核）
curl -s -X POST "$BASE/api/v1/export-quote/calculate" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"product_key":"chain_link","quantity":100,"fx_rate":7.2}'
```

响应形状与前端契约一致（`{items,total,page,page_size}` / `{detail:…}` 错误信封）。
**scope 不足返回 403** `{"detail":{"error":"forbidden","code":"SCOPE_NOT_DECLARED",…}}`；token 无效/过期 401。

## 3. MCP 接入（AI agent）

- 端点：`POST https://kaas.powervoy.com/mcp`（JSON-RPC 2.0 / Streamable HTTP 最小实现；当前仅 POST，SSE 未实现）
- 鉴权：**仅接受 API token**（JWT 会被 401；MCP client 用 Bearer）；
- 方法：`initialize` / `ping` / `tools/list` / `tools/call` / `resources/list` / `resources/read`；
- 工具按 token 的 scopes 过滤（无 scope 的工具不出现在 `tools/list`）。

Claude Desktop / 其他 MCP client 配置示例（stdio 桥接用 `mcp-remote`）：

```json
{
  "mcpServers": {
    "kaas": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://kaas.powervoy.com/mcp",
               "--header", "Authorization: Bearer ${KAAS_API_TOKEN}"]
    }
  }
}
```

首期 tools（8）：`customers_list` / `customers_search` / `inquiries_list` / `orders_list` /
`trade_docs_list` / `quotes_calculate` / `quotes_verify` / `intel_shipments_list`；
resources：`kaas://workstations`、`kaas://openapi`。

等价 curl 探测：

```bash
curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 4. scope 清单与含义

| scope | 覆盖 |
|---|---|
| customers:read / customers:write | 客户与联系人、capabilities |
| inquiries:read / inquiries:write | 询盘与阶段 |
| orders:read / orders:write | 订单/出运/应收/实际成本 |
| quotes:read / quotes:calc | 报价读取 / 报价计算与校验（引擎） |
| trade_docs:read / trade_docs:write | 单证 |
| files:read / files:write | 文件对象（含 presign/register） |
| leadgen:read / leadgen:write | 线索生成 |
| outreach:read / outreach:write | 触达（邮箱/活动/消息） |
| research:read / research:write | 市场调研 |
| intel:read | 情报/船运/市场数据（只读） |

未列入的路径/方法对 token 一律 403（**默认拒绝**）；JWT 会话不受此限。

## 5. 审计与边界（如实登记）

- token 的 `last_used_at` 在每次校验成功时更新；**逐次调用审计日志尚未接线**（M4 登记为后续）；
- token 绑定签发时的团队：签发后用户换团队会导致团队边界语义变化（内核不消费 team_id claim），
  建议换团队后撤销重建 token；
- 引擎域（quotes/trade-docs 等）由门面把 token 转换为 60s 内部 JWT 后调用内核，token 明文不出门面；
- MCP 目前只支持 POST（无 SSE 长连接）；复杂写操作请用 REST。

## 6. 验收清单（M4）

- [x] token 创建/列表/撤销/重复撤销 409（生产实测）
- [x] token 调 customers/orders/trade-docs 200；越权 403（生产实测）
- [x] MCP initialize/tools.list/tools.call（含 quotes_calculate 透传）200（生产实测）
- [x] 无 token / JWT 访问 MCP → 401（生产实测）
- [x] /openapi.json 141 path / 227 operation；/docs 可访问
- [x] UI 令牌管理页（`/settings/api-tokens`，2026-10-21 上线，前端门禁 + e2e 27 全过）
- [ ] 审计日志接线（后续）

---

*由 lead 编写 2026-10-21；随功能变化更新。*