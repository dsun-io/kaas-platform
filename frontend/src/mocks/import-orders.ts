/**
 * 历史订单导入（C29）的 **mock 侧纯逻辑**：CSV 解析 + 逐行校验。
 *
 * 为什么单独放一个文件（而不是塞进 handlers.ts 的巨型字面量里）：
 *   1. 解析/校验是**纯函数**，可以脱离 MSW 直接单测（契约测试只验 HTTP 外形，
 *      这里验"每一列怎么判"）；
 *   2. handlers.ts 是增量补丁式维护的 1 万行文件，再往里加两百行解析逻辑会没人敢改。
 *
 * 口径真源 = `backend/worker/src/imports_api.py`（2026-10-23 已落地）与
 * `docs/IMPORT_ORDERS_PLAN_2026-10-23.md` §2/§3 —— **逐条对照，不是凭设计稿猜**：
 *   · 文件 = CSV（UTF-8，兼容 Excel 导出的 UTF-8-BOM），第一行非空行即表头；
 *   · 表头归一：去首尾空格 + 大小写不敏感；未知列忽略 + warnings；重复列按第一次；
 *   · 必填列 `order_no` / `order_date`；空文件 / 无表头 / 缺必填列 / 只有表头 ⇒ 422；
 *   · `order_no` 非空且 ≤64，**文件内唯一** + **库内不存在**；
 *   · `order_date` 取前 10 字符按 ISO 解析（同 `pricing_rules.parse_date`）；
 *   · `status` 转小写后校验 ORDER_STATUS，缺省 `pending`；
 *   · `currency` 转大写后校验 CURRENCY，缺省 `USD`；
 *   · `total_amount` 可选 Decimal ≥0（**原值不四舍五入**），缺省 **NULL（不伪造 0）**；
 *   · `notes` ≤2000。
 *
 * 逐行错误文案与内核**逐字一致**（用户看到的原因就是生产上会看到的那句）；
 * 枚举白名单不在这里抄一份 —— 由 handlers.ts 从既有唯一真源传进来。
 */

/** 识别得到的列（内核 `COLUMNS`；顺序按**文件表头位置**，不是这里的书写顺序）。 */
export const IMPORT_ORDERS_COLUMNS = [
  "order_no",
  "order_date",
  "status",
  "currency",
  "total_amount",
  "notes",
] as const;

/** 必填列（缺任一 ⇒ 422 IMPORT_MISSING_COLUMNS）。 */
export const IMPORT_ORDERS_REQUIRED_COLUMNS = [
  "order_no",
  "order_date",
] as const;

/**
 * 「撞库」的逐行错误文案（= 内核 `_mark_db_duplicates` 的字面量）。
 *
 * 独立导出是因为**提交**要按它分流：撞库归 409 `IMPORT_DUPLICATE_ORDER_NO`，
 * 其余行错误归 422 `IMPORT_HAS_ERRORS` —— 两种错因给用户的下一步动作不同
 * （改号 vs 改格式）。内核提交路径**不会**把撞库写进行错误（先判 422 再判 409），
 * 这里用同一句文案把它筛掉，行为与内核等价。
 */
export const IMPORT_DB_DUPLICATE_MESSAGE = "order_no 已存在于本租户";

/** 一行校验通过后的规范化数据（= 内核 `_validate_row` 的 public 形状）。 */
export interface ImportOrderRowData {
  order_no: string | null;
  order_date: string | null;
  status: string;
  currency: string;
  total_amount: number | null;
  notes: string | null;
}

export interface ValidatedImportOrderRow {
  /** 数据行序号，**从 1 开始**（不含表头） */
  index: number;
  /** 有错行时 null（与内核 `_public_row` 一致：坏行不下发半成品 data） */
  data: ImportOrderRowData | null;
  errors: string[];
}

export type ImportOrdersParseFailureCode =
  | "IMPORT_NO_HEADER"
  | "IMPORT_MISSING_COLUMNS";

export type ImportOrdersParseResult =
  | {
      ok: true;
      /** 识别到的列（按文件表头位置） */
      columns: string[];
      rows: ValidatedImportOrderRow[];
      /** 库内已存在的单号（按**文件出现顺序**去重） */
      existingOrderNos: string[];
      /** 表头级提示：未知列已忽略 / 重复列按第一次取值 */
      warnings: string[];
    }
  | {
      ok: false;
      code: ImportOrdersParseFailureCode;
      message: string;
      /** 缺了哪些必填列（仅 IMPORT_MISSING_COLUMNS 时有；内核的 extra key 也叫 columns） */
      columns?: string[];
    };

/**
 * 极简 CSV 解析（RFC 4180 子集）：双引号包裹、`""` 转义、CRLF/LF、UTF-8 BOM。
 *
 * mock 只处理**文本** CSV（设计 §1：本轮只做 CSV，XLSX 留后续）。
 * 全空行直接丢弃 —— Excel 导出常在末尾留空行，按"数据行"算会凭空多出错误行；
 * 内核同样在 `_parse_csv` 里 `if not any(strip(c) for c in cells): continue`。
 */
export function parseImportOrdersCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * 日期判据 = 内核 `pricing_rules.parse_date`：取前 10 字符按 ISO 解析。
 *
 * 注意这是**故意的宽容**：`2026-05-01T09:00` 在核心里能过（前 10 字符合法），
 * mock 若更严格就会把"生产能导、mock 导不了"的文件判成错误 —— 那是最坏的漂移方向。
 */
