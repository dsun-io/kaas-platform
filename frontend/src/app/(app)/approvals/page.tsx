"use client";

/**
 * 审批中心（/approvals，设计 §6.2 / §9.5，D-12）。
 *
 * 三个视图（内核 `GET /approvals?view=` 的语义）：
 *  - 待我审批：我是路由审批人的 pending（管理员看全部 pending，兜底不卡流程）；
 *  - 我发起的：requested_by = 我（任何状态）；
 *  - 已处理：decided_by = 我（approved / rejected）。
 *
 * 为什么详情不逐条请求：`_request_dict` 已把**新旧明细**放进聚合行
 * （items + snapshot），详情点开就能对比；只有"受影响单证"需要按订单再查
 * `/trade-docs`（内核只在批准响应里回 affected_docs，审批前必须自己算一遍）。
 *
 * 深链 `/approvals?focus=<rid>`（通知 link 的形状）：挂载后读 location.search，
 * 不用 `useSearchParams`（静态导出下需要 Suspense 包裹，quotes 页已踩过）。
 */
import { useMemo, useState } from "react";
import { AlertCircle, Inbox } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth/auth-context";
import { usePageView } from "@/lib/events/use-page-view";
import {
  APPROVALS_FOCUS_PAGE_SIZE,
  APPROVALS_PAGE_SIZE,
  findApprovalItem,
  useApprovals,
} from "@/lib/approvals/use-approvals";
import type { ApprovalItem, ApprovalView } from "@/lib/approvals/types";

import { ApprovalDetailDrawer } from "./components/approval-detail-drawer";
import { ApprovalListTable } from "./components/approval-list-table";

const VIEW_TABS: { value: ApprovalView; label: string }[] = [
  { value: "pending", label: "待我审批" },
  { value: "mine", label: "我发起的" },
  { value: "done", label: "已处理" },
];

const VIEW_HINT: Record<ApprovalView, string> = {
  pending:
    "已指定审批人时归指定审批人，未指定时归团队管理员；管理员可兜底介入，避免流程卡死。",
  mine: "你提交的变更申请；批准前订单保持原样，批准后才应用新明细。",
  done: "你批准或拒绝过的申请；驳回理由会随通知发给申请人。",
};

/**
 * 读深链 `?focus=<rid>`（通知 link 的形状）。放在 useState 惰性初始化里：
 * 用 effect + setState 会触发 `react-hooks/set-state-in-effect`，而这里首帧
 * 多一个聚焦 id 不会改变 SSR/客户端的 DOM（数据都要等请求回来）⇒ 无 hydration 风险。
 */
function readFocusRequestId(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("focus");
  const id = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const EMPTY_COPY: Record<ApprovalView, { title: string; description: string }> =
  {
    pending: {
      title: "没有待你审批的变更申请",
      description:
        "已确认订单要改货物明细时会先提交申请并通知审批人；有新的待批会出现在这里。",
    },
    mine: {
      title: "你还没有发起过变更申请",
      description:
        "在订单详情里修改已确认订单的货物明细即可提交申请；审批通过后才会应用。",
    },
    done: {
      title: "还没有你处理过的申请",
      description: "你批准或拒绝过的变更申请会保留在这里，便于回查处理意见。",
    },
  };

export default function ApprovalsPage() {
  usePageView({ resource_id: "/approvals" });
  const { user } = useAuth();
  const currentUserId = user?.user_id ?? null;

  const [view, setView] = useState<ApprovalView>("pending");
  const [page, setPage] = useState(1);
  // 深链聚焦：通知里点进来时可能在第一页之外，命中时临时放大页大小
  const [focusId, setFocusId] = useState<number | null>(readFocusRequestId);
  const [selected, setSelected] = useState<ApprovalItem | null>(null);

  const pageSize =
    focusId === null ? APPROVALS_PAGE_SIZE : APPROVALS_FOCUS_PAGE_SIZE;
  const list = useApprovals({ view, page, pageSize });
  // 稳定引用：focus 命中判断与列表渲染共用同一份数组，避免每渲染都新建
  const items = useMemo(() => list.data?.items ?? [], [list.data]);

  // focus 命中即视为"已打开"：不额外 setState（派生值），关闭时清掉 focusId 即可
  const focusedItem =
    focusId !== null && selected === null
      ? findApprovalItem(items, focusId)
      : null;
  const activeItem = selected ?? focusedItem;

  const changeView = (next: string) => {
    const tab = VIEW_TABS.find((item) => item.value === next);
    if (!tab) return;
    setView(tab.value);
    setPage(1);
    setFocusId(null);
  };

  const closeDetail = () => {
    setSelected(null);
    setFocusId(null);
  };

  const focusMissed =
    focusId !== null &&
    !list.isLoading &&
    activeItem === null &&
    items.every((item) => item.id !== focusId);

  const openDetail = (item: ApprovalItem) => {
    setFocusId(null);
    setSelected(item);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="审批"
        description="已确认订单的货物明细变更在这里审批：点开看新旧明细对比与受影响单证，批准后才应用并重算金额。"
      />

      <SectionCard
        title={`审批列表（共 ${list.data?.total ?? 0} 条）`}
        description={VIEW_HINT[view]}
      >
        <Tabs value={view} onValueChange={changeView}>
          <TabsList variant="line" aria-label="审批视图">
            {VIEW_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="mt-4">
          {list.isLoading ? (
            <div
              className="space-y-2"
              aria-busy="true"
              aria-label="审批列表加载中"
            >
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : list.isError ? (
            <div className="space-y-3 py-8 text-sm">
              <p className="flex items-center gap-2 text-destructive">
                <AlertCircle className="size-4" />
                读取审批列表失败。请确认后端服务已启动，或稍后重试。
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void list.refetch()}
              >
                重新加载
              </Button>
            </div>
          ) : items.length === 0 ? (
            <>
              {focusMissed ? (
                <p className="mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
                  <AlertCircle className="size-4 shrink-0" />
                  没有找到通知对应的申请（可能已处理或不在当前视图）。
                </p>
              ) : null}
              <EmptyState
                icon={Inbox}
                title={EMPTY_COPY[view].title}
                description={EMPTY_COPY[view].description}
                action={
                  view === "pending" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => changeView("mine")}
                    >
                      查看我发起的
                    </Button>
                  ) : view === "mine" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => changeView("pending")}
                    >
                      查看待我审批
                    </Button>
                  ) : undefined
                }
              />
            </>
          ) : (
            <>
              <ApprovalListTable items={items} onOpen={openDetail} />
              <PaginationBar
                page={list.data?.page ?? page}
                pageSize={list.data?.page_size ?? pageSize}
                total={list.data?.total ?? items.length}
                currentCount={items.length}
                loading={list.isFetching}
                onPageChange={setPage}
                ariaLabel="审批列表分页"
              />
            </>
          )}
        </div>
      </SectionCard>

      <ApprovalDetailDrawer
        item={activeItem}
        canDecide={view === "pending" && activeItem?.status === "pending"}
        currentUserId={currentUserId}
        onClose={closeDetail}
      />
    </div>
  );
}
