"use client";

/**
 * 品名对照维护（C36 #19）：搜索已有对照 + 新增中英品名。
 *
 * **契约缺口（必须让用户看见）**：后端只有
 * `GET /market/name-lookup?q=` 与 `POST /market/name-mappings`，
 * **没有全量列表 / PATCH / DELETE** ⇒ 本界面只能「关键词搜索 + 新增」；
 * 修改/删除必须等后端补接口，前端不伪造 PATCH（审计 `API_RESERVED_LIST_AUDIT.md` #19）。
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { LoadingBlock } from "@/components/shared/loading-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { normalizeApiError } from "@/lib/api/api-error";
import { apiClient } from "@/lib/api/client";
import {
  buildNameMappingRows,
  describeDuplicate,
  EMPTY_NAME_MAPPING_DRAFT,
  isDuplicateMapping,
  validateNameMappingDraft,
  type ExistingNameMapping,
  type NameMappingDraft,
  type NameMappingRowInput,
} from "@/lib/market/name-mapping";

interface NameMapping extends ExistingNameMapping {
  alt_names: string[] | null;
  hs_code: string | null;
  is_verified: boolean;
  confidence: string | null;
}

async function lookupMappings(
  q: string,
  region?: string,
): Promise<NameMapping[]> {
  const params = new URLSearchParams({ q });
  if (region) params.set("region_code", region);
  const { data } = await apiClient.get<NameMapping[]>(
    `/market/name-lookup?${params.toString()}`,
  );
  return data;
}

/** 后端错误 → 可读文案；500 多半是唯一约束命中（后端未把它包成 409）。 */
function describeWriteError(error: unknown): string {
  const info = normalizeApiError(error);
  const text = info.message && info.message !== "请求失败，请稍后重试"
    ? info.message
    : "提交失败";
  if (info.status === 500) {
    return `${text}：可能是重复对照（同一地区 + 语言 + 类目只能一条）；请先搜索确认，或联系后端补 409 语义`;
  }
  if (info.status === 409) {
    return `${text}：已存在重复对照（地区 + 语言 + 类目）`;
  }
  if (info.status === 403) {
    return `${text}：没有权限维护品名对照`;
  }
  return text;
}

