/**
 * 单证渲染器（前端唯一实现，X′ 方案）
 * ─────────────────────────────────────
 * 从后端 Python 渲染器逐条移植而来。**移植纪律**：本文件不得"凭印象重写"，
 * 必须与 Python 版逐字节等价 —— 由 `__tests__/render.test.ts` 用 18 份
 * 基准产物做逐字节比对来强制保证。
 *
 * 为什么渲染放前端（而不是后端）：
 *   线上 Worker 为精简体积刻意不带模板引擎，导致「能开单但渲染不出单据」的断层；
 *   而预览/打印本来就在浏览器里发生，模板也天然属于前端静态资产。
 *
 * 设计要点（与 Python 版一致）
 * ----------------------------
 * 1. 模板用 `$var` 占位（`$$` 转义为 `$`），缺失字段渲染为空串，
 *    单据上不会残留 `$placeholder`；
 * 2. 共享样式 `_shared.css` 在**渲染完成后**字符串替换注入，
 *    CSS 里即便出现 `$` 也不会被当作占位符；
 * 3. 所有业务值经 HTML 转义防注入，仅 `other` 的 `content` 字段按原始 HTML 透传；
 * 4. 商品明细的列由**单据类型固定**，不随数据键漂移 ——
 *    海关/银行审单要求版面稳定：商业发票不应冒出毛净重列（那属于装箱单）；
 * 5. 自动派生：金额英文大写、日期格式化、数量/重量/体积合计、卖方名、页脚。
 */
import manifest from "./manifest.json";
import assets from "./assets.json";

export type TradeDocType = keyof typeof manifest;

export interface TradeDocTemplateInfo {
  doc_type: string;
  name_zh: string;
  name_en: string;
  description: string;
}

/** 允许透传原始 HTML 的字段（其余值一律转义） */
const RAW_HTML_FIELDS = new Set(["content"]);

/** 共享样式注入占位符（模板中写 `/*__SHARED_STYLE__*​/`） */
const STYLE_PLACEHOLDER = "/*__SHARED_STYLE__*/";

const TEMPLATES = assets.templates as Record<string, string>;
const SHARED_STYLE = assets.sharedStyle;

// ── 对外接口 ────────────────────────────────────────────────────────────────

export function getAvailableTemplates(): TradeDocTemplateInfo[] {
  return Object.entries(manifest).map(([docType, spec]) => ({
    doc_type: docType,
    name_zh: spec.name_zh,
    name_en: spec.name_en,
    description: spec.description,
  }));
}

export function getTemplateFields(
  docType: string,
): Record<string, unknown> | null {
  const spec = (
    manifest as Record<string, { fields?: Record<string, unknown> }>
  )[docType];
  return spec?.fields ?? null;
}

/** 渲染单证 HTML（自包含，含内联共享样式，可直接打印为 A4 PDF） */
export function renderTradeDoc(
  docType: string,
  data: Record<string, unknown>,
): string {
  const spec = (manifest as Record<string, { name_en: string }>)[docType];
  if (!spec) throw new Error(`不支持的单证类型: ${docType}`);

  const template = TEMPLATES[docType];
  if (template === undefined) throw new Error(`模板文件不存在: ${docType}`);

  const processed = preprocessData(docType, data);
  const rendered = substitute(template, processed);
  // 共享样式最后注入：CSS 不经过模板引擎，避免其中出现 $ 时被误当作占位符
  return rendered.split(STYLE_PLACEHOLDER).join(SHARED_STYLE);
}

// ── 模板替换（等价 Python string.Template）────────────────────────────────

/** 缺失键渲染为空串，避免单据上残留 $placeholder */
function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced?: string, named?: string) => {
      if (match === "$$") return "$";
      const key = braced ?? named ?? "";
      const value = vars[key];
      return value === undefined ? "" : value;
    },
  );
}

// ── HTML 转义（与 Python html.escape(quote=True) 逐字符等价）───────────────

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ── 数字 / 日期格式化（对齐 Python 的 format 语义）────────────────────────

