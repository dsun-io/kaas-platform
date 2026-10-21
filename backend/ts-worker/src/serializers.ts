/**
 * KaaS TS 门面 · 行 → API 投影（对齐 Python 侧序列化真源）。
 *
 * - 客户/询盘：kaas_common/workstation/customer_serializers.py 的
 *   row_to_customer / row_to_inquiry 逐键直译；
 * - 联系人/阶段日志：main.py:_contact_api / _stage_log_api（7 键 / 5 键投影）；
 * - 团队/邀请/订阅：ws_teams.py:_team_out / _invite_out、ws_workstations.py:_sub_out / _sub_set_out。
 *
 * 只做键名映射与类型规范化（int8→number、timestamptz→iso 字符串），无业务规则。
 */
import { bool, num, pyIso } from "./http";
import { isTeamAdmin } from "./rules";
import type { CurrentUser } from "./session";

type Row = Record<string, unknown>;

function get(row: Row, key: string): unknown {
  return row[key];
}

/**
 * 客户行 → API 响应（customer_serializers.py:row_to_customer 逐键对齐）。
 * displayStage 由调用方用 customerStageSql('c') AS stage_display 算好传入；
 * 不传时退回手动状态（新建客户必然没有订单，等价于 active）。
 */
export function rowToCustomer(c: Row, displayStage?: string | null): Record<string, unknown> {
  const manual = c.stage === "inactive" || c.stage === "lost" ? "inactive" : "active";
  return {
    id: num(get(c, "id")),
    company_name: get(c, "name") ?? get(c, "company_name"),
    abbr: get(c, "abbr"),
    country: get(c, "country"),
    address: get(c, "address"),
    default_port: get(c, "default_port"),
    credit_level: get(c, "credit_level"),
    // 对外展示阶段（活跃 / 沉寂 / 已下单）
    stage: displayStage ?? manual,
    // 手动状态（活跃 / 沉寂）—— 客户页「更新阶段」用它回填
    manual_stage: manual,
    notes: get(c, "notes"),
    created_at: pyIso(get(c, "created_at")),
    updated_at: pyIso(get(c, "updated_at")),
  };
}

/** 客户行 → API 响应（含 stage_display 列，对齐 main.py:_customer_api）。 */
export function customerApi(row: Row): Record<string, unknown> {
  return rowToCustomer(row, (row.stage_display as string | null | undefined) ?? undefined);
}

/** 询盘行 → API 响应（customer_serializers.py:row_to_inquiry 逐键对齐）。 */
export function rowToInquiry(i: Row): Record<string, unknown> {
  const qty = get(i, "quantity");
  return {
    id: num(get(i, "id")),
    customer_id: num(get(i, "customer_id")),
    inquiry_no: get(i, "inquiry_no"),
    lead_id: num(get(i, "lead_id")),
    channel: get(i, "channel"),
    category_id: num(get(i, "category_id")),
    product_name_raw: get(i, "product_name_raw"),
    quantity: qty === null || qty === undefined ? null : Number(qty),
    quantity_unit: get(i, "quantity_unit"),
    application: get(i, "application"),
    status: get(i, "status"),
    stage: get(i, "stage"),
    stage_updated_at: pyIso(get(i, "stage_updated_at")),
    created_at: pyIso(get(i, "created_at")),
  };
}

/** 联系人 7 键投影（main.py:_contact_api，PARITY-CRM-11）。 */
export function contactApi(row: Row): Record<string, unknown> {
  return {
    id: num(row.id),
    name: row.name,
    position: row.position,
    phone: row.phone,
    email: row.email,
    whatsapp: row.whatsapp,
    is_primary: bool(row.is_primary),
  };
}

/** 客户阶段日志 5 键投影（main.py:_stage_log_api）。 */
export function stageLogApi(row: Row): Record<string, unknown> {
  return {
    id: num(row.id),
    from_stage: row.from_stage,
    to_stage: row.to_stage,
    reason: row.reason,
    created_at: pyIso(row.created_at),
  };
}

/** 询盘阶段日志投影（ws_crm_ext.py:list_inquiry_stage_log 行形状，无 id 列）。 */
export function inquiryStageLogApi(row: Row): Record<string, unknown> {
  return {
    from_stage: row.from_stage,
    to_stage: row.to_stage,
    source_event: row.source_event,
    actor_id: row.actor_id,
    note: row.note,
    created_at: pyIso(row.created_at),
  };
}

/** 团队输出（ws_teams.py:_team_out 逐键对齐）。 */
export function teamOut(team: Row, user: CurrentUser, memberCount: number): Record<string, unknown> {
  return {
    id: num(team.id),
    name: team.name,
    created_by: num(team.created_by),
    is_admin: isTeamAdmin(team.created_by, user.id, user.role),
    member_count: memberCount,
  };
}

/** 邀请输出（ws_teams.py:_invite_out 逐键对齐）。 */
export function inviteOut(row: Row): Record<string, unknown> {
  return {
    id: num(row.id),
    email: row.email,
    token: row.token,
    status: row.status,
    created_at: pyIso(row.created_at),
    expires_at: pyIso(row.expires_at),
    accepted_at: pyIso(row.accepted_at),
    accepted_by: num(row.accepted_by),
  };
}

/** 订阅输出（ws_workstations.py:_sub_out，列表用，多 created_at）。 */
export function subOut(row: Row): Record<string, unknown> {
  return {
    code: row.code,
    active: bool(row.active),
    expires_at: pyIso(row.expires_at),
    source: row.source,
    created_at: pyIso(row.created_at),
  };
}

/** PUT 订阅输出（ws_workstations.py:_sub_set_out，契约固定 4 键）。 */
export function subSetOut(row: Row): Record<string, unknown> {
  return {
    code: row.code,
    active: bool(row.active),
    expires_at: pyIso(row.expires_at),
    source: row.source,
  };
}

/**
 * customer_capabilities 行 → API 形状（main.py:_capability_row 逐键对齐；
 * spec_constraints 是 jsonb，postgres.js 可能给对象或字符串，双形态兼容——与 Python 同口径）。
 */
export function capabilityRow(r: Row): Record<string, unknown> {
  let sc = r.spec_constraints;
  if (typeof sc === "string") {
    try {
      sc = JSON.parse(sc);
    } catch {
      sc = {};
    }
  }
  return {
    id: num(r.id),
    customer_id: r.customer_id,
    customer_name: r.customer_name,
    product_category: r.product_category,
    spec_constraints: sc ?? {},
    notes: r.notes,
    effective_from: r.effective_from,
    updated_at: pyIso(r.updated_at),
  };
}
