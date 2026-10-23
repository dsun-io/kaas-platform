"use client";

/**
 * 历史订单批量导入（C29）—— **预览** 与 **提交** 两个 mutation。
 *
 * 契约真源：`docs/IMPORT_ORDERS_PLAN_2026-10-23.md` §3（与内核 `imports_api.py`、门面
 * `routes/imports.ts` 逐字段对齐；2026-10-23 与后端确认过信封形状）：
 *
 *   POST /imports/orders/preview   multipart(file, customer_id)
 *     → 200 {customer:{id,name}, columns:[…], rows:[{index,ok,data,errors}],
 *            summary:{total,ok,error,existing_order_nos}}
 *     → 404 CUSTOMER_NOT_FOUND / 422 IMPORT_EMPTY_FILE|IMPORT_NO_HEADER|IMPORT_MISSING_COLUMNS
 *     **零写入**：预览只解析 + 校验，不落库。
 *   POST /imports/orders           multipart(file, customer_id)
 *     → 201 {created, ids, order_nos}（单事务，全有或全无）
 *     → 422 {detail:{error:"validation",code:"IMPORT_HAS_ERRORS",rows:[{index,errors}]}}
 *     → 409 {detail:{error:"conflict",code:"IMPORT_DUPLICATE_ORDER_NO",order_nos:[…]}}
 *
 * 为什么 multipart 必须显式声明 Content-Type：`apiClient` 实例默认
 * `application/json`，axios 见到 JSON 默认头会把 FormData 转成 JSON（文件传丢）。
 * 复用 `lib/export-quote/import-file.ts` 的 `MULTIPART_CONFIG`，两处口径一致。
 *
 * 为什么路径写成**字面量**而不是拼常量：`scripts/check-msw-coverage.ts` 用正则静态抽取
 * `apiClient.<method>("…")` 与 mock handler 对账；首参是变量会被判成"盲区"而不统计。
 *
 * 错误体解析**同时兼容嵌套与扁平**：仓库内核用 `HTTPException(detail=…)`（body =
 * `{"detail":{…}}`），但 docs §3 的片段是扁平写法；两种都认，避免后端微调就打不出原因。
 */
import { useQueryClient } from "@tanstack/react-query";

import { normalizeApiError } from "@/lib/api/api-error";
import apiClient from "@/lib/api/client";
import { MULTIPART_CONFIG } from "@/lib/export-quote/import-file";

import { useMutationWithError } from "./use-mutation-with-error";

/** 预览响应里的客户快照（后端按 customer_id 查到的那一行）。 */
export interface ImportOrderCustomer {
  id: number;
  name: string | null;
}

/** 预览行：`data` 只在 `ok=true` 时有值（错误行 data=null，与后端一致）。 */
export interface ImportOrderPreviewRow {
  /** 数据行序号，**从 1 开始**（不含表头） */
  index: number;
  ok: boolean;
  data: Record<string, unknown> | null;
  errors: string[];
}

export interface ImportOrderPreviewSummary {
  total: number;
  ok: number;
  error: number;
  /** 库里**已存在**的单号（按文件出现顺序）—— 预览用来提示"这些导不进去" */
  existing_order_nos: string[];
}

export interface ImportOrderPreviewResponse {
  customer: ImportOrderCustomer;
  /** 表头归一后识别到的列（未知列已被后端忽略）—— 预览表按它渲染列 */
  columns: string[];
  rows: ImportOrderPreviewRow[];
  summary: ImportOrderPreviewSummary;
  /**
   * 表头级提示（未知列已忽略 / 表头列重复按第一次取值）。
   * 内核 preview 会返回；不改列、不阻断导入，但要让用户知道"你这列没被用上"。
   */
  warnings?: string[];
}

/** 提交成功（201）：一批订单的 id 与原始单号。 */
export interface ImportOrderCommitResponse {
  created: number;
  ids: number[];
  order_nos: string[];
}

export interface ImportOrdersInput {
  file: File;
  /** 字符串与数字都接受：FormData 只能传字符串，组件里来自 CustomerPickerValue.id */
  customerId: string | number;
}

/**
 * multipart 表单：字段名与内核 `imports_api.py` 一致（`file` + `customer_id`）。
 *
 * `customer_id` 只能以字符串进 FormData —— 内核按整数解析，前端不做二次转换。
 */
export function buildImportOrdersFormData({
  file,
  customerId,
}: ImportOrdersInput): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("customer_id", String(customerId));
  return form;
}

/**
 * 预览：解析 + 逐行校验（**不写任何库**）。
 *
 * 用户点「确认导入」之前必须走这一步 —— 没有预览就等于让用户闭眼覆盖历史数据。
 */
export function usePreviewImportOrders() {
  return useMutationWithError({
    mutationFn: async (input: ImportOrdersInput) => {
      const { data } = await apiClient.post<ImportOrderPreviewResponse>(
        "/imports/orders/preview",
        buildImportOrdersFormData(input),
        MULTIPART_CONFIG,
      );
      return data;
    },
  });
}

/**
 * 提交：整批写入（后端单事务，全有或全无）。
 *
 * 成功后刷新订单查询：列表与各下拉都挂在 `["upstream","orders"]` 前缀下
 * （见 `use-orders-list.ts` 的注释），一次 invalidate 全部生效。
 */
