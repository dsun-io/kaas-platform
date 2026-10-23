"use client";

/**
 * 品名对照维护（C36 #19 → B2）：分页列表 + 编辑（PATCH）+ 删除（DELETE）+ 新增。
 *
 * 契约（`backend/worker/src/main.py:2030-2135`）：
 * - `GET /market/name-mappings?page=&page_size=&q=&region_code=&lang=`
 *   → `{items,total,page,page_size}`；**空 q = 最近记录**（不再要求先输关键词），
 *   q 匹配品名/别名 ILIKE；筛选变化回第 1 页；搜索仍 300ms 防抖（`useDebouncedValue`）；
 * - `PATCH /market/name-mappings/{id}`：部分字段，409 唯一冲突 / 404 不存在；
 * - `DELETE /market/name-mappings/{id}` → 204（404 不存在）；
 * - `POST /market/name-mappings`：中英各一行（形状不变，保留 create 流程）。
 *
 * 交互口径（ui:patterns / UI 规范）：
 * - 列表三态交给共享 `DataTable`（错误态可重试；不再裸 table / 纯文本状态）；
 * - 分页用共享 `PaginationBar`（page_size 20，total 用后端值，筛选后回第 1 页）；
 * - 删除走 `ConfirmDialog`：pending 期间不关闭，ref 兜住同一 tick 连点；
 * - 编辑在 Dialog 内（失败留弹窗、`role="alert"` 可原样重试），错误统一走 `useAsyncAction`。
 */
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PaginationBar } from "@/components/shared/pagination-bar";
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
import { useAsyncAction } from "@/lib/hooks/use-async-action";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { normalizeApiError } from "@/lib/api/api-error";
import { apiClient } from "@/lib/api/client";
import {
  buildNameMappingListQuery,
  buildNameMappingRows,
  describeDuplicate,
  EMPTY_NAME_MAPPING_DRAFT,
  isDuplicateMapping,
  NAME_MAPPING_PAGE_SIZE,
  pageAfterRemove,
  validateNameMappingDraft,
  type NameMappingDraft,
  type NameMappingListResponse,
  type NameMappingPatch,
  type NameMappingRow,
  type NameMappingRowInput,
} from "@/lib/market/name-mapping";
import { NameMappingEditDialog } from "./name-mapping-edit-dialog";

const LIST_QUERY_KEY = ["market", "name-mappings"] as const;

async function fetchNameMappings(
  query: Parameters<typeof buildNameMappingListQuery>[0],
): Promise<NameMappingListResponse> {
  // 路径写成字面量模板（而不是 helper 的返回值）—— `pnpm mocks:check` 靠字面量
  // 静态抽取前端调用；串进 helper 会被判成「mock 有但前端未调用」。
  const { data } = await apiClient.get<NameMappingListResponse>(
    `/market/name-mappings?${buildNameMappingListQuery(query)}`,
  );
  return data;
}

/** 后端错误 → 可读文案（409/404 是编辑/删除最常见的结果，不能吞成通用失败）。 */
function describeWriteError(error: unknown): string {
  const info = normalizeApiError(error);
  const text =
    info.message && info.message !== "请求失败，请稍后重试"
      ? info.message
      : "提交失败";
  if (info.status === 500) {
    return `${text}：可能是重复对照（同一地区 + 语言 + 类目只能一条）；请先搜索确认`;
  }
  if (info.status === 409) {
    return `${text}：已存在重复对照（地区 + 语言 + 类目）`;
  }
  if (info.status === 404) {
    return `${text}：该品名对照不存在，可能已被其他人删除`;
  }
  if (info.status === 403) {
    return `${text}：没有权限维护品名对照`;
  }
  return text;
}

interface SaveNameMappingArgs {
  id: number;
  patch: NameMappingPatch;
}