/** 等价 Python `f"{n:,.2f}"`：千分位 + 固定 2 位小数 */
function formatAmount(n: number): string {
  const negative = n < 0;
  const parts = Math.abs(n).toFixed(2).split(".");
  const intPart = parts[0] ?? "0";
  const fracPart = parts[1] ?? "00";
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${fracPart}`;
}

/**
 * 等价 Python `f"{n:g}"`（默认 6 位有效数字、去尾零）。
 * 用于数量这类可能带小数的值。
 */
function formatG(n: number): string {
  if (n === 0) return "0";
  if (!Number.isFinite(n)) return String(n);
  const exp = Math.floor(Math.log10(Math.abs(n)));
  if (exp < -4 || exp >= 6) {
    const expParts = n.toExponential(5).split("e");
    const mantissa = (expParts[0] ?? "").replace(/0+$/, "").replace(/\.$/, "");
    const exponent = expParts[1] ?? "+0";
    const sign = exponent.startsWith("-") ? "-" : "+";
    const digits = exponent.replace(/^[+-]/, "");
    return `${mantissa}e${sign}${digits.length < 2 ? "0" + digits : digits}`;
  }
  let s = n.toFixed(Math.max(0, 5 - exp));
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** 等价 Python `round()`（四舍六入五取偶），用于金额小数进位 */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function formatQty(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return esc(value);
  return Number.isInteger(num) ? String(Math.trunc(num)) : formatG(num);
}

/** 按字段语义格式化数字：金额/重量/体积保留 2 位，数量取整 */
function formatNumber(key: string, value: number): string {
  const kl = key.toLowerCase();
  if (
    ["amount", "price", "insured"].some((h) => kl.includes(h)) ||
    ["weight", "volume"].some((h) => kl.includes(h))
  ) {
    return formatAmount(value);
  }
  return Number.isInteger(value) ? String(Math.trunc(value)) : String(value);
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** 不带 _date 后缀、但语义为日期的字段 */
const DATE_KEYS = new Set(["date", "valid_until", "etd", "eta"]);

function isDateKey(key: string): boolean {
  const kl = key.toLowerCase();
  return kl.endsWith("_date") || DATE_KEYS.has(kl);
}

/** 统一为国际单证常用写法 26-Sep-2026；非日期原样返回 */
function formatDate(value: unknown): string {
  const text = String(value).trim();
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (match) {
    const year = match[1] ?? "";
    const monthNum = Number(match[2]);
    const day = match[3] ?? "";
    if (monthNum >= 1 && monthNum <= 12 && year) {
      return `${day.padStart(2, "0")}-${MONTH_ABBR[monthNum - 1]}-${year}`;
    }
  }
  return esc(text);
}

// ── 金额英文大写 ────────────────────────────────────────────────────────────

const CURRENCY_WORDS: Record<string, [string, string]> = {
  USD: ["US DOLLARS", "CENTS"],
  CNY: ["CHINESE YUAN", "FEN"],
  RMB: ["CHINESE YUAN", "FEN"],
  EUR: ["EUROS", "CENTS"],
  GBP: ["POUNDS STERLING", "PENCE"],
  AUD: ["AUSTRALIAN DOLLARS", "CENTS"],
  CAD: ["CANADIAN DOLLARS", "CENTS"],
  NZD: ["NEW ZEALAND DOLLARS", "CENTS"],
  HKD: ["HONG KONG DOLLARS", "CENTS"],
  SGD: ["SINGAPORE DOLLARS", "CENTS"],
  JPY: ["JAPANESE YEN", ""],
  CHF: ["SWISS FRANCS", "CENTIMES"],
};

const ONES = [
  "ZERO",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
  "SIX",
  "SEVEN",
  "EIGHT",
  "NINE",
  "TEN",
  "ELEVEN",
  "TWELVE",
  "THIRTEEN",
  "FOURTEEN",
  "FIFTEEN",
  "SIXTEEN",
  "SEVENTEEN",
  "EIGHTEEN",
  "NINETEEN",
];
const TENS = [
  "",
  "",
  "TWENTY",
  "THIRTY",
  "FORTY",
  "FIFTY",
  "SIXTY",
  "SEVENTY",
  "EIGHTY",
  "NINETY",
];
const SCALES = ["", " THOUSAND", " MILLION", " BILLION"];

/** 0-999 转英文单词（百位后用 AND，符合金额大写的传统读法） */
function belowThousand(num: number): string {
  const parts: string[] = [];
  let n = num;
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)] ?? ""} HUNDRED`);
    n %= 100;
    if (n) parts.push("AND");
  }
  if (n >= 20) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    parts.push((TENS[tens] ?? "") + (ones ? `-${ONES[ones] ?? ""}` : ""));
  } else if (n > 0) {
    parts.push(ONES[n] ?? "");
  }
  return parts.join(" ");
}

