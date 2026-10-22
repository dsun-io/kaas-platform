"use client";

/**
 * 单证工位数据层
 *
 * queryKey 统一用 `["trade-docs", ...]` 前缀，便于跨页面精确失效
 * （例如在订单工位开单后，单证台账要刷新）。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { customerRecordsKeys } from "@/lib/customer/use-customer-records";
import type { RenderCheckSummary } from "@/lib/trade-doc/render-check";
import type {
  TranslateRequest,
  TranslateResponse,
} from "@/lib/trade-doc/translate";

// 只引**类型**（编译期擦除，不产生 hook ↔ 组件的运行时依赖环）：
// 指纹形状的定义真源在 `doc-preview.tsx` 的 `RenderFingerprintMeta`。
import type { RenderFingerprintMeta } from "../components/doc-preview";

export interface TradeDocSourceSnapshot {
  order_no?: string;
  quote_no?: string;
  customer_name?: string;
  currency?: string;
  total_amount?: number | null;
  incoterm?: string | null;
  payment_terms?: string | null;
  port_of_loading?: string | null;
  port_of_destination?: string | null;
  shipping_marks?: string | null;
  country_of_origin?: string | null;
  items?: Record<string, unknown>[];
}

export interface TradeDocRow {
  id: number;
  doc_no: string;
  doc_type: string;
  order_id: number | null;
  customer_id: string | null;
  status: string;
  currency: string;
  total_amount: number | null;
  issued_at: string | null;
  issued_by: string | null;
  raw_payload: {
    sources?: Record<string, TradeDocSourceSnapshot>;
    custom?: Record<string, unknown>;
  } | null;
  /** 单证号当前是否可改（同一链条上没有更晚单证） */
  doc_no_editable?: boolean;
  /**
   * 最近一次**定时对账**结论（TODO(TODO:A8/A9)）：`null` = 从未对账（不冒充"没问题"）。
   * 列表端点 join `trade_doc_render_checks` 后挂上来，仅用于展示"已变更"标识。
   */
  render_check?: RenderCheckSummary | null;
  created_at: string | null;
}

