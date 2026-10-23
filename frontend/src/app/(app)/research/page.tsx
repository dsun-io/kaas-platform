"use client";

/**
 * 市场调研工位（U-P1D2：拆分后只剩「状态编排 + 数据 hooks 接线」）。
 * 视图在 ./components、数据/类型/文案/常量/CSV 在 ./lib。
 * 口径不变：防抖 300ms、分页、导出逐页拉全量、tone 走 status-tones、
 * 编辑失败留弹窗、移除二次确认。
 */
import { useRef, useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionCard, ConfirmDialog } from "@/components/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { normalizeApiError } from "@/lib/api/api-error";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Download, Plus } from "lucide-react";

import { ManualResearchDialog } from "./components/manual-research-dialog";
import {
  ResearchEditDialog,
  type ResearchEditValue,
} from "./components/research-edit-dialog";
import { ResearchStatsCards } from "./components/research-stats";
import { ResearchFilters } from "./components/research-filters";
import { ResearchProductsTable } from "./components/research-products-table";
import { ResearchPickSection } from "./components/research-pick-section";
import { ResearchRunsSection } from "./components/research-runs-section";
import { useExportResearch } from "./lib/use-export-research";
import { useResearchData } from "./lib/use-research-data";
import type { ResearchProduct, TabKey } from "./lib/types";

const TABS: { key: TabKey; label: string }[] = [
  { key: "products", label: "调研产品" },
  { key: "pick", label: "从地图源挑选" },
  { key: "runs", label: "运行历史" },
];