/** 非负整数转英文单词（按千分位分段） */
function intToWords(num: number): string {
  if (num === 0) return "ZERO";
  const groups: string[] = [];
  let n = num;
  let index = 0;
  while (n > 0) {
    const remainder = n % 1000;
    n = Math.floor(n / 1000);
    if (remainder)
      groups.push(belowThousand(remainder) + (SCALES[index] ?? ""));
    index += 1;
  }
  return groups.reverse().join(" ");
}

/**
 * 金额转英文大写，如 `SAY US DOLLARS TWENTY-SIX THOUSAND FOUR HUNDRED AND FIFTY ONLY`
 * 金额非法（null / 空 / 非数字）时返回空串，由模板渲染为空。
 */
export function amountInWords(amount: unknown, currency = "USD"): string {
  if (amount === null || amount === undefined || amount === "") return "";
  const value = Number(amount);
  if (!Number.isFinite(value)) return "";
  if (value < 0) return "";

  const code = String(currency).trim().toUpperCase();
  const [unitWord, centWord] = CURRENCY_WORDS[code] ?? [code, "CENTS"];

  let whole = Math.trunc(value);
  let cents = Math.trunc(pyRound((value - whole) * 100));
  if (cents === 100) {
    whole += 1;
    cents = 0;
  }

  let words = `SAY ${unitWord} ${intToWords(whole)}`;
  if (cents && centWord) words += ` AND ${centWord} ${intToWords(cents)}`;
  return words + " ONLY";
}

// ── 收发货人 / 银行信息区块 ─────────────────────────────────────────────────

/** 渲染地址块：公司名加粗，联系信息带标签，便于识别与审单 */
function renderAddressBlock(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  if (obj.company) lines.push(`<strong>${esc(obj.company)}</strong>`);
  if (obj.name) lines.push(esc(obj.name));
  if (obj.address) lines.push(esc(obj.address));
  if (obj.contact) lines.push(`Attn: ${esc(obj.contact)}`);
  if (obj.phone) lines.push(`Tel: ${esc(obj.phone)}`);
  if (obj.fax) lines.push(`Fax: ${esc(obj.fax)}`);
  if (obj.email) lines.push(`E-mail: ${esc(obj.email)}`);
  if (obj.bank) lines.push(esc(obj.bank));
  if (obj.account) lines.push(`A/C: ${esc(obj.account)}`);
  if (obj.swift) lines.push(`SWIFT: ${esc(obj.swift)}`);
  return lines.join("<br>");
}

// ── 商品明细表 ──────────────────────────────────────────────────────────────

type Column = [key: string, label: string, align: "l" | "r" | "c"];

/**
 * 各单据类型的**固定列**：(字段 key, 英文表头, 对齐方式)
 * 版面稳定是审单要求：同一类单据的表头、列序不随数据波动。
 */
