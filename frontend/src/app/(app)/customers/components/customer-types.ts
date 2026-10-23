/**
 * 客户域共享类型与阶段展示常量（从 page.tsx 抽出，行为不变）。
 *
 * 抽出的原因（U-P1D2）：原 page.tsx 1674 行把类型/表单/详情/列表全塞在一处，
 * 拆成职责组件后这些类型是它们共同依赖的最小面（避免各组件各抄一份口径）。
 */
import type { InquiryItem } from "./inquiry-items";

// 客户阶段（2026-10-18 用户口径）：只有三种。
// active / inactive 是手动状态；ordered 由「开启中的订单」自动推导，不可手选。
const STAGE_LABELS: Record<string, string> = {
  active: "活跃",
  inactive: "沉寂",
  ordered: "已下单",
};

// 列表筛选可选值 = 后端 `CUSTOMER_STAGE` 全量（backend/kaas_common/domain/enums.py:20）：
// ordered 是推导展示值，后端列表端点按「名下是否有开启中订单」过滤（worker main.py:1300-1310）。
const CUSTOMER_STAGE_FILTER_OPTIONS = [
  "active",
  "inactive",
  "ordered",
] as const;

// 历史阶段日志里可能还有旧值（lead/inquiry/quoted/won/lost）——只用于「历史」页签展示。
const LEGACY_STAGE_LABELS: Record<string, string> = {
  lead: "线索",
  inquiry: "询盘",
  quoted: "已报价",
  won: "成交",
  lost: "流失",
};

function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "-";
  return STAGE_LABELS[stage] ?? LEGACY_STAGE_LABELS[stage] ?? stage;
}

const STAGE_TONES: Record<string, import("@/components/shared").StatusTone> = {
  active: "info",
  inactive: "default",
  ordered: "success",
};

interface Customer {
  id: number;
  company_name: string;
  /** 客户缩写（2-6 位字母/数字，用于询盘编号自动生成） */
  abbr?: string | null;
  country: string | null;
  address: string | null;
  default_port: string | null;
  credit_level: string | null;
  /** 展示阶段：active / inactive / ordered（ordered 由开启中的订单推导） */
  stage: string;
  /** 手动状态：active / inactive（「更新阶段」用它回填） */
  manual_stage?: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface Contact {
  id: number;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  whatsapp: string | null;
  is_primary: boolean;
  /** 后端 `SELECT *` 会带；列表按「主要置顶 + 添加时间倒序」排序 */
  created_at?: string | null;
}

interface Inquiry {
  id: number;
  customer_id: number;
  /** 自动生成的询盘编号（国家-客户缩写-时间戳）；历史询盘可能为空 */
  inquiry_no?: string | null;
  /** 编号是否可改：生成报价单之后锁定 */
  inquiry_no_editable?: boolean;
  channel: string | null;
  product_name_raw: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  application: string | null;
  /**
   * 多产品行（设计稿 docs/OPTIMIZATION_PLAN_2026-10-22_PRODUCT_INQUIRY_ORDER.md §13
   * 方案 A）。历史询盘 / 后端暂未返回时为空 ⇒ 卡片回退到上面的旧标量字段展示。
   */
  items?: InquiryItem[] | null;
  /** 询盘备注（后端序列化目前不含，仅本地新数据可能有） */
  notes?: string | null;
  status: string;
  /**
   * F4 询盘阶段真值（事件驱动落库：inquiry/quotation/order/shipment/completed/closed）。
   * 迁移前的历史行可能是 null —— 此时前端回退到 deriveInquiryStage() 推导。
   */
  stage?: string | null;
  /** 阶段最后变更时间（后端序列化；仅展示历史时可用） */
  stage_updated_at?: string | null;
  created_at: string;
}

interface StageLog {
  id: number;
  from_stage: string | null;
  to_stage: string;
  reason: string | null;
  created_at: string;
}

interface CustomerDetail extends Customer {
  contacts: Contact[];
  inquiries: Inquiry[];
  stage_log: StageLog[];
}

export type { Customer, Contact, Inquiry, StageLog, CustomerDetail };
export {
  STAGE_LABELS,
  CUSTOMER_STAGE_FILTER_OPTIONS,
  LEGACY_STAGE_LABELS,
  STAGE_TONES,
  stageLabel,
};