export function isIsoDate(value: string): boolean {
  const head = value.trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** 内核用 Decimal 解析金额；这里用等价的十进制字面量判据（拒绝 hex / 千分位等 Number 会误收的形态）。 */
const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * 解析 + 逐行校验。
 *
 * @param text            上传文件的文本内容
 * @param existingOrderNos 库里**已存在**的单号（由调用方从 orders store 取）
 * @param allowedStatuses  ORDER_STATUS 枚举（唯一真源在 handlers.ts）
 * @param allowedCurrencies CURRENCY 白名单（同上）
 */
export function validateImportOrdersCsv(
  text: string,
  existingOrderNos: Iterable<string>,
  allowedStatuses: readonly string[],
  allowedCurrencies: readonly string[],
): ImportOrdersParseResult {
  const table = parseImportOrdersCsv(text);
  const header = table[0];
  if (!header) {
    return {
      ok: false,
      code: "IMPORT_NO_HEADER",
      message: "CSV 缺少表头行（第一行必须是列名）",
    };
  }

  // 表头归一：去首尾空格 + 小写；未知列忽略 + warning；重复列按第一次出现取值
  const position = new Map<string, number>();
  const recognized: Array<{ at: number; name: string }> = [];
  const warnings: string[] = [];
  header.forEach((cell, at) => {
    const name = cell.trim().toLowerCase();
    if (name === "") return;
    if ((IMPORT_ORDERS_COLUMNS as readonly string[]).includes(name)) {
      if (position.has(name)) {
        warnings.push("表头列重复，按第一次出现取值：" + name);
        return;
      }
      position.set(name, at);
      recognized.push({ at, name });
    } else {
      warnings.push("未知列已忽略：" + name);
    }
  });

  // 列顺序按**文件表头位置**（内核 sorted(index_by_column.items())）
  const columns = recognized
    .sort((a, b) => a.at - b.at)
    .map((item) => item.name);
  const missing = IMPORT_ORDERS_REQUIRED_COLUMNS.filter(
    (column) => !columns.includes(column),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: "IMPORT_MISSING_COLUMNS",
      message: "缺少必填列：" + missing.join("、"),
      columns: [...missing],
    };
  }

  const knownExisting = new Set(
    [...existingOrderNos].map((no) => no.trim()).filter((no) => no !== ""),
  );
  const seenInFile = new Map<string, number>();
  const existingFound: string[] = [];
  const rows: ValidatedImportOrderRow[] = [];

  table.slice(1).forEach((cells, offset) => {
    const index = offset + 1;
    const cell = (column: string): string => {
      const at = position.get(column);
      if (at === undefined) return "";
      const value = cells[at];
      return typeof value === "string" ? value.trim() : "";
    };
    const errors: string[] = [];

    const orderNo = cell("order_no");
    if (orderNo === "") {
      errors.push("order_no 必填");
    } else if (orderNo.length > 64) {
      errors.push("order_no 超过 64 字符");
    } else {
      const firstSeen = seenInFile.get(orderNo);
      if (firstSeen !== undefined) {
        errors.push("order_no 在文件内重复（第 " + String(firstSeen) + " 行）");
      } else {
        seenInFile.set(orderNo, index);
      }
    }
    if (orderNo !== "" && knownExisting.has(orderNo)) {
      if (!existingFound.includes(orderNo)) existingFound.push(orderNo);
      errors.push(IMPORT_DB_DUPLICATE_MESSAGE);
    }

    const rawDate = cell("order_date");
    if (rawDate === "") {
      errors.push("order_date 必填");
    } else if (!isIsoDate(rawDate)) {
      errors.push("order_date 不是合法日期（YYYY-MM-DD）");
    }
    const orderDate = rawDate === "" ? "" : rawDate.slice(0, 10);

    const rawStatus = cell("status").toLowerCase();
    const status = rawStatus === "" ? "pending" : rawStatus;
    if (rawStatus !== "" && !allowedStatuses.includes(status)) {
      errors.push("status 非法：允许 " + allowedStatuses.join("/"));
    }

    const rawCurrency = cell("currency").toUpperCase();
    const currency = rawCurrency === "" ? "USD" : rawCurrency;
    if (rawCurrency !== "" && !allowedCurrencies.includes(currency)) {
      errors.push("currency 非法：允许 " + allowedCurrencies.join("/"));
    }

    const rawAmount = cell("total_amount");
    let totalAmount: number | null = null;
    if (rawAmount !== "") {
      if (!DECIMAL_RE.test(rawAmount)) {
        errors.push("total_amount 必须是数字");
      } else {
        const parsed = Number(rawAmount);
        if (!Number.isFinite(parsed)) {
          errors.push("total_amount 必须是有限数字");
        } else if (parsed < 0) {
          errors.push("total_amount 必须 ≥ 0");
        } else {
          // 内核保留 Decimal 原值（不四舍五入），这里同样不收口
          totalAmount = parsed;
        }
      }
    }

    const notesRaw = cell("notes");
    if (notesRaw.length > 2000) {
      errors.push("notes 超过 2000 字符");
    }

    rows.push({
      index,
      data:
        errors.length === 0
          ? {
              order_no: orderNo === "" ? null : orderNo,
              order_date: orderDate === "" ? null : orderDate,
              status,
              currency,
              total_amount: totalAmount,
              notes: notesRaw === "" ? null : notesRaw,
            }
          : null,
      errors,
    });
  });

  return {
    ok: true,
    columns,
    rows,
    existingOrderNos: existingFound,
    warnings,
  };
}