export function NameMappingPanel() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("");
  const [page, setPage] = useState(1);
  // M1：输入即时回显，检索用防抖值（不能每击键打一次列表）
  const debouncedQ = useDebouncedValue(q, 300);
  const trimmedQ = debouncedQ.trim();

  // 筛选（防抖后的关键词 / 地区）一变就回第 1 页。
  // 用**渲染期归位**而不是 useEffect：effect 会先按「新筛选 + 旧页码」发一次请求，
  // 再回第 1 页发第二次（一次搜索两次请求，且第一份结果是错的）。
  const [prevFilter, setPrevFilter] = useState({ q: trimmedQ, region });
  if (prevFilter.q !== trimmedQ || prevFilter.region !== region) {
    setPrevFilter({ q: trimmedQ, region });
    setPage(1);
  }

  const regionsQuery = useQuery({
    queryKey: ["market", "regions"],
    queryFn: async () => {
      const { data } = await apiClient.get<string[]>("/market/regions");
      return data;
    },
  });
  const regions = regionsQuery.data ?? [];

  const listQuery = useQuery<NameMappingListResponse>({
    queryKey: [...LIST_QUERY_KEY, page, trimmedQ, region],
    queryFn: () =>
      fetchNameMappings({
        page,
        pageSize: NAME_MAPPING_PAGE_SIZE,
        q: trimmedQ,
        regionCode: region,
      }),
    // 翻页时保留上一页内容，避免表格闪成骨架屏（v5 的 keepPreviousData 等价写法）
    placeholderData: (previous) => previous,
  });
  const rows = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;

  const invalidateList = () =>
    qc.invalidateQueries({ queryKey: [...LIST_QUERY_KEY] });

  // 筛选变化回第 1 页由上面的渲染期归位统一处理（含防抖落地那一刻）
  const changeSearch = (value: string) => setQ(value);
  const changeRegion = (value: string) => setRegion(value);

  // ── 编辑（PATCH）──────────────────────────────────────────────────
  const [editing, setEditing] = useState<NameMappingRow | null>(null);
  const savingRef = useRef(false);
  const saveAction = useAsyncAction(
    async ({ id, patch }: SaveNameMappingArgs) => {
      const { data } = await apiClient.patch<NameMappingRow>(
        `/market/name-mappings/${id}`,
        patch,
      );
      return data;
    },
    {
      errorMessage: describeWriteError,
      onSuccess: () => {
        toast.success("已保存品名对照");
        setEditing(null);
        void invalidateList();
      },
    },
  );

  const openEdit = (row: NameMappingRow) => {
    saveAction.reset();
    setEditing(row);
  };
  const closeEdit = () => {
    if (saveAction.pending) return;
    setEditing(null);
    saveAction.reset();
  };
  /** `savingRef` 兜住同一 tick 连点两次保存（pending 状态要等下一次渲染才生效）。 */
  const submitEdit = async (patch: NameMappingPatch) => {
    if (!editing || savingRef.current) return;
    savingRef.current = true;
    try {
      await saveAction.run({ id: editing.id, patch });
    } finally {
      savingRef.current = false;
    }
  };

  // ── 删除（DELETE）─────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<NameMappingRow | null>(null);
  const deletingRef = useRef(false);
  const deleteAction = useAsyncAction(
    async (id: number) => {
      await apiClient.delete(`/market/name-mappings/${id}`);
      return id;
    },
    {
      errorMessage: describeWriteError,
      onSuccess: () => {
        toast.success("已删除品名对照");
        setDeleteTarget(null);
        // 删掉本页最后一条时回退一页，不把用户留在空页
        const nextPage = pageAfterRemove(page, rows.length);
        if (nextPage !== page) setPage(nextPage);
        void invalidateList();
      },
    },
  );

  const requestDelete = (row: NameMappingRow) => {
    deleteAction.reset();
    setDeleteTarget(row);
  };
  const confirmDelete = async () => {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    try {
      await deleteAction.run(deleteTarget.id);
    } finally {
      deletingRef.current = false;
    }
  };

  // ── 新增（POST，中英各一行）──────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NameMappingDraft>(
    EMPTY_NAME_MAPPING_DRAFT,
  );
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

    const rowsToCreate = buildNameMappingRows(draft);
    if (rowsToCreate.length === 0) {
      setErrors(["中文品名或英文品名至少填一个"]);
      return;
    }
    setSubmitting(true);
    try {
      // 重复预检：用**分页列表**按品名/地区查已有行（同地区 + 同语言 + 同品名）
      const duplicates: NameMappingRowInput[] = [];
      for (const row of rowsToCreate) {
        const existing = await fetchNameMappings({
          page: 1,
          pageSize: 100,
          q: row.local_name,
          regionCode: row.region_code,
        });
        if (isDuplicateMapping(existing.items, row)) duplicates.push(row);
      }
      if (duplicates.length > 0) {
        setErrors(
          duplicates.map((r) => `已存在：${describeDuplicate(r)}，未提交`),
        );
        return;
      }

      const created: NameMappingRowInput[] = [];
      let writeError: string | null = null;
      for (const row of rowsToCreate) {
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
          `已新增 ${created.length} 条品名对照${writeError ? "（部分失败）" : ""}`,
        );
        void invalidateList();
        // 让列表立刻能看到刚录入的行（写库后 q 命中它自己；归位由过滤变化自动回第 1 页）
        setQ(created[0]!.local_name);
        setRegion(created[0]!.region_code);
      }
      if (writeError) {
        setBackendError(
          `${writeError}${
            created.length > 0
              ? `；已成功 ${created.length} 条，失败 ${rowsToCreate.length - created.length} 条`
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

  const columns: DataTableColumn<NameMappingRow>[] = [
    {
      key: "local_name",
      header: "品名",
      render: (row) => (
        <div className="space-y-1">
          <p className="font-medium">{row.local_name}</p>
          {row.alt_names && row.alt_names.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {row.alt_names.map((alt) => (
                <Badge key={alt} variant="outline" className="text-xs">
                  {alt}
                </Badge>
              ))}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "lang",
      header: "语言",
      render: (row) => (row.lang === "zh" ? "中文" : "英文"),
    },
    { key: "region_code", header: "地区" },
    {
      key: "category_id",
      header: "类目",
      render: (row) => (row.category_id == null ? "—" : `#${row.category_id}`),
    },
    {
      key: "hs_code",
      header: "HS 编码",
      render: (row) => row.hs_code ?? "—",
    },
    {
      key: "is_verified",
      header: "核实",
      render: (row) =>
        row.is_verified ? (
          <Badge>已核实</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">未核实</span>
        ),
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`编辑 ${row.local_name}`}
            onClick={() => openEdit(row)}
          >
            <Pencil className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`删除 ${row.local_name}`}
            onClick={() => requestDelete(row)}
          >
            <Trash2 className="size-4 text-destructive" aria-hidden="true" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative max-w-md flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="输入中/英品名搜索，如 chain link fence / 勾花网（留空看最近记录）"
                value={q}
                onChange={(e) => changeSearch(e.target.value)}
                aria-label="搜索品名对照"
              />
            </div>
            <select
              aria-label="地区筛选"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={region}
              onChange={(e) => changeRegion(e.target.value)}
            >
              <option value="">全部地区</option>
              {regions.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 size-4" />
              新增对照
            </Button>
            {listQuery.isSuccess && (
              <span className="text-xs text-muted-foreground">
                共 {total} 条
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            caption="品名对照列表"
            // 防抖窗口内（输入已变、检索未发）也按加载态处理，避免闪一下「未找到」
            loading={listQuery.isLoading || q.trim() !== trimmedQ}
            errorSlot={
              listQuery.isError ? (
                <ErrorState
                  title="品名对照查询失败"
                  message={normalizeApiError(listQuery.error).message}
                  onRetry={() => void listQuery.refetch()}
                />
              ) : undefined
            }
            emptySlot={
              <EmptyState
                title={
                  trimmedQ || region ? "未找到匹配的品名对照" : "还没有品名对照"
                }
                description="换个关键词/地区，或点「新增对照」录入。"
                className="border-0 py-8"
              />
            }
            paginationSlot={
              <PaginationBar
                page={page}
                pageSize={NAME_MAPPING_PAGE_SIZE}
                total={total}
                currentCount={rows.length}
                onPageChange={setPage}
                loading={listQuery.isFetching}
                ariaLabel="品名对照分页"
              />
            }
          />
        </CardContent>
      </Card>

      {editing && (
        <NameMappingEditDialog
          key={editing.id}
          row={editing}
          regions={regions}
          pending={saveAction.pending}
          error={saveAction.error}
          onSubmit={(patch) => void submitEdit(patch)}
          onClose={closeEdit}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          // pending 期间不关闭（提交中点到遮罩/Esc 也不能中断）
          if (!next && !deleteAction.pending && !deletingRef.current) {
            setDeleteTarget(null);
            deleteAction.reset();
          }
        }}
        title={`删除「${deleteTarget?.local_name ?? ""}」？`}
        description="删除后该品名对照立即失效（品名反查/报价匹配不再命中），且不可恢复。"
        confirmLabel="确认删除"
        pending={deleteAction.pending}
        error={deleteAction.error}
        onConfirm={() => void confirmDelete()}
      />

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
            <label htmlFor="name-mapping-create-zh" className="block space-y-1">
              <span className="text-sm font-medium">中文品名</span>
              <Input
                id="name-mapping-create-zh"
                value={draft.localNameZh}
                placeholder="例如：勾花网"
                onChange={(e) => field("localNameZh", e.target.value)}
              />
            </label>
            <label htmlFor="name-mapping-create-en" className="block space-y-1">
              <span className="text-sm font-medium">英文品名</span>
              <Input
                id="name-mapping-create-en"
                value={draft.localNameEn}
                placeholder="例如：chain link fence"
                onChange={(e) => field("localNameEn", e.target.value)}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label
                htmlFor="name-mapping-create-region"
                className="block space-y-1"
              >
                <span className="text-sm font-medium">地区 *</span>
                <select
                  id="name-mapping-create-region"
                  aria-label="地区"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={draft.regionCode}
                  onChange={(e) => field("regionCode", e.target.value)}
                >
                  <option value="">请选择地区</option>
                  {regions.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </label>
              <label
                htmlFor="name-mapping-create-category"
                className="block space-y-1"
              >
                <span className="text-sm font-medium">类目 id（可选）</span>
                <Input
                  id="name-mapping-create-category"
                  inputMode="numeric"
                  value={draft.categoryId}
                  placeholder="如 3"
                  onChange={(e) => field("categoryId", e.target.value)}
                />
              </label>
            </div>
            <label
              htmlFor="name-mapping-create-alt"
              className="block space-y-1"
            >
              <span className="text-sm font-medium">
                别名（逗号分隔，可选）
              </span>
              <Input
                id="name-mapping-create-alt"
                value={draft.altNames}
                placeholder="例如：malla, wire mesh fence"
                onChange={(e) => field("altNames", e.target.value)}
              />
            </label>
            <label htmlFor="name-mapping-create-hs" className="block space-y-1">
              <span className="text-sm font-medium">HS 编码（可选）</span>
              <Input
                id="name-mapping-create-hs"
                value={draft.hsCode}
                placeholder="例如：7314.41"
                onChange={(e) => field("hsCode", e.target.value)}
              />
            </label>
            <label
              htmlFor="name-mapping-create-verified"
              className="flex items-center gap-2 text-sm"
            >
              <input
                id="name-mapping-create-verified"
                type="checkbox"
                checked={draft.isVerified}
                onChange={(e) => field("isVerified", e.target.checked)}
              />
              已核实（is_verified）
            </label>

            {errors.length > 0 && (
              <ul
                role="alert"
                className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                {errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
            {backendError && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
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