export interface TradeDocList {
  items: TradeDocRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface TradeDocRenderData {
  doc: TradeDocRow;
  /** 已装配好的渲染数据（卖方/买方/货物/条款/金额），直接交给 renderTradeDoc */
  data: Record<string, unknown>;
  company_profile_configured: boolean;
}

export interface CompanyProfile {
  name_en: string | null;
  name_zh: string | null;
  address_en: string | null;
  address_zh: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  /** 公司税号（统一社会信用代码/纳税人识别号）：单据上的 Tax ID / Beneficiary Tax ID */
  tax_id: string | null;
  /** 英文开户行（印在英文单据上） */
  bank_name: string | null;
  /** 英文银行地址（印在英文单据上） */
  bank_address_en: string | null;
  bank_account: string | null;
  swift_code: string | null;
  /** 中文开户行（仅内部参考，不印单据；英文手填，不做 AI 翻译） */
  bank_name_zh: string | null;
  /** 中文银行地址（仅内部参考，不印单据） */
  bank_address_zh: string | null;
  logo_url: string | null;
  default_incoterm: string | null;
  default_payment_terms: string | null;
  default_country_of_origin: string | null;
  configured: boolean;
  updated_at?: string | null;
}

export interface TradeDocFilters {
  doc_type?: string;
  status?: string;
  page?: number;
  page_size?: number;
}

/**
 * 台账每页条数（内核 `GET /trade-docs` 的 page_size 默认 20、上限 200）。
 *
 * 历史问题（审计 T3）：页面写死 `page_size: 100` 且 total 取了不用 ⇒ 超过 100 张
 * 单证时**后边的永远看不到**，也没有翻页入口。现在走标准分页。
 */
export const TRADE_DOCS_PAGE_SIZE = 20;

/** 导出时每页取 200（后端上限），把"导出"与"当前页"解耦：导出的是**全部筛选结果**。 */
export const TRADE_DOCS_EXPORT_PAGE_SIZE = 200;

export const tradeDocKeys = {
  all: ["trade-docs"] as const,
  list: (filters: TradeDocFilters) => ["trade-docs", "list", filters] as const,
  detail: (id: number) => ["trade-docs", "detail", id] as const,
  renderData: (id: number) => ["trade-docs", "render-data", id] as const,
  companyProfile: ["company-profile"] as const,
};

export function useTradeDocs(filters: TradeDocFilters = {}) {
  return useQuery({
    queryKey: tradeDocKeys.list(filters),
    queryFn: async () => {
      const { data } = await apiClient.get<TradeDocList>("/trade-docs", {
        params: filters,
        // 筛选/翻页失败由页面显式渲染错误态；不额外弹全局 toast
        silent: true,
      });
      return data;
    },
    // 翻页时保留上一页，表格不闪成骨架屏（与订单/事件列表同口径）
    placeholderData: (previous) => previous,
  });
}

/**
 * 取**全部筛选结果**（导出用）：按 page_size=200 逐页拉，直到凑满 total / 空页。
 *
 * 为什么导出不能直接用当前页 `rows`：台账接分页后一页只有 20 条，直接导会把
 * "导出 CSV"偷偷变成"导出本页"，用户拿到的台账缺行且无从察觉。
 * 这里只在点击导出时多打几次请求，不污染列表查询。
 */
export async function fetchAllTradeDocs(
  filters: Pick<TradeDocFilters, "doc_type" | "status"> = {},
): Promise<TradeDocRow[]> {
  const base = {
    ...(filters.doc_type ? { doc_type: filters.doc_type } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
  const all: TradeDocRow[] = [];
  // 防御性上限：避免后端 total 异常（例如 0 但始终返回满页）导致死循环
  for (let page = 1; page <= 50; page += 1) {
    const { data } = await apiClient.get<TradeDocList>("/trade-docs", {
      params: { ...base, page, page_size: TRADE_DOCS_EXPORT_PAGE_SIZE },
      silent: true,
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    all.push(...items);
    const total = Number(data?.total ?? 0);
    if (items.length === 0) break;
    if (Number.isFinite(total) && all.length >= total) break;
    if (items.length < TRADE_DOCS_EXPORT_PAGE_SIZE) break;
  }
  return all;
}

export function useTradeDocRenderData(id: number | null) {
  return useQuery({
    queryKey: tradeDocKeys.renderData(id ?? 0),
    enabled: id !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<TradeDocRenderData>(
        `/trade-docs/${id}/render-data`,
      );
      return data;
    },
  });
}

export interface CreateTradeDocInput {
  doc_type: string;
  order_id?: number | null;
  quote_order_id?: number | null;
  inquiry_id?: number | null;
  /**
   * 业务客户（外键，必填）。单证是"挂到某个客户名下的一张纸"：
   * 买方识别、客户页的往来记录树都靠它。数字 id 走 number，
   * 历史/mock 形态的非数字 id 原样传，由后端校验拒绝（不在本地造 NaN）。
   */
  customer_id?: number | string | null;
  currency?: string | null;
  raw_payload?: Record<string, unknown> | null;
  /**
   * 是否盖公司默认公章（开单表单「盖公司默认公章」勾选，默认 true）。
   * 后端据此在生成 PDF 时叠加默认章；没有默认章时后端不报错、只不盖章。
   */
  with_seal?: boolean;
}

export function useCreateTradeDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTradeDocInput) => {
      const { data } = await apiClient.post<TradeDocRow>("/trade-docs", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
      // 新开一张单证 = 某个客户的「往来记录」多一个节点，跨页面一起失效，
      // 否则客户页会展示到 30s 内的旧树
      qc.invalidateQueries({ queryKey: customerRecordsKeys.all });
    },
  });
}

/** 服务端签发自动上传的结果（TODO(TODO:F1) 方案 A；失败不回滚签发状态） */
export interface PdfArchiveResult {
  ok: boolean;
  status_code?: number;
  detail?: unknown;
  renderer?: string | null;
  bytes?: number;
  file_id?: number | null;
}

/** 更新手工填写内容（仅 draft 可改）或流转状态（draft → issued → void） */
export function useUpdateTradeDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: number;
      status?: string;
      doc_no?: string;
      raw_payload?: Record<string, unknown>;
      /** 签发时随请求提交的预览 HTML：服务端出 PDF 并归档（TODO(TODO:F1)） */
      html?: string;
      pdf_name?: string;
    }) => {
      const { data } = await apiClient.patch<
        TradeDocRow & { pdf_archive?: PdfArchiveResult }
      >(`/trade-docs/${id}`, body);
      return data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
      qc.invalidateQueries({ queryKey: tradeDocKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: tradeDocKeys.renderData(variables.id) });
    },
  });
}

