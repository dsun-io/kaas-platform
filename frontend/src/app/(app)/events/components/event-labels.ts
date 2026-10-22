/**
 * 事件相关的中文说法（设计稿 §1/§7：技术详情页把事件代码 / 内容项翻成中文或给摘要）。
 *
 * 原始事件代码仍保留在详情「查看详情（一般不需要看）」里，便于排查；
 * 列表与摘要在普通界面只显示中文，不直接摆技术代码。
 */

const EVENT_TYPE_LABELS: Record<string, string> = {
  "audit.access": "访问审计",
  "capability.update": "能力配置更新",
  "market.selected": "选择市场",
  "lead.discovered": "发现线索",
  "lead.enriched": "补全线索",
  "lead.outreach_ready": "线索待触达",
  "outreach.sent": "触达已发出",
  "outreach.replied": "收到客户回复",
  "quotation.converted": "报价转订单",
  "order.shipped": "订单已发货",
  "shipment.documented": "单证已归档",
};

export function eventTypeLabel(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? "其他事件";
}

const EVENT_SOURCE_LABELS: Record<string, string> = {
  frontend: "界面操作",
  backend: "系统后台",
};

export function eventSourceLabel(source: string): string {
  return EVENT_SOURCE_LABELS[source] ?? "其他来源";
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  page: "页面",
  api: "系统接口",
  dataset: "数据集合",
};

function resourceTypeLabel(value: string): string {
  return RESOURCE_TYPE_LABELS[value] ?? "其他对象";
}

/** 常用页面路径的中文名（访问审计里的「访问对象」不该是一串路由） */
const RESOURCE_PATH_LABELS: Record<string, string> = {
  "/dashboard": "工作台",
  "/products": "产品",
  "/customers": "客户",
  "/orders": "订单",
  "/quotes": "报价",
  "/trade-docs": "单证",
  "/receivables": "应收",
  "/events": "事件审计",
  "/audit-log": "操作日志",
  "/billing": "升级订阅",
  "/settings": "设置",
  "/admin/gray-release": "灰度发布",
  "/admin/teams": "团队管理",
};

function resourcePathLabel(value: string): string {
  return RESOURCE_PATH_LABELS[value] ?? value;
}

const PAYLOAD_FIELD_LABELS: Record<string, string> = {
  resource_type: "访问对象类型",
  resource_id: "访问对象",
  actor_id: "操作人",
  ip: "IP 地址",
  customer_id: "客户",
  product_category: "产品类别",
  spec_constraints_before: "原能力范围",
  spec_constraints_after: "新能力范围",
  market_id: "市场编号",
  market_name: "市场名称",
  lead_id: "线索编号",
  source: "来源",
  fields_added: "补充的内容项",
  channel: "触达方式",
  reply_summary: "回复摘要",
  quotation_id: "报价单编号",
  order_id: "订单编号",
  shipment_ref: "发货单号",
  doc_id: "单证编号",
  doc_type: "单证类型",
};

export function payloadFieldLabel(field: string): string {
  return PAYLOAD_FIELD_LABELS[field] ?? "其他内容";
}

/** 内容项取值的展示文本：只给摘要，原始结构留在「查看详情」里。 */
export function payloadValueText(field: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length ? `共 ${value.length} 项` : "—";
  if (typeof value === "object") return "多项内容（展开详情可看原始数据）";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (field === "resource_type") return resourceTypeLabel(String(value));
  if (field === "resource_id") return resourcePathLabel(String(value));
  return String(value);
}
