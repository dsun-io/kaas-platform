/**
 * 单证 chip —— 报价单 / 形式发票 / 商业发票 / 装箱单 / 提单… **同一套**。
 *
 * 为什么坚决只有一套 chip（而不是"报价模块一套、单证模块一套"）：
 *   设计文档 §4 的硬要求 —— 报价单和 PI/CI/PL/BL 属于同一个客户的同一棵树，
 *   分家会让"这个客户的单据"看起来像两批数据。类型差异只由**图标 + 配色**表达。
 *
 * 为什么这里自带一份类型元数据、不去调 `getAvailableTemplates()`：
 *   那个函数会把 18 份单据模板资产（assets.json + manifest.json，约 90KB JSON）
 *   一起拉进客户详情的包里，而这里只需要一个中文名和一个图标。
 *   未知类型一律退化成"原始 doc_type + 默认灰"，不会因为后端加了新类型而不显示。
 */
import {
  BadgeCheck,
  ClipboardList,
  Factory,
  FileCheck2,
  FileSignature,
  FileText,
  Leaf,
  Package,
  Receipt,
  Scale,
  Send,
  ShieldCheck,
  Ship,
  Stamp,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { StatusTone } from "@/components/shared";

export interface DocTypeMeta {
  label: string;
  icon: LucideIcon;
  tone: StatusTone;
}

const DEFAULT_META: DocTypeMeta = {
  label: "其他单据",
  icon: FileText,
  tone: "default",
};

/**
 * 类型 → 图标/配色。配色沿用 `.badge-*` 语义令牌（自带暗色模式），
 * 与状态徽标同一套色板，避免客户页出现第三种颜色语言。
 */
export const DOC_TYPE_META: Record<string, DocTypeMeta> = {
  // 报价单是树的第一层产物，用紫色与其它单据区分开
  quotation: { label: "报价单", icon: FileText, tone: "purple" },
  pi: { label: "形式发票", icon: ClipboardList, tone: "info" },
  ci: { label: "商业发票", icon: Receipt, tone: "success" },
  pl: { label: "装箱单", icon: Package, tone: "warning" },
  bl: { label: "提单", icon: Ship, tone: "info" },
  contract: { label: "合同", icon: FileSignature, tone: "purple" },
  co: { label: "原产地证", icon: BadgeCheck, tone: "success" },
  insurance: { label: "保险单", icon: ShieldCheck, tone: "info" },
  customs_declaration: {
    label: "报关单",
    icon: ClipboardList,
    tone: "default",
  },
  fumigation_cert: { label: "熏蒸证", icon: Leaf, tone: "success" },
  shipping_advice: { label: "装运通知", icon: Send, tone: "info" },
  weight_list: { label: "重量单", icon: Scale, tone: "warning" },
  quality_cert: { label: "质量证书", icon: BadgeCheck, tone: "success" },
  manufacturer_cert: { label: "制造商证明", icon: Factory, tone: "default" },
  beneficiary_cert: { label: "受益人证明", icon: FileCheck2, tone: "purple" },
  non_wood_packing: { label: "非木质包装声明", icon: Stamp, tone: "warning" },
  draft: { label: "汇票", icon: FileText, tone: "default" },
  other: DEFAULT_META,
};

const TONE_CLASS: Record<StatusTone, string> = {
  default: "badge-default",
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  info: "badge-info",
  purple: "badge-purple",
};

/** 未知 doc_type 直接显示原始值：宁可显示英文码，也不要显示空白 chip。 */
export function docTypeMeta(docType: string): DocTypeMeta {
  return (
    DOC_TYPE_META[docType] ?? { ...DEFAULT_META, label: docType || "单据" }
  );
}

export const DOC_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  issued: "已签发",
  void: "已作废",
};

export function docStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return DOC_STATUS_LABEL[status] ?? status;
}

interface DocChipProps {
  docType: string;
  docNo: string;
  status?: string | null;
  className?: string;
}

/**
 * 只要"类型"这一枚标签（台账/列表里编号与状态已各有列，不需要重复渲染）。
 * 与 DocChip 共用同一份 `DOC_TYPE_META` 与配色令牌 —— 报价单在台账里也是紫色「报价单」，
 * 不会出现"树里叫报价单、台账里叫 quotation"。
 */
export function DocTypeLabel({
  docType,
  className,
}: {
  docType: string;
  className?: string;
}) {
  const meta = docTypeMeta(docType);
  const Icon = meta.icon;
  return (
    <span
      className={cn("badge gap-1", TONE_CLASS[meta.tone], className)}
      title={meta.label}
    >
      <Icon className="size-3 shrink-0" />
      {meta.label}
    </span>
  );
}

export function DocChip({ docType, docNo, status, className }: DocChipProps) {
  const meta = docTypeMeta(docType);
  const Icon = meta.icon;
  const statusText = docStatusLabel(status);
  return (
    <span
      className={cn(
        "badge gap-1",
        TONE_CLASS[meta.tone],
        status === "void" && "line-through opacity-60",
        className,
      )}
      title={`${meta.label} ${docNo}${statusText ? ` · ${statusText}` : ""}`}
    >
      <Icon className="size-3 shrink-0" />
      <span className="opacity-80">{meta.label}</span>
      <span className="font-mono">{docNo}</span>
      {statusText && (
        <span className="text-[10px] opacity-70">{statusText}</span>
      )}
    </span>
  );
}