const ITEM_COLUMNS: Record<string, Column[]> = {
  quotation: [
    ["no", "No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["unit_price", "Unit Price", "r"],
    ["line_amount", "Amount", "r"],
  ],
  pi: [
    ["no", "No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["unit_price", "Unit Price", "r"],
    ["line_amount", "Amount", "r"],
  ],
  contract: [
    ["no", "No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["unit_price", "Unit Price", "r"],
    ["line_amount", "Amount", "r"],
  ],
  // 商业发票：目的国海关普遍要求 HS Code
  ci: [
    ["no", "No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["unit_price", "Unit Price", "r"],
    ["line_amount", "Amount", "r"],
    ["hs_code", "HS Code", "c"],
  ],
  // 装箱单：以包装与重量体积为核心
  pl: [
    ["no", "No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["package", "Packages", "c"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["gross_weight", "G.W. (KGS)", "r"],
    ["net_weight", "N.W. (KGS)", "r"],
    ["volume", "Meas. (CBM)", "r"],
  ],
  // 原产地证：以 HS Code 与重量为核心
  co: [
    ["no", "No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["gross_weight", "G.W. (KGS)", "r"],
    ["net_weight", "N.W. (KGS)", "r"],
    ["hs_code", "HS Code", "c"],
  ],
  // 重量单：只关心数量与重量，不含包装细节
  weight_list: [
    ["no", "No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["gross_weight", "G.W. (KGS)", "r"],
    ["net_weight", "N.W. (KGS)", "r"],
  ],
  // 装运通知：货物摘要 + 包装与毛重
  shipping_advice: [
    ["no", "No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["package", "Packages", "c"],
    ["gross_weight", "G.W. (KGS)", "r"],
  ],
  // 质量/检验证明：以 HS Code 与规格为核心
  quality_cert: [
    ["no", "No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["hs_code", "HS Code", "c"],
  ],
  // 报关信息：按申报要素排列（项号 / 商品编号 / 品名规格 / 数量 / 单价总价），
  // 重量等汇总项置于表格下方的汇总栏，避免表格列过多影响可读性
  customs_declaration: [
    ["no", "Item No.", "c"],
    ["product_name", "Description of Goods", "l"],
    ["specification", "Specification", "l"],
    ["hs_code", "HS Code", "c"],
    ["qty", "Quantity", "r"],
    ["qty_unit", "Unit", "c"],
    ["unit_price", "Unit Price", "r"],
    ["line_amount", "Amount", "r"],
  ],
};

const ITEM_HEADER_MAP: Record<string, string> = {
  no: "No.",
  product_name: "Description of Goods",
  description: "Description of Goods",
  specification: "Specification",
  qty: "Quantity",
  quantity: "Quantity",
  qty_unit: "Unit",
  unit_price: "Unit Price",
  line_amount: "Amount",
  gross_weight: "G.W. (KGS)",
  net_weight: "N.W. (KGS)",
  volume: "Meas. (CBM)",
  hs_code: "HS Code",
  package: "Packages",
  carton_no: "Carton No.",
};

/** 可由行项自动汇总的合计字段：合计字段 → 行项候选键（取第一个命中的） */
const AUTO_SUMS: Record<string, string[]> = {
  total_qty: ["qty", "quantity"],
  total_packages: ["package", "packages", "carton_no"],
  total_gross_weight: ["gross_weight"],
  total_net_weight: ["net_weight"],
  total_volume: ["volume"],
};

/** 取整展示的合计（其余合计保留 2 位小数） */
const INT_TOTALS = new Set(["total_qty", "total_packages"]);

/** 汇总行取值来源：列 key → 汇总数据 key */
const TOTAL_SOURCE: Record<string, string> = {
  qty: "total_qty",
  package: "total_packages",
  line_amount: "total_amount",
};

function renderCell(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  // 仅真正的数值类型走数值格式化；字符串一律原样转义。
  // 注意：不要把「看起来像数字的字符串」当数字处理 —— HS Code 之类的编码
  // 一旦被当作金额就会渲染成 7,314,410,000.00，海关审单直接判不符。
  if (typeof value === "number") {
    const kl = key.toLowerCase();
    if (kl.includes("qty") || kl === "package" || kl === "packages")
      return formatQty(value);
    return formatAmount(value);
  }
  return esc(value);
}

/** 汇总行项中的指定数值字段（按 keys 顺序取第一个命中的键）；无命中返回 null */
function sumNumeric(items: unknown, keys: string[]): number | null {
  if (!Array.isArray(items)) return null;
  let total = 0;
  let found = false;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    for (const key of keys) {
      const raw = (item as Record<string, unknown>)[key];
      if (typeof raw === "number" && Number.isFinite(raw)) {
        total += raw;
        found = true;
        break;
      }
    }
  }
  return found ? total : null;
}

/** 生成表格内 TOTAL 汇总行（数量合计 + 金额合计），无可用汇总值时省略 */
function renderTotalRow(
  columns: Column[],
  context: Record<string, unknown>,
): string {
  const summary = new Map<number, string>();
  const currency = String(context.currency ?? "").trim();

  columns.forEach(([key], index) => {
    const sourceKey = TOTAL_SOURCE[key];
    if (!sourceKey) return;
    const raw = context[sourceKey];
    if (raw === null || raw === undefined || raw === "") return;
    if (sourceKey === "total_amount") {
      const amount = renderCell("line_amount", raw);
      summary.set(index, amount ? `${currency} ${amount}`.trim() : "");
    } else {
      summary.set(index, formatQty(raw));
    }
  });

  if (summary.size === 0) return "";

  const first = Math.min(...summary.keys());
  const cells = [`<td class="l" colspan="${first}">TOTAL</td>`];
  for (let index = first; index < columns.length; index += 1) {
    const column = columns[index];
    if (!column) continue;
    if (summary.has(index)) {
      cells.push(`<td class="${column[2]}">${summary.get(index) ?? ""}</td>`);
    } else {
      cells.push("<td></td>");
    }
  }
  return `<tr class="total">${cells.join("")}</tr>`;
}

function renderFixedTable(
  items: Record<string, unknown>[],
  columns: Column[],
  context: Record<string, unknown>,
): string {
  const head = columns.map(([, label]) => `<th>${label}</th>`).join("");

  const rows: string[] = [];
  items.forEach((item, i) => {
    const index = i + 1;
    const cells = columns.map(([key, , align]) => {
      // 序号列由行号生成（不受数字格式化影响），其余取行项字段，缺列留空以固定版面
      const rendered =
        key === "no" ? String(index) : renderCell(key, item[key] ?? "");
      return `<td class="${align}">${rendered}</td>`;
    });
    rows.push(`<tr>${cells.join("")}</tr>`);
  });

  const totalRow = renderTotalRow(columns, context);
  if (totalRow) rows.push(totalRow);

  return `<table class="items"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

/** 回退实现：列由数据键决定（供未定义固定列的单据类型使用） */
function renderDynamicTable(items: Record<string, unknown>[]): string {
  const columns: string[] = [];
  for (const item of items) {
    for (const key of Object.keys(item))
      if (!columns.includes(key)) columns.push(key);
  }

  const head = columns
    .map((col) => `<th>${ITEM_HEADER_MAP[col] ?? col}</th>`)
    .join("");
  const rows = items.map((item) => {
    const cells = columns
      .map((col) => `<td class="l">${renderCell(col, item[col] ?? "")}</td>`)
      .join("");
    return `<tr>${cells}</tr>`;
  });

  return `<table class="items"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderItemsTable(
  items: Record<string, unknown>[],
  docType?: string,
  context: Record<string, unknown> = {},
): string {
  if (!items.length) return "";
  const columns = ITEM_COLUMNS[docType ?? ""];
  return columns
    ? renderFixedTable(items, columns, context)
    : renderDynamicTable(items);
}

// ── 数据预处理 ──────────────────────────────────────────────────────────────

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function preprocessData(
  docType: string,
  data: Record<string, unknown>,
): Record<string, string> {
  // 汇总上下文：业务未显式提供合计时由行项汇总，供表格 TOTAL 行与汇总栏使用
  const context: Record<string, unknown> = { ...data };
  for (const [field, itemKeys] of Object.entries(AUTO_SUMS)) {
    if (isEmpty(context[field])) {
      const summed = sumNumeric(data.items, itemKeys);
      if (summed !== null) context[field] = summed;
    }
  }

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(data)) {
    if (isEmpty(value)) {
      result[key] = "";
    } else if (Array.isArray(value)) {
      result[key] = value.length
        ? renderItemsTable(value as Record<string, unknown>[], docType, context)
        : "";
    } else if (typeof value === "object") {
      result[key] = renderAddressBlock(value as Record<string, unknown>);
    } else if (typeof value === "number") {
      result[key] = formatNumber(key, value);
    } else if (RAW_HTML_FIELDS.has(key)) {
      result[key] = String(value);
    } else if (isDateKey(key)) {
      result[key] = formatDate(value);
    } else {
      result[key] = esc(value);
    }
  }

  Object.assign(result, deriveFields(docType, data, context, result));
  return result;
}

/** 派生模板常用字段：金额大写、数量合计、卖方名、页脚 */
function deriveFields(
  docType: string,
  data: Record<string, unknown>,
  context: Record<string, unknown>,
  result: Record<string, string>,
): Record<string, string> {
  const derived: Record<string, string> = {};

  // 金额英文大写（报关 / 信用证审单必需）
  const currency = String(data.currency || "USD")
    .trim()
    .toUpperCase();
  for (const [field, amountKey] of [
    ["total_amount_words", "total_amount"],
    ["insured_amount_words", "insured_amount"],
  ] as const) {
    if (!isEmpty(data[amountKey])) {
      derived[field] = esc(amountInWords(data[amountKey], currency));
    }
  }

  // 合计字段（数量/件数/毛净重/体积）：模板未自带时补上
  for (const field of Object.keys(AUTO_SUMS)) {
    if (!result[field] && !isEmpty(context[field])) {
      const raw = context[field];
      derived[field] = INT_TOTALS.has(field)
        ? formatQty(raw)
        : formatAmount(Number(raw));
    }
  }

  // 卖方名称（签章区提示语用）
  const seller = (
    typeof data.seller === "object" && data.seller !== null ? data.seller : {}
  ) as Record<string, unknown>;
  derived.seller_name = esc(seller.company || seller.name || "");

  // 页脚：单据英文名 + 卖方名
  const nameEn =
    (manifest as Record<string, { name_en: string }>)[docType]?.name_en ?? "";
  const footer = data.footer_note;
  derived.footer_note = footer ? esc(footer) : esc(nameEn);

  return derived;
}