export function useCommitImportOrders() {
  const queryClient = useQueryClient();
  return useMutationWithError({
    mutationFn: async (input: ImportOrdersInput) => {
      const { data } = await apiClient.post<ImportOrderCommitResponse>(
        "/imports/orders",
        buildImportOrdersFormData(input),
        MULTIPART_CONFIG,
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["upstream", "orders"] });
    },
  });
}

/** 后端 422/409 里逐行的错误（`index` 从 1 开始，与预览一致）。 */
export interface ImportOrderRowFailure {
  index: number;
  errors: string[];
}

/** 归一化后的导入失败信息（界面据此展示"后端为什么拒绝"）。 */
export interface ImportOrderFailure {
  status: number | null;
  code: string | null;
  /** 后端给的人话（没有就用 HTTP 状态兜底） */
  message: string;
  /** 422 IMPORT_HAS_ERRORS：逐行原因 */
  rows: ImportOrderRowFailure[];
  /** 409 IMPORT_DUPLICATE_ORDER_NO：撞库单号 */
  orderNos: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** 只保留"有 index 的字符串错误行"，其余形状（后端将来加字段）忽略而不是抛错。 */
function toRowFailures(value: unknown): ImportOrderRowFailure[] {
  if (!Array.isArray(value)) return [];
  const rows: ImportOrderRowFailure[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row) continue;
    const index = Number(row["index"]);
    if (!Number.isFinite(index)) continue;
    const errors = Array.isArray(row["errors"])
      ? row["errors"]
          .map((e) => (typeof e === "string" ? e.trim() : ""))
          .filter((e) => e !== "")
      : [];
    rows.push({ index, errors });
  }
  return rows;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : String(item)))
    .filter((item) => item !== "" && item !== "undefined" && item !== "null");
}

/**
 * 从任意捕获物里取出导入失败的**结构化**信息。
 *
 * 嵌套 / 扁平两种信封都认：`{"detail":{...}}`（仓库内核惯例）优先，
 * 平铺 `{error, code, rows}` 作兜底。
 */
export function parseImportOrderFailure(error: unknown): ImportOrderFailure {
  const normalized = normalizeApiError(error);
  const outer = asRecord(error);
  const response = asRecord(outer?.["response"]);
  const payload = asRecord(response?.["data"]);
  const nested = asRecord(payload?.["detail"]);
  const source = nested ?? payload;
  return {
    status: normalized.status,
    code: normalized.code,
    message: normalized.message,
    rows: toRowFailures(source?.["rows"]),
    orderNos: toStringList(source?.["order_nos"]),
  };
}

/**
 * 把失败信息翻成**可读原因**（界面 `role="alert"` 用）。
 *
 * 优先按业务码给"下一步该怎么办"；未知码退回后端原文，绝不吞成"失败"。
 */
export function describeImportOrderFailure(
  failure: ImportOrderFailure,
): string {
  switch (failure.code) {
    case "IMPORT_DUPLICATE_ORDER_NO": {
      const nos =
        failure.orderNos.length > 0
          ? failure.orderNos.join("、")
          : "（后端未返回具体单号）";
      return `导入被拒绝：这些订单号在系统里已存在 —— ${nos}。整批未写入，请改号或删除对应行后重试。`;
    }
    case "IMPORT_HAS_ERRORS": {
      const count =
        failure.rows.length > 0 ? `${failure.rows.length} 行` : "若干行";
      return `导入被拒绝：还有 ${count}没通过校验，整批未写入。请按下方逐行原因修正 CSV 后重新预览。`;
    }
    case "CUSTOMER_NOT_FOUND":
      return "导入失败：所选客户不存在（可能已被删除），请重新选择客户。";
    case "IMPORT_EMPTY_FILE":
      return "导入失败：CSV 文件是空的，请确认选的是有数据的文件。";
    case "IMPORT_NO_HEADER":
      return "导入失败：CSV 缺少表头行 —— 第一行必须是列名（如 order_no,order_date）。";
    case "IMPORT_MISSING_COLUMNS":
      return failure.message
        ? `导入失败：${failure.message}`
        : "导入失败：CSV 缺少必填列（order_no 与 order_date 都要有）。";
    case "IMPORT_NO_ROWS":
      return "导入失败：CSV 只有表头，没有数据行 —— 请确认导出的范围后重试。";
    case "IMPORT_FILE_TOO_LARGE":
      return failure.message
        ? `导入失败：${failure.message}`
        : "导入失败：文件过大（上限 10 MB）。";
    case "IMPORT_BAD_ENCODING":
      return "导入失败：CSV 必须是 UTF-8 编码（Excel 请另存为「CSV UTF-8」）。";
    case "CUSTOMER_REQUIRED":
      return "导入失败：必须选择数据所属的业务客户。";
    case "INVALID_CUSTOMER_ID":
      return "导入失败：客户 id 非法 —— 请重新选择客户。";
    default:
      return failure.message
        ? `导入失败：${failure.message}`
        : "导入失败：后端没有给出原因，请稍后重试。";
  }
}
