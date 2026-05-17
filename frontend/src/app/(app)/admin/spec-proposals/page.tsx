"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";
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

export default function SpecProposalsPage() {
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

  const reviewMutation = useMutation({
    mutationFn: async ({
      id,
      action,
      note,
      target_attribute_id,
    }: {
      id: number;
      action: string;
      note?: string;
      target_attribute_id?: number;
    }) => {
      const { data } = await apiClient.patch(
        `/admin/spec/attribute-proposals/${id}`,
        { action, note, target_attribute_id },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.proposals.list("pending") });
      qc.invalidateQueries({ queryKey: queryKeys.proposals.recommended });
      setReviewDialog(null);
      setReviewNote("");
      setMergeTargetId("");
    },
  });

  function handleReview() {
    if (!reviewDialog) return;
    reviewMutation.mutate({
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
      <div>
        <h1 className="text-2xl font-semibold">属性提案审核</h1>
        <p className="text-muted-foreground mt-1">
          审核租户提交的新属性提案，晋升到公库
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "recommended"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("recommended")}
        >
          推荐晋升 ({recommended?.length ?? 0})
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "all"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("all")}
        >
          全部待审 ({allProposals?.length ?? 0})
        </button>
      </div>

      {/* List */}
      <Card>
        <CardContent className="py-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              加载中...
            </div>
          ) : !items || items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              暂无{activeTab === "recommended" ? "推荐晋升的" : "待审核的"}提案
            </p>
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
                        <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">
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
                      className="text-green-600 hover:text-green-700"
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
        <Dialog open onOpenChange={(v) => !v && setReviewDialog(null)}>
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
            <DialogFooter>
              <Button variant="outline" onClick={() => setReviewDialog(null)}>
                取消
              </Button>
              <Button
                variant={
                  reviewDialog.action === "reject" ? "destructive" : "default"
                }
                onClick={handleReview}
                disabled={
                  reviewMutation.isPending ||
                  (reviewDialog.action === "merge" && !mergeTargetId)
                }
              >
                {reviewMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    处理中...
                  </>
                ) : reviewDialog.action === "approve" ? (
                  "确认晋升"
                ) : reviewDialog.action === "merge" ? (
                  "确认合并"
                ) : (
                  "确认驳回"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