export default function ResearchPage() {
  usePageView({ resource_id: "/research" });
  const qc = useQueryClient();

  const [tab, setTab] = useState<TabKey>("products");
  const [search, setSearch] = useState("");
  // R49：搜索防抖（300ms）—— 输入即时回显，但只有停止输入后才发请求
  const debouncedSearch = useDebouncedValue(search, 300);
  const [country, setCountry] = useState("");
  const [category, setCategory] = useState("");
  const [canSupply, setCanSupply] = useState("");
  // R50：分页（后端 /research/products 支持 page/page_size；原来 page_size=200 硬编码无分页）
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ResearchProduct | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [picking, setPicking] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // P0-B1：移除调研产品不可恢复（深化数据一起没了）⇒ 二次确认 + 提交中禁用
  const [deleteTarget, setDeleteTarget] = useState<ResearchProduct | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletingRef = useRef(false);
  // P0-B4：深化记录保存的 pending 防重（R51）
  const [savingEdit, setSavingEdit] = useState(false);
  const savingEditRef = useRef(false);
  // U-P0B6/X4：编辑改为 Dialog（草稿独立于列表）；保存失败留在弹窗内
  const [saveError, setSaveError] = useState<string | null>(null);
  const editOpenerRef = useRef<HTMLElement | null>(null);

  /* ── 数据层（列表/统计/挑选/运行历史；口径集中在 lib/use-research-data） ── */
  const {
    stats,
    categories,
    countryOptions,
    products,
    productsTotal,
    productsFetching,
    fetchProductPage,
    leads,
    leadsTotal,
    leadsLoading,
    runs,
  } = useResearchData({
    tab,
    createOpen,
    debouncedSearch,
    country,
    category,
    canSupply,
    page,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["research-products"] });
    qc.invalidateQueries({ queryKey: ["research-stats"] });
    qc.invalidateQueries({ queryKey: ["research-runs"] });
  };

  /** R48：导出**全部筛选结果**（逐页拉完再写 CSV；行为/提示在 lib hook 内）。 */
  const { exporting, exportAll } = useExportResearch({
    fetchPage: fetchProductPage,
    listCount: products.length,
  });

  /** 打开编辑弹窗：记录触发按钮，关闭时归还焦点。 */
  const openEdit = (product: ResearchProduct, opener?: HTMLElement | null) => {
    editOpenerRef.current = opener ?? null;
    setSaveError(null);
    setEditing(product);
  };

  const closeEdit = () => {
    setEditing(null);
    setSaveError(null);
    // 焦点归还：对话框由父组件直接卸载（不走 Dialog 的 close 生命周期），
    // 不能依赖其焦点恢复；下一 tick 把焦点还给触发按钮。
    const opener = editOpenerRef.current;
    if (!opener) return;
    window.setTimeout(() => {
      if (opener.isConnected) opener.focus();
    }, 0);
  };

  /** 保存弹窗里的草稿（失败写回弹窗内错误，不关闭弹窗）。 */
  const saveEdit = async (draft: ResearchEditValue) => {
    if (savingEditRef.current) return;
    savingEditRef.current = true;
    setSavingEdit(true);
    setSaveError(null);
    try {
      await apiClient.patch(`/research/products/${draft.id}`, {
        product_name_cn: draft.product_name_cn || null,
        product_category: draft.product_category || null,
        price_local: draft.price_local,
        price_currency: draft.price_currency || null,
        market_note: draft.market_note || null,
        can_supply: draft.can_supply,
        supply_notes: draft.supply_notes || null,
      });
      toast.success("已保存");
      setEditing(null);
      refresh();
    } catch (err) {
      setSaveError(normalizeApiError(err).message);
    } finally {
      savingEditRef.current = false;
      setSavingEdit(false);
    }
  };

  /**
   * P0-B1：移除是**不可恢复**动作（深化数据：中文名/规格/税率/备注一起消失）。
   * 先弹确认；`deletingRef` 兜住连点（`deleting` 状态要等下一次渲染才生效）。
   */
  const remove = async () => {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.delete(`/research/products/${deleteTarget.id}`);
      toast.success("已从调研集中移除");
      setDeleteTarget(null);
      refresh();
    } catch (err) {
      setDeleteError(normalizeApiError(err).message);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  /** 打开移除确认（清空上一轮错误）。 */
  const requestDelete = (product: ResearchProduct) => {
    setDeleteError(null);
    setDeleteTarget(product);
  };

  const pickFromLeadgen = async () => {
    if (picked.length === 0) {
      toast.error("请至少选择一条线索");
      return;
    }
    setPicking(true);
    try {
      const { data } = await apiClient.post<{
        created: number;
        skipped: number;
        scanned: number;
      }>("/research/from-leadgen", { lead_ids: picked });
      toast.success(
        `已挑选 ${data.created} 条（跳过 ${data.skipped} 条已在调研集中的）`,
      );
      setPicked([]);
      refresh();
      setTab("products");
    } catch {
      toast.error("挑选失败");
    } finally {
      setPicking(false);
    }
  };

  const togglePicked = (id: number, checked: boolean) => {
    setPicked((prev) =>
      checked ? [...prev, id] : prev.filter((x) => x !== id),
    );
  };

  return (
    <RouteGuard>
      <PageHeader
        title="市场调研"
        description="从地图源中挑选有价值的记录并深化：规格、价格、供货能力"
      />
      <div className="space-y-6 p-6">
        <ResearchStatsCards stats={stats} />

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList variant="line">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} variant="line" value={t.key}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {tab === "products" && (
          <SectionCard
            title={`产品 (${productsTotal})`}
            action={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="mr-1 h-4 w-4" /> 手工录入
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void exportAll()}
                  disabled={exporting || productsTotal === 0}
                >
                  <Download className="mr-1 h-4 w-4" />{" "}
                  {exporting ? "导出中…" : "导出 CSV"}
                </Button>
              </div>
            }
          >
            <ResearchFilters
              search={search}
              country={country}
              category={category}
              canSupply={canSupply}
              countryOptions={countryOptions}
              categories={categories}
              onSearchChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              onCountryChange={(v) => {
                setCountry(v);
                setPage(1);
              }}
              onCategoryChange={(v) => {
                setCategory(v);
                setPage(1);
              }}
              onCanSupplyChange={(v) => {
                setCanSupply(v);
                setPage(1);
              }}
            />

            <ResearchProductsTable
              products={products}
              total={productsTotal}
              page={page}
              isFetching={productsFetching}
              onPageChange={setPage}
              onEdit={openEdit}
              onDelete={requestDelete}
            />
          </SectionCard>
        )}

        {tab === "pick" && (
          <ResearchPickSection
            leads={leads}
            total={leadsTotal}
            picked={picked}
            picking={picking}
            onToggle={togglePicked}
            onPick={pickFromLeadgen}
          />
        )}

        {tab === "runs" && <ResearchRunsSection runs={runs} />}
      </div>

      <ManualResearchDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        categories={categories}
        leads={leads}
        leadsLoading={leadsLoading}
        onCreated={() => {
          refresh();
          setTab("products");
        }}
      />

      {/* U-P0B6/X4：编辑改为 Dialog（草稿独立于列表，失败留弹窗可重试） */}
      {editing && (
        <ResearchEditDialog
          key={editing.id}
          product={editing}
          categories={categories}
          pending={savingEdit}
          error={saveError}
          onSubmit={(draft) => void saveEdit(draft)}
          onClose={closeEdit}
        />
      )}

      {/* P0-B1：移除二次确认（深化数据不可恢复） */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletingRef.current) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        title={`从调研集移除「${deleteTarget?.product_name_cn ?? deleteTarget?.product_name ?? ""}」？`}
        description="移除后该产品的深化数据（中文名、规格、进项税/退税率、备注）会一并删除且不可恢复；如果只是暂时不需要，建议保留记录。"
        confirmLabel="确认移除"
        pending={deleting}
        error={deleteError}
        onConfirm={() => void remove()}
      />
    </RouteGuard>
  );
}