/** 从上游（订单/报价）重新带入快照；仅 draft 可用，已签发单据已冻结 */
export function useRefreshSources() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await apiClient.post<{
        doc: TradeDocRow;
        sources: string[];
      }>(`/trade-docs/${id}/refresh-sources`);
      return data;
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
      qc.invalidateQueries({ queryKey: tradeDocKeys.renderData(id) });
    },
  });
}

/**
 * 单证字段「中译英」（A13）：`POST /trade-docs/{id}/translate`。
 *
 * 后端行为（`ws_docs_ext.py` `translate_trade_doc`）：
 * - **draft** 态：把返回的字段写回 `raw_payload.custom` 并记一条内容版本 ⇒ 需要失效
 *   `["trade-docs"]` 前缀（覆盖 detail / render-data / content-versions）；
 * - **非 draft**：只返回译文、**不写回**（前端据此提示"未写回（非草稿）"）；
 * - 无 AI：`path="template"`、字段原样返回 ⇒ UI 必须提示人工翻译。
 *
 * `silent: true`：翻译失败是业务结果（无 AI / Provider 全挂走 template，非错误），
 * 401/403 等真错误由面板如实显示，不让通用 toast 抢戏。
 */
export function useTranslateTradeDoc(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: TranslateRequest) => {
      const { data } = await apiClient.post<TranslateResponse>(
        `/trade-docs/${docId}/translate`,
        { fields: body.fields, target: body.target ?? "en" },
        { silent: true },
      );
      return data;
    },
    onSuccess: () => {
      // 写回只发生在 draft；但非 draft 也可能被别处改动 —— 统一失效一次，代价小
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
    },
  });
}

export function useCompanyProfile() {
  return useQuery({
    queryKey: tradeDocKeys.companyProfile,
    queryFn: async () => {
      const { data } = await apiClient.get<CompanyProfile>(
        "/tenant/company-profile",
      );
      return data;
    },
  });
}

export function useSaveCompanyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Partial<CompanyProfile> & { name_en: string },
    ) => {
      const { data } = await apiClient.put<CompanyProfile>(
        "/tenant/company-profile",
        input,
      );
      return data;
    },
    onSuccess: () => {
      // 企业信息变了 → 所有单据的抬头都变了，必须整体失效
      qc.invalidateQueries({ queryKey: tradeDocKeys.companyProfile });
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
    },
  });
}

/** 业务枚举字典（不变量 11：前后端共用同一份合法值，前端不得硬编码另一份） */
export function useEnum(
  name:
    | "doc_type"
    | "doc_status"
    | "currency"
    | "order_status"
    | "quote_status"
    | "shipment_status",
) {
  return useQuery({
    queryKey: ["enums", name],
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data } = await apiClient.get<Record<string, string[]>>("/enums");
      return data[name] ?? [];
    },
  });
}

// ── 单证挂的文件（产品图引用 / 客户盖章回传件 / 系统出的 PDF）─────────────────
// 契约真源：orchestrator `app/api/files.py`（Worker 侧镜像一致）。

export interface TradeDocFile {
  id: number;
  name: string;
  storage: string;
  content_type: string | null;
  version: number;
  supersedes_id: number | null;
  is_current: boolean;
  created_at: string | null;
  /** 关联行（trade_doc_files）本身的字段 */
  link_id: number;
  role: string;
  caption: string | null;
  sort_order: number;
}

export function useTradeDocFiles(docId: number | null) {
  return useQuery({
    queryKey: ["trade-docs", docId, "files"],
    enabled: docId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: TradeDocFile[] }>(
        `/trade-docs/${docId}/files`,
      );
      return data.items;
    },
  });
}