export function NameMappingPanel() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("");

  const regionsQuery = useQuery({
    queryKey: ["market", "regions"],
    queryFn: async () => {
      const { data } = await apiClient.get<string[]>("/market/regions");
      return data;
    },
  });
  const regions = regionsQuery.data ?? [];

  const lookupQuery = useQuery({
    queryKey: ["market", "name-lookup", q.trim(), region],
    queryFn: () => lookupMappings(q.trim(), region || undefined),
    enabled: q.trim().length > 0,
  });

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NameMappingDraft>(EMPTY_NAME_MAPPING_DRAFT);
  const [errors, setErrors] = useState<string[]>([]);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const openCreate = () => {
    setDraft({ ...EMPTY_NAME_MAPPING_DRAFT, regionCode: region });
    setErrors([]);
    setBackendError(null);
    setOpen(true);
  };

  const field = (key: keyof NameMappingDraft, value: string | boolean) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    setBackendError(null);
    const localErrors = validateNameMappingDraft(draft);
    setErrors(localErrors);
    if (localErrors.length > 0) return;

    const rows = buildNameMappingRows(draft);
    if (rows.length === 0) {
      setErrors(["中文品名或英文品名至少填一个"]);
      return;
    }
    setSubmitting(true);
    try {
      // 重复预检：后端无列表接口 ⇒ 用关键词查询逐行比对（同地区+同语言+同品名）
      const duplicates: NameMappingRowInput[] = [];
      for (const row of rows) {
        const existing = await lookupMappings(row.local_name, row.region_code);
        if (isDuplicateMapping(existing, row)) duplicates.push(row);
      }
      if (duplicates.length > 0) {
        setErrors(
          duplicates.map((r) => `已存在：${describeDuplicate(r)}，未提交`),
        );
        return;
      }

      const created: NameMappingRowInput[] = [];
      let writeError: string | null = null;
      for (const row of rows) {
        try {
          await apiClient.post("/market/name-mappings", row);
          created.push(row);
        } catch (error) {
          writeError = describeWriteError(error);
          break;
        }
      }
      if (created.length > 0) {
        toast.success(
          `已新增 ${created.length} 条品名对照${
            writeError ? "（部分失败）" : ""
          }`,
        );
        qc.invalidateQueries({ queryKey: ["market", "name-lookup"] });
        // 让列表立刻能看到刚录入的行
        setQ(created[0]!.local_name);
        setRegion(created[0]!.region_code);
      }
      if (writeError) {
        setBackendError(
          `${writeError}${
            created.length > 0
              ? `；已成功 ${created.length} 条，失败 ${rows.length - created.length} 条`
              : ""
          }`,
        );
        return;
      }
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative max-w-md flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="输入中/英品名搜索已有对照，如 chain link fence / 勾花网"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="搜索品名对照"
              />
            </div>
            <select
              aria-label="地区筛选"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            >
              <option value="">全部地区</option>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 size-4" />
              新增对照
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            后端目前只提供「关键词查询 + 新增」两个接口（无全量列表 / 修改 / 删除），
            所以这里用搜索查看已有对照；编辑与删除需后端补接口（C36 审计 #19）。
          </p>
        </CardContent>
      </Card>

      {q.trim() === "" ? (
        <p className="py-6 text-sm text-muted-foreground">
          输入中/英品名后显示对照结果；暂无全量列表接口。
        </p>
      ) : lookupQuery.isLoading ? (
        <LoadingBlock rows={3} />
      ) : lookupQuery.isError ? (
        <p className="py-4 text-sm text-destructive">
          查询失败：{normalizeApiError(lookupQuery.error).message}
        </p>
      ) : (lookupQuery.data ?? []).length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          未找到匹配；可点「新增对照」录入。
        </p>
      ) : (
        <div className="space-y-2">
          {(lookupQuery.data ?? []).map((r) => (
            <Card key={r.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-2 pt-4">
                <div>
                  <p className="font-medium">{r.local_name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {r.lang === "zh" ? "中文" : "英文"} · {r.region_code} · 类目 #
                    {r.category_id ?? "-"}
                    {r.hs_code ? ` · HS ${r.hs_code}` : ""}
                  </p>
                  {r.alt_names && r.alt_names.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {r.alt_names.map((a) => (
                        <Badge key={a} variant="outline" className="text-xs">
                          {a}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                {r.is_verified && <Badge>已核实</Badge>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>新增品名对照</DialogTitle>
            <DialogDescription>
              中英品名各自成行（表按语言区分）；同一地区 + 语言 + 类目只能一条。
              留空的英文/中文不会创建。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-sm font-medium">中文品名</span>
              <Input
                value={draft.localNameZh}
                placeholder="例如：勾花网"
                onChange={(e) => field("localNameZh", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">英文品名</span>
              <Input
                value={draft.localNameEn}
                placeholder="例如：chain link fence"
                onChange={(e) => field("localNameEn", e.target.value)}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-sm font-medium">地区 *</span>
                <select
                  aria-label="地区"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={draft.regionCode}
                  onChange={(e) => field("regionCode", e.target.value)}
                >
                  <option value="">请选择地区</option>
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-medium">类目 id（可选）</span>
                <Input
                  inputMode="numeric"
                  value={draft.categoryId}
                  placeholder="如 3"
                  onChange={(e) => field("categoryId", e.target.value)}
                />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-sm font-medium">别名（逗号分隔，可选）</span>
              <Input
                value={draft.altNames}
                placeholder="例如：malla, wire mesh fence"
                onChange={(e) => field("altNames", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">HS 编码（可选）</span>
              <Input
                value={draft.hsCode}
                placeholder="例如：7314.41"
                onChange={(e) => field("hsCode", e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.isVerified}
                onChange={(e) => field("isVerified", e.target.checked)}
              />
              已核实（is_verified）
            </label>

            {errors.length > 0 && (
              <ul className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {backendError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {backendError}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? "提交中…" : "保存对照"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
