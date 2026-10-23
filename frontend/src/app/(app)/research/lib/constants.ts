/** 调研工位常量（从 page.tsx 抽出，数值不变）。 */

/** 调研产品分页大小（与后端默认 page_size 同口径；上限 200 由后端 Query 校验）。 */
export const RESEARCH_PAGE_SIZE = 20;

/** 导出全部时的单页上限（后端 le=200），整批拉完再写 CSV，避免静默截断。 */
export const EXPORT_PAGE_SIZE = 200;

/** 「可供货」三态筛选选项（含"未填"）。 */
export const CAN_SUPPLY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "可供货：全部" },
  { value: "true", label: "可供货：是" },
  { value: "false", label: "可供货：否" },
  { value: "unknown", label: "可供货：未填" },
];