/** 上传并挂到单证（客户盖章回传走这条：再次上传 = 新版本上位、旧版留档）。 */
export function useUploadTradeDocFile(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      role?: string;
      name?: string;
      caption?: string;
    }) => {
      const form = new FormData();
      form.append("file", input.file);
      form.append("role", input.role ?? "stamp_scan");
      form.append("name", input.name ?? "");
      if (input.caption) form.append("caption", input.caption);
      const { data } = await apiClient.post(
        `/trade-docs/${docId}/files/upload`,
        form,
        {
          headers: { "Content-Type": "multipart/form-data" },
        },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trade-docs", docId, "files"] });
      qc.invalidateQueries({ queryKey: ["trade-docs"] });
    },
  });
}

/** 摘除引用（不删文件本身：文件是留档资料，只解绑） */
export function useDetachTradeDocFile(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (linkId: number) => {
      await apiClient.delete(`/trade-docs/${docId}/files/${linkId}`);
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["trade-docs", docId, "files"] }),
  });
}

/**
 * 取文件对象字节（导出后自检读归档 `render_pdf` 用）。
 *
 * 为什么走 axios 而不是 `<a href>` / `<img src>`：`/file-objects/{id}/content`
 * 要 Bearer 授权（A4 的短期直链只用于渲染期 `<img>`，不是给脚本取字节的通路）。
 */
export async function fetchFileObjectBytes(
  fileId: number,
): Promise<ArrayBuffer> {
  const res = await apiClient.get(`/file-objects/${fileId}/content`, {
    responseType: "arraybuffer",
  });
  return res.data as ArrayBuffer;
}

// ── 自动出 PDF（服务端无头浏览器出字节）→ 同一套落档链路 ─────────────────────

export interface RenderPdfResult {
  file: TradeDocFile;
  link: {
    id: number;
    role: string;
    caption: string | null;
    sort_order: number;
  };
  /** 实际用的渲染器：`binding`（生产 Worker 的 browser binding）/ `rest`（本地 orchestrator） */
  renderer: string;
  /** 本次生成的 PDF 字节数 —— 用于如实提示"存了多少" */
  bytes: number;
  /** 字节真实落点（s3 / inline），可审计 */
  storage: string;
}

/**
 * 自动出 PDF 并归档（服务端 Browser Rendering 出字节 → 复用既有落档链路）。
 *
 * 为什么入参是**与预览同源的那份 HTML**、而不是只给 docId：归档件必须是用户看到的那一版，
 * 服务端"再渲染一次"就会变成另一套排版（见 docs/TRADE_DOC_PDF_ARCHIVAL.md §四 风险 1）。
 *
 * 服务端未配置渲染器时返回 **503 `PDF_RENDERER_NOT_CONFIGURED`**（前端如实提示，
 * 不假装成功、不静默降级），此时仍可用「归档本版 PDF」人工兜底。
 */
export function useArchiveRenderedPdf(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { html: string; name?: string }) => {
      const { data } = await apiClient.post<RenderPdfResult>(
        `/trade-docs/${docId}/pdf`,
        input,
      );
      return data;
    },
    onSuccess: () => {
      // 与人工归档同一条失效口径：单据文件区的「系统出的 PDF」分区要立刻刷新
      qc.invalidateQueries({ queryKey: ["trade-docs", docId, "files"] });
      qc.invalidateQueries({ queryKey: ["trade-docs"] });
    },
  });
}

// ── 渲染指纹对账（C 方案的消费者）────────────────────────────────────────────

/** 对账结论码 —— 与服务端共享内核 `render_fingerprint_check` 的 `reason` 逐字对应。
 *
 * 前端**只认 reason**，绝不自己比对 sha：判断"模板改过"还是"数据被改"需要版本信息，
 * 在前端重推一遍逻辑必然与服务端漂移（G1 的同一理由）。
 */
export type RenderFingerprintReason =
  | "matched"
  | "version_drift"
  | "data_changed"
  | "no_fingerprint"
  | "frozen_unavailable"
  | "current_unavailable";

