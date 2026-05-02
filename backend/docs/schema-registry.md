# Events Schema Registry

> **规则**：本文件是飞轮 L0 事件流的 **唯一注册表**。
> - 与 `shared/contracts/events.registry.md` **byte-equal**，CI 强制校验
> - 新增 event_type 或 schema_version 必须同步更新两处
> - 参见 v2 设计文档 §3.7.5

## chat.turn (v1)
- session_id: string
- raw_text: string
- agent_id: string
- customer_id: string
- response_text: string
- llm_model: string
- llm_tokens_in: int
- llm_tokens_out: int

## quote.request (v1)
- session_id: string
- customer_id: string
- product_category: string
- product_spec: object
- quantity: int

## quote.response (v1)
- session_id: string
- status: enum [matched | estimated | spec_not_supported]
- source: enum [quotations_db | L1_L2_formula]
- unit_price: decimal | null
- confidence: enum [high | medium | low]

## capability.update (v1)
- customer_id: string
- product_category: string
- spec_constraints_before: object
- spec_constraints_after: object
- actor_id: string

## kb.edit (v1)
- dataset_name: string
- chunk_id: string | null
- action: enum [create | update | delete]
- actor_id: string

## audit.access (v1)
- resource_type: enum [page | api | dataset]
- resource_id: string
- actor_id: string
- ip: string | null
