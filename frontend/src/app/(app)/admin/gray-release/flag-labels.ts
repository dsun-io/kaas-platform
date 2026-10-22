/**
 * 灰度开关的中文名（设计稿 §1/§7：普通界面不出现内部开关代码）。
 *
 * 未知开关用「灰度功能」兜底，不把 key 直接摆到界面上；
 * 需要排查时仍可通过标题属性（hover）看到原始 key。
 */
const FLAG_LABELS: Record<string, string> = {
  use_v2: "新版功能",
};

export function flagLabel(key: string): string {
  return FLAG_LABELS[key] ?? "灰度功能";
}
