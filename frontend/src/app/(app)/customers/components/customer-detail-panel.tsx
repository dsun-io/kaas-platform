"use client";

/**
 * 客户详情面板（Dialog + 信息/询盘·订单/历史三个 tab）。
 *
 * 从 page.tsx 抽出（U-P1D2），行为/DOM/aria 不变：
 * · 数据：useCustomerDetail + useCustomerRecords（往来记录）；
 * · 询盘卡片 → InquiryDetailDrawer（已独立，不重复拆）；
 * · 更新阶段 / 编辑档案 / 删除客户 → 小弹层组件。
 */
import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, MoreHorizontal, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState, StatusBadge } from "@/components/shared";
import { LoadingBlock } from "@/components/shared/loading-block";
import { NumberEditDialog } from "@/components/shared/number-edit-dialog";
import apiClient from "@/lib/api/client";
import { useCustomerRecords } from "@/lib/customer/use-customer-records";
import {
  EMPTY_CUSTOMER_RECORDS,
  type CustomerRecords,
  type RecordQuote,
} from "@/lib/customer/customer-records";

import { useCustomerDetail } from "../hooks/use-customers";
import { ContactForm, ContactInfoDialog } from "./contact-form";
import { DeleteCustomer, StageUpdate } from "./customer-detail-dialogs";
import { CustomerForm } from "./customer-form";
import {
  STAGE_TONES,
  stageLabel,
  type Contact,
  type Customer,
  type Inquiry,
} from "./customer-types";
import { errMsg } from "./error-message";
import { InquiryDetailDrawer } from "./inquiry-detail-drawer";
import { UnlinkedRecords, deriveInquiryStage } from "./inquiry-followups";
import { InquiryForm } from "./inquiry-form";
import { displayInquiryItems, inquiryProductSummary } from "./inquiry-items";
import { resolveInquiryStage } from "./inquiry-stage";

type DetailTab = "info" | "inquiries" | "history";

/**
 * 详情页「询盘/订单」tab 的订单计数（问题 5：订单也要算进 tab 计数）。
 *
 * 口径：records 树里的**订单节点** —— 报价单下的订单 + 直接归属客户的订单，每条算 1。
 * 后端 `build_records` 保证一个订单只落一个节点（`quote_id` 能命中报价就挂报价，
 * 否则进 `direct`），这里再按订单 id 去重，避免异常数据把同一订单算两次。
 *
 * 计数值必须能在 tab 内容里找到对应条目：报价单下的订单在对应询盘的
 * 「报价单 → 订单 → 单证」进度里；没有询盘来源的订单在下方
 * 「直接下单（正常分类）」区块单独列出（见 UnlinkedRecords）。
 */
function countCustomerOrders(records: CustomerRecords): number {
  const seen = new Set<number>();
  let anonymous = 0;
  for (const order of [
    ...records.quotes.flatMap((quote) => quote.orders),
    ...records.direct.orders,
  ]) {
    if (order.id === null) anonymous += 1;
    else seen.add(order.id);
  }
  return seen.size + anonymous;
}

