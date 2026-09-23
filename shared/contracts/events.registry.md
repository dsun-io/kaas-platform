# Events Schema Registry

> **规则**：本文件是飞轮 L0 事件流的 **唯一注册表**。
> - 与 `shared/contracts/events.registry.md` **byte-equal**，CI 强制校验
> - 新增 event_type 或 schema_version 必须同步更新两处
> - 参见 v2 设计文档 §3.7.5

## capability.update (v1)
- customer_id: string
- product_category: string
- spec_constraints_before: object
- spec_constraints_after: object
- actor_id: string

## audit.access (v1)
- resource_type: enum [page | api | dataset]
- resource_id: string
- actor_id: string
- ip: string | null

## market.selected (v1)
- market_id: string
- market_name: string
- actor_id: string

## lead.discovered (v1)
- lead_id: string
- source: string
- actor_id: string

## lead.enriched (v1)
- lead_id: string
- fields_added: array[string]
- actor_id: string

## lead.outreach_ready (v1)
- lead_id: string
- channel: string
- actor_id: string

## outreach.sent (v1)
- lead_id: string
- channel: string
- actor_id: string

## outreach.replied (v1)
- lead_id: string
- channel: string
- reply_summary: string | null
- actor_id: string

## quotation.converted (v1)
- quotation_id: string
- order_id: string | null
- customer_id: string
- actor_id: string

## order.shipped (v1)
- order_id: string
- shipment_ref: string | null
- actor_id: string

## shipment.documented (v1)
- order_id: string
- doc_id: string | null
- doc_type: string
- actor_id: string