/** `GET /trade-docs/{id}/render-fingerprint-check` 的响应（11 字段，两端同契约）。 */
export interface RenderFingerprintCheck {
  has_fingerprint: boolean;
  frozen: RenderFingerprintMeta | null;
  current_sha256: string | null;
  matches: boolean;
  render_version_frozen: number | null;
  render_version_current: number;
  render_version_drift: boolean;
  reason: RenderFingerprintReason;
  checked_at: string;
  /** 现在这次装配失败的原因（如 `RuntimeError`）；成功为 null */
  current_note: string | null;
  /** 签发时就冻结失败过的话，当时的说明（`input_unavailable`） */
  frozen_note: string | null;
}

/**
 * 指纹对账：**用户点了才查**（`useMutation`，不做自动查询）。
 *
 * 为什么不做成 preview 时自动拉：对账要**重新装配一遍渲染输入**
 * （含企业主体、买方、产品图 data URI、默认公章），有实打实的成本；
 * 而它回答的是"现在跟签发时还一致吗"这种**按需**问题 —— 用户点一下再查。
 */
export function useCheckTradeDocRenderFingerprint(docId: number) {
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.get<RenderFingerprintCheck>(
        `/trade-docs/${docId}/render-fingerprint-check`,
      );
      return data;
    },
  });
}

// ── 单证内容级版本（TODO(TODO:A1)）───────────────────────────────────────────────
// 后端契约（worker `ws_docs_ext.py`）：
//   GET  /trade-docs/{id}/content-versions               列表（倒序；**不带**整份 payload）
//   GET  /trade-docs/{id}/content-versions/{version_no}   某版整份 payload
//   POST /trade-docs/{id}/content-versions/{version_no}/restore  仅 draft；报价单拒绝
// 与「上传 PDF 的文件版本链」（useTradeDocFiles）是两条独立链：那条管文件，
// 这条管**内容**（sources + custom 的整份快照）。

/** 版本产生原因（与后端 `content_versions.py` 的 SOURCE_* 一一对应） */
export type ContentVersionSource =
  | "custom_update"
  | "refresh_sources"
  | "issue"
  | "restore"
  | "translate";

export interface TradeDocContentVersionSummary {
  version_no: number;
  change_source: ContentVersionSource;
  actor_id: string | null;
  note: string | null;
  created_at: string | null;
  /** 该版本 custom 里填过的字段名（列表不返回 payload，靠它做概览） */
  custom_keys: string[];
}

export interface TradeDocContentVersionList {
  doc_id: number;
  total: number;
  items: TradeDocContentVersionSummary[];
}

export interface TradeDocContentVersionDetail {
  version_no: number;
  change_source: ContentVersionSource;
  actor_id: string | null;
  note: string | null;
  created_at: string | null;
  raw_payload: Record<string, unknown>;
}

export function useTradeDocContentVersions(docId: number | null) {
  return useQuery({
    queryKey: ["trade-docs", docId ?? 0, "content-versions"],
    enabled: docId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<TradeDocContentVersionList>(
        `/trade-docs/${docId}/content-versions`,
      );
      return data;
    },
  });
}

export function useTradeDocContentVersion(
  docId: number | null,
  versionNo: number | null,
) {
  return useQuery({
    queryKey: ["trade-docs", docId ?? 0, "content-versions", versionNo ?? 0],
    enabled: docId !== null && versionNo !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<TradeDocContentVersionDetail>(
        `/trade-docs/${docId}/content-versions/${versionNo}`,
      );
      return data;
    },
  });
}

export function useRestoreTradeDocContentVersion(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      versionNo,
      note,
    }: {
      versionNo: number;
      note?: string;
    }) => {
      const { data } = await apiClient.post<{
        doc: TradeDocRow;
        restored_version_no: number;
      }>(
        `/trade-docs/${docId}/content-versions/${versionNo}/restore`,
        note ? { note } : {},
      );
      return data;
    },
    onSuccess: () => {
      // 恢复 = 内容变了 + 版本链多一条：整棵 trade-docs 失效最稳
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
      qc.invalidateQueries({ queryKey: tradeDocKeys.renderData(docId) });
    },
  });
}