function CustomerDetailPanel({
  customer,
  onClose,
  onUpdated,
}: {
  customer: Customer;
  onClose: () => void;
  onUpdated: (c: Customer) => void;
}) {
  const { data: detail, isLoading } = useCustomerDetail(customer.id);
  const [activeTab, setActiveTab] = useState<DetailTab>("info");
  const [showInquiryForm, setShowInquiryForm] = useState(false);
  const [showContactForm, setShowContactForm] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [confirmDeleteContactId, setConfirmDeleteContactId] = useState<
    number | null
  >(null);
  const [showStageUpdate, setShowStageUpdate] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [inquiryNoEdit, setInquiryNoEdit] = useState<Inquiry | null>(null);
  const [inquiryNoPending, setInquiryNoPending] = useState(false);
  const [inquiryNoError, setInquiryNoError] = useState<string | null>(null);
  const [contactInfo, setContactInfo] = useState<Contact | null>(null);
  // C3：删除联系人失败不能再静默（原来 catch{} 直接关确认行，用户以为删掉了）
  const [contactDeleteId, setContactDeleteId] = useState<number | null>(null);
  const [contactDeleteError, setContactDeleteError] = useState<string | null>(
    null,
  );
  // X1：询盘详情改为右侧抽屉（不再在卡片下方内联展开）
  const [inquiryDetailId, setInquiryDetailId] = useState<number | null>(null);
  const qc = useQueryClient();

  // 询盘 → 后续单据：records 接口的 quotes[].inquiry_id 是唯一关联依据。
  const recordsQuery = useCustomerRecords(customer.id);
  const recordsResult = recordsQuery.data;
  const records = recordsResult?.records ?? EMPTY_CUSTOMER_RECORDS;
  const recordsLoading = recordsQuery.isLoading;
  const recordsUnavailable =
    recordsQuery.isError || (recordsResult !== undefined && !recordsResult.ok);
  // 计数的订单来源：records 树（后端 `counts`/树是同一批行，这里用树计数，
  // 保证「算进 tab 的每个订单」在 tab 内容里都能找到；接口失败/加载中时未知，
  // 不显示一个假的 0）。
  const orderCount =
    recordsResult?.ok === true ? countCustomerOrders(records) : null;
  const inquiries = detail?.inquiries ?? [];
  const inquiryIds = new Set(inquiries.map((inq) => inq.id));
  const quotesByInquiry = new Map<number, RecordQuote[]>();
  for (const quote of records.quotes) {
    if (quote.inquiry_id == null) continue;
    const list = quotesByInquiry.get(quote.inquiry_id) ?? [];
    list.push(quote);
    quotesByInquiry.set(quote.inquiry_id, list);
  }
  // 没有询盘来源的报价：inquiry_id 为空，或指向的询盘已不在详情里（历史/已删）。
  // 后者若留在 quotesByInquiry 里会变成"订单被计数但没有入口"，所以一并归到这里。
  const unlinkedQuotes = records.quotes.filter(
    (quote) => quote.inquiry_id == null || !inquiryIds.has(quote.inquiry_id),
  );
  // 抽屉数据：选中询盘 + 它自己的后续单据 + 阶段（后端真值优先，推导兜底）
  const inquiryDetail =
    inquiryDetailId === null
      ? null
      : (detail?.inquiries?.find((inq) => inq.id === inquiryDetailId) ?? null);
  const inquiryDetailQuotes = inquiryDetail
    ? (quotesByInquiry.get(inquiryDetail.id) ?? [])
    : [];
  const inquiryDetailStage = inquiryDetail
    ? resolveInquiryStage(
        inquiryDetail.stage,
        inquiryDetail.status,
        deriveInquiryStage(
          inquiryDetail.status,
          inquiryDetailQuotes,
          recordsLoading,
        ),
      )
    : null;
  const primaryContact =
    detail?.contacts?.find((c) => c.is_primary) ??
    detail?.contacts?.[0] ??
    null;

  const handleInquiryNoSave = async (value: string) => {
    if (!inquiryNoEdit) return;
    setInquiryNoPending(true);
    setInquiryNoError(null);
    try {
      await apiClient.patch(`/inquiries/${inquiryNoEdit.id}`, {
        inquiry_no: value,
      });
      await qc.invalidateQueries({
        queryKey: ["customers", "detail", customer.id],
      });
      setInquiryNoEdit(null);
    } catch (e) {
      setInquiryNoError(errMsg(e));
    } finally {
      setInquiryNoPending(false);
    }
  };

  /** 询盘「已关闭」只能手动切换；重新打开时若已有报价会自动回到已报价。 */
  const toggleInquiryClosed = async (inq: Inquiry) => {
    const next = inq.status === "closed" ? "unquoted" : "closed";
    try {
      // silent：失败由本处统一 toast 一次（拦截器再提示会变双弹）；
      // 原先是 window.alert —— 阻塞、不可复制、与全站反馈不一致。
      await apiClient.patch(
        `/inquiries/${inq.id}`,
        { status: next },
        { silent: true },
      );
      await qc.invalidateQueries({
        queryKey: ["customers", "detail", customer.id],
      });
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const handleDeleteContact = async (contactId: number) => {
    if (contactDeleteId !== null) return; // pending 防重
    setContactDeleteId(contactId);
    setContactDeleteError(null);
    try {
      // silent：错误由本处页内 role=alert 统一展示（拦截器再 toast 会重复）
      await apiClient.delete(
        `/customers/${customer.id}/contacts/${contactId}`,
        { silent: true },
      );
      setConfirmDeleteContactId(null);
      qc.invalidateQueries({
        queryKey: ["customers", "detail", customer.id],
      });
    } catch (e) {
      // C3：失败保留确认行 + 页内可读原因，用户能重试
      setContactDeleteError(errMsg(e));
    } finally {
      setContactDeleteId(null);
    }
  };

  // 问题 5：询盘 tab 的计数要把订单算进去（询盘数 + 订单数）。
  // 订单数在 records 接口回来之前是未知的（不能拿 0 冒充），此时显示 "N+"。
  const inquiriesTabCount =
    orderCount === null
      ? `${inquiries.length}+`
      : String(inquiries.length + orderCount);
  const tabs: { key: DetailTab; label: string }[] = [
    { key: "info", label: "信息" },
    { key: "inquiries", label: `询盘/订单 (${inquiriesTabCount})` },
    { key: "history", label: "历史" },
  ];

  // 主要联系人置顶；其余按添加时间倒序（2026-10-20 用户口径）。
  const sortedContacts = [...(detail?.contacts ?? [])].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return tb - ta;
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(760px,calc(100vh-4rem))] w-[min(1080px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border border-white/60 bg-white/85 p-0 shadow-[0_30px_80px_-30px_rgba(15,23,42,0.45)] backdrop-blur-2xl sm:max-w-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/70 px-6 py-4">
          <div className="min-w-0">
            <DialogTitle className="truncate text-lg font-semibold">
              {customer.company_name}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground">
              客户详情 · {stageLabel(detail?.stage ?? customer.stage)}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭客户详情"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {isLoading && <LoadingBlock rows={4} />}
          {detail && (
            <div>
              <div className="sticky -top-4 z-10 -mx-6 mb-4 flex gap-1 border-b border-border/70 bg-white/80 px-6 backdrop-blur">
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`relative h-10 px-3 text-sm transition-colors ${
                      activeTab === tab.key
                        ? "font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {activeTab === "info" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground">国家：</span>
                      <span className="ml-1">{detail.country ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">信用等级：</span>
                      <span className="ml-1">{detail.credit_level ?? "-"}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-muted-foreground">地址：</span>
                      <span className="ml-1">{detail.address ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">默认港口：</span>
                      <span className="ml-1">{detail.default_port ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">阶段：</span>
                      <StatusBadge
                        tone={STAGE_TONES[detail.stage] ?? "default"}
                        className="ml-1"
                      >
                        {stageLabel(detail.stage)}
                      </StatusBadge>
                      {detail.stage === "ordered" && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          由开启中的订单自动推导
                        </span>
                      )}
                    </div>
                    {detail.notes && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">备注：</span>
                        <span className="ml-1">{detail.notes}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowEditForm(true)}
                    >
                      编辑档案
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowStageUpdate(true)}
                    >
                      更新阶段
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setShowDelete(true)}
                    >
                      删除客户
                    </Button>
                  </div>
                  {showEditForm && (
                    <CustomerForm
                      initial={customer}
                      onCreated={(raw) => {
                        setShowEditForm(false);
                        onUpdated(raw);
                      }}
                      onClose={() => setShowEditForm(false)}
                    />
                  )}
                  {showStageUpdate && (
                    <StageUpdate
                      customer={customer}
                      onClose={() => setShowStageUpdate(false)}
                    />
                  )}
                  {showDelete && (
                    <DeleteCustomer
                      customer={customer}
                      onClose={() => setShowDelete(false)}
                      onDeleted={onClose}
                    />
                  )}
                </div>
              )}

              {activeTab === "info" && (
                <div className="mt-6 space-y-4 border-t border-border/60 pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      联系人（{detail?.contacts?.length ?? 0}）
                    </span>
                    <Button size="sm" onClick={() => setShowContactForm(true)}>
                      <Plus className="mr-1 size-4" />
                      添加联系人
                    </Button>
                  </div>
                  {showContactForm && (
                    <ContactForm
                      customerId={customer.id}
                      onClose={() => setShowContactForm(false)}
                    />
                  )}
                  {editingContact && (
                    <ContactForm
                      customerId={customer.id}
                      initial={editingContact}
                      onClose={() => setEditingContact(null)}
                    />
                  )}
                  <div className="space-y-2">
                    {detail?.contacts?.length === 0 && (
                      <EmptyState
                        title="暂无联系人"
                        description="在下方「新增联系人」里补充主要联系人与电话/邮箱。"
                        className="py-6"
                      />
                    )}
                    {sortedContacts.map((c) => (
                      <div
                        key={c.id}
                        className="rounded-lg border bg-card p-4 shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-sm)]"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-medium text-sm">
                              {c.name}
                              {c.is_primary && (
                                <Badge variant="default" className="ml-2">
                                  主要
                                </Badge>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              {[
                                c.position,
                                c.phone,
                                c.email,
                                c.whatsapp ? `WA: ${c.whatsapp}` : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingContact(c)}
                            >
                              编辑
                            </Button>
                            {confirmDeleteContactId === c.id ? (
                              <>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  disabled={contactDeleteId === c.id}
                                  onClick={() => void handleDeleteContact(c.id)}
                                >
                                  {contactDeleteId === c.id
                                    ? "删除中…"
                                    : "确认删除"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setConfirmDeleteContactId(null)
                                  }
                                >
                                  取消
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                onClick={() => setConfirmDeleteContactId(c.id)}
                              >
                                删除
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {contactDeleteError ? (
                    <p
                      role="alert"
                      className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                    >
                      删除联系人失败：{contactDeleteError}
                    </p>
                  ) : null}
                </div>
              )}

              {activeTab === "inquiries" && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">
                        {inquiries.length} 条询盘
                        {orderCount !== null
                          ? ` · ${orderCount} 个订单`
                          : recordsLoading
                            ? " · 订单读取中…"
                            : " · 订单暂时读不到"}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        每条询盘下按「报价单 → 订单 → 单证」展示后续进度；
                        没有询盘来源的订单列在下方。
                      </p>
                    </div>
                    <Button size="sm" onClick={() => setShowInquiryForm(true)}>
                      <Plus className="mr-1 size-4" />
                      添加询盘
                    </Button>
                  </div>

                  {showInquiryForm && (
                    <InquiryForm
                      customerId={customer.id}
                      onClose={() => setShowInquiryForm(false)}
                    />
                  )}

                  <div className="space-y-3">
                    {/* 纯订单客户（0 询盘）不能显示"暂无询盘"：订单就在下方区块，
                        显示空态会把已计数的订单说成没有。只有询盘、订单都为 0 才空。 */}
                    {inquiries.length === 0 && orderCount === 0 && (
                      <EmptyState
                        title="暂无询盘"
                        description="询盘是报价与单据的起点：先添加询盘，再生成报价单。"
                        action={
                          <Button
                            size="sm"
                            onClick={() => setShowInquiryForm(true)}
                          >
                            <Plus className="mr-1 size-4" />
                            添加询盘
                          </Button>
                        }
                      />
                    )}

                    {inquiries.map((inq) => {
                      const linkedQuotes = quotesByInquiry.get(inq.id) ?? [];
                      // 阶段口径：后端 F4 真值（inq.stage）优先，推导仅作兜底
                      // （历史行没有 stage / 关闭后重开的陈旧 stage）。
                      const stage = resolveInquiryStage(
                        inq.stage,
                        inq.status,
                        deriveInquiryStage(
                          inq.status,
                          linkedQuotes,
                          recordsLoading,
                        ),
                      );
                      // 多产品行（items 优先；历史询盘用旧标量字段合成一行）
                      const productViews = displayInquiryItems(inq);
                      return (
                        <div
                          key={inq.id}
                          role="button"
                          tabIndex={0}
                          aria-haspopup="dialog"
                          aria-label={`查看询盘 ${inq.inquiry_no ?? inq.id} 详情`}
                          onClick={() => setInquiryDetailId(inq.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setInquiryDetailId(inq.id);
                            }
                          }}
                          className="group cursor-pointer rounded-xl border border-border/70 bg-white/70 p-4 transition-colors hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-sm font-medium">
                                  {inq.inquiry_no ?? `询盘 #${inq.id}`}
                                </span>
                                <StatusBadge
                                  tone={stage.tone}
                                  className="h-5 px-2 text-[11px]"
                                >
                                  {stage.label}
                                </StatusBadge>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {inquiryProductSummary(productViews)}
                              </p>
                              {/* 最新一步（报价单 / 订单 / 单证编号 + 状态）：
                                  「询盘/订单」计数把订单算进去后，订单必须能在询盘卡片上
                                  对得上号（否则只能进抽屉看，属于假修）。 */}
                              {stage.hint && (
                                <p className="mt-0.5 text-[11px] text-muted-foreground">
                                  {stage.hint}
                                </p>
                              )}
                            </div>
                            <div
                              className="flex items-center gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Link
                                href={`/quotes?tab=product&customer_id=${customer.id}&inquiry_id=${inq.id}`}
                                className="inline-flex h-7 items-center rounded-lg border border-border bg-white/70 px-2.5 text-xs font-medium text-primary transition-colors hover:bg-white"
                              >
                                {inq.status === "quoted" ||
                                linkedQuotes.length > 0
                                  ? "重新报价 →"
                                  : "为此询盘报价 →"}
                              </Link>
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                  aria-label="更多询盘操作"
                                >
                                  <MoreHorizontal className="size-4" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  align="end"
                                  className="w-40"
                                >
                                  {inq.inquiry_no_editable && (
                                    <DropdownMenuItem
                                      className="cursor-pointer"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setInquiryNoError(null);
                                        setInquiryNoEdit(inq);
                                      }}
                                    >
                                      改编号
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem
                                    className="cursor-pointer"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void toggleInquiryClosed(inq);
                                    }}
                                  >
                                    {inq.status === "closed"
                                      ? "重新打开询盘"
                                      : "关闭询盘"}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                              <ChevronRight
                                className="size-4 text-muted-foreground"
                                aria-hidden="true"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    {/* X1：询盘详情抽屉（产品 / 联系人 / 报价→订单→单证 / 阶段历史） */}
                    <InquiryDetailDrawer
                      open={inquiryDetail !== null}
                      onOpenChange={(open) => {
                        if (!open) setInquiryDetailId(null);
                      }}
                      inquiry={inquiryDetail}
                      stage={inquiryDetailStage}
                      quotes={inquiryDetailQuotes}
                      primaryContact={primaryContact}
                      onContactClick={() => {
                        if (primaryContact) setContactInfo(primaryContact);
                        setInquiryDetailId(null);
                      }}
                      recordsLoading={recordsLoading}
                      recordsUnavailable={recordsUnavailable}
                      onRetryRecords={() => void recordsQuery.refetch()}
                    />

                    <UnlinkedRecords
                      quotes={unlinkedQuotes}
                      direct={records.direct}
                      loading={recordsLoading}
                      unavailable={recordsUnavailable}
                      onRetry={() => void recordsQuery.refetch()}
                    />

                    <NumberEditDialog
                      open={inquiryNoEdit !== null}
                      onOpenChange={(open) => {
                        if (!open) setInquiryNoEdit(null);
                      }}
                      title="修改询盘编号"
                      label="询盘编号"
                      currentValue={inquiryNoEdit?.inquiry_no ?? ""}
                      description="询盘编号默认自动生成；生成报价单之前可以修改。"
                      warning="确认后编号会立即生效。一旦用该询盘生成报价单，编号将自动锁定，不能再改。"
                      pending={inquiryNoPending}
                      error={inquiryNoError}
                      onConfirm={handleInquiryNoSave}
                    />
                  </div>
                </div>
              )}

              {activeTab === "history" && (
                <div className="space-y-2">
                  {detail?.stage_log?.length === 0 ? (
                    <EmptyState
                      title="暂无历史记录"
                      description="阶段流转后，这里会按时间倒序记录变更来源与原因。"
                      className="py-6"
                    />
                  ) : (
                    detail?.stage_log?.map((log) => (
                      <div
                        key={log.id}
                        className="rounded-lg border bg-card p-4 text-sm shadow-[var(--shadow-xs)]"
                      >
                        <div className="flex items-center justify-between">
                          <span>
                            {log.from_stage
                              ? stageLabel(log.from_stage)
                              : "创建"}
                            {" -> "}
                            {stageLabel(log.to_stage)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(log.created_at).toLocaleString()}
                          </span>
                        </div>
                        {log.reason && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {log.reason}
                          </p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
      <ContactInfoDialog
        contact={contactInfo}
        onClose={() => setContactInfo(null)}
      />
    </Dialog>
  );
}

export { CustomerDetailPanel };
