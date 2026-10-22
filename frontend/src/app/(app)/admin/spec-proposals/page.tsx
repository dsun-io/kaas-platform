"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";
import { AsyncButton } from "@/components/shared";
import { useAsyncAction } from "@/lib/hooks/use-async-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, CheckCircle, XCircle, GitMerge } from "lucide-react";
import { PageHeader } from "@/components/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RouteGuard } from "@/components/route-guard";

interface Proposal {
  id: number;
  tenant_id: string;
  category_id: number;
  proposed_name: string;
  proposed_type: string;
  group_code: string;
  status: string;
  occurrence_count: number;
  recommended_for_promotion: boolean;
  recommendation_score: number | null;
  created_at: string | null;
  recommended_at?: string | null;
}

type TabType = "recommended" | "all";

/**
 * 属性提案审核页 —— 方案 2026-10-20 前后端对齐审计（P2-6）。
 *
 * 后端三条接口（`ws_admin_proposals.py:78/97/115`）都要 **internal + 管理员角色**，
 * 本页此前**没有任何 RouteGuard**（只靠侧栏 adminOnly）⇒ 任意登录用户直接输 URL 就能
 * 打开页面、然后连吃 3 个 403。这里补平台运营守卫，并把内容拆成子组件：
 * 守卫不通过时子组件不挂载，列表查询也不会发出去。
 */
export default function SpecProposalsPage() {
  return (
    <RouteGuard adminOnly>
      <SpecProposalsContent />
    </RouteGuard>
  );
}

function SpecProposalsContent() {
  const [activeTab, setActiveTab] = useState<TabType>("recommended");
  const [reviewDialog, setReviewDialog] = useState<{
    proposal: Proposal;
    action: "approve" | "reject" | "merge";
  } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");

  const qc = useQueryClient();

  // Recommended proposals
  const { data: recommended, isLoading: loadingRecommended } = useQuery({
    queryKey: queryKeys.proposals.recommended,
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: Proposal[] }>(
        "/admin/spec/attribute-proposals/recommended",
      );
      return data.items;
    },
  });

  // All pending proposals
  const { data: allProposals, isLoading: loadingAll } = useQuery({
    queryKey: queryKeys.proposals.list("pending"),
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: Proposal[] }>(
        "/admin/spec/attribute-proposals?status=pending",
      );
      return data.items;
    },
  });

  /**
   * P0-B2/SP1：审批 / 驳回 / 合并三个动作原本失败完全静默（mutation 无 onError）。
   * 统一走 `useAsyncAction`：失败写进弹窗内 `role="alert"`（拦截器已 toast，不重复），
   * pending 期间禁用确认/取消并禁止关窗（SP7：pending 中可关窗）。
   */
  const review = useAsyncAction(
    async (input: {
      id: number;
      action: string;
      note?: string;
      target_attribute_id?: number;
    }) => {
      const { data } = await apiClient.patch(
        `/admin/spec/attribute-proposals/${input.id}`,
        {
          action: input.action,
          note: input.note,
          target_attribute_id: input.target_attribute_id,
        },
      );
      return data;
    },
    {
      onSuccess: (_data, input) => {
        toast.success(
          input.action === "approve"
            ? "提案已晋升"
            : input.action === "merge"
              ? "提案已合并"
              : "提案已驳回",
        );
        qc.invalidateQueries({ queryKey: queryKeys.proposals.list("pending") });
        qc.invalidateQueries({ queryKey: queryKeys.proposals.recommended });
        setReviewDialog(null);
        setReviewNote("");
        setMergeTargetId("");
      },
    },
  );

  function handleReview() {
    if (!reviewDialog) return;
    void review.run({
      id: reviewDialog.proposal.id,
      action: reviewDialog.action,
      note: reviewNote || undefined,
      target_attribute_id:
        reviewDialog.action === "merge" ? Number(mergeTargetId) : undefined,
    });
  }

  const items = activeTab === "recommended" ? recommended : allProposals;
  const loading = activeTab === "recommended" ? loadingRecommended : loadingAll;

  return (
    <div className="space-y-6">
      <PageHeader
        title="属性提案审核"
        description="审核租户提交的新属性提案，晋升到公库"
      />

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "recommended" | "all")}
      >
        <TabsList variant="line">
          <TabsTrigger variant="line" value="recommended">
            推荐晋升 ({recommended?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger variant="line" value="all">
            全部待审 ({allProposals?.length ?? 0})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* List */}
      <Card>
        <CardContent className="py-4">
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : !items || items.length === 0 ? (
            <EmptyState
              title="暂无待审提案"
              description={`当前没有${activeTab === "recommended" ? "推荐晋升的" : "待审核的"}提案。`}
              className="border-0 py-8"
            />
          ) : (
            <div className="space-y-3">
              {items.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.proposed_name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted">
                        {p.proposed_type}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted">
                        {p.group_code}
                      </span>
                      {p.recommended_for_promotion && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-success-muted text-success-muted-foreground">
                          推荐晋升
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      租户: {p.tenant_id} | 类目: {p.category_id} | 出现:{" "}
                      {p.occurrence_count} 次
                      {p.recommendation_score != null && (
                        <> | 分数: {p.recommendation_score}</>
                      )}
                      {p.created_at && (
                        <> | 提交: {p.created_at.split("T")[0]}</>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-success hover:text-success/80"
                      onClick={() => {
                        setReviewDialog({ proposal: p, action: "approve" });
                        setReviewNote("");
                      }}
                    >
                      <CheckCircle className="h-4 w-4 mr-1" />
                      晋升
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReviewDialog({ proposal: p, action: "merge" });
                        setReviewNote("");
                        setMergeTargetId("");
                      }}
                    >
                      <GitMerge className="h-4 w-4 mr-1" />
                      合并
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        setReviewDialog({ proposal: p, action: "reject" });
                        setReviewNote("");
                      }}
                    >
                      <XCircle className="h-4 w-4 mr-1" />
                      驳回
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Review Dialog */}
      {reviewDialog && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v && !review.pending) setReviewDialog(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {reviewDialog.action === "approve"
                  ? "晋升属性"
                  : reviewDialog.action === "merge"
                    ? "合并到已有属性"
                    : "驳回提案"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <p className="text-sm">
                提案:{" "}
                <span className="font-medium">
                  {reviewDialog.proposal.proposed_name}
                </span>
                <span className="text-muted-foreground ml-2">
                  ({reviewDialog.proposal.proposed_type})
                </span>
              </p>

              {reviewDialog.action === "merge" && (
                <div className="space-y-2">
                  <Label>目标属性 ID *</Label>
                  <Input
                    type="number"
                    value={mergeTargetId}
                    onChange={(e) => setMergeTargetId(e.target.value)}
                    placeholder="输入要合并到的公库属性 ID"
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label>审核备注</Label>
                <Input
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  placeholder="可选"
                />
              </div>
            </div>
            {review.error ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                操作失败：{review.error}（弹窗保留，可重试或取消）
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setReviewDialog(null)}
                disabled={review.pending}
              >
                取消
              </Button>
              <AsyncButton
                variant={
                  reviewDialog.action === "reject" ? "destructive" : "default"
                }
                onClick={handleReview}
                disabled={reviewDialog.action === "merge" && !mergeTargetId}
                pending={review.pending}
                pendingLabel={
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    处理中...
                  </>
                }
              >
                {reviewDialog.action === "approve"
                  ? "确认晋升"
                  : reviewDialog.action === "merge"
                    ? "确认合并"
                    : "确认驳回"}
              </AsyncButton>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
