import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const PROVINCE_PINYIN: Record<string, string> = {
  beijing: "北京",
  tianjin: "天津",
  hebei: "河北",
  shanxi: "山西",
  shaanxi: "陕西",
  neimenggu: "内蒙古",
  liaoning: "辽宁",
  jilin: "吉林",
  heilongjiang: "黑龙江",
  shanghai: "上海",
  jiangsu: "江苏",
  zhejiang: "浙江",
  anhui: "安徽",
  fujian: "福建",
  jiangxi: "江西",
  shandong: "山东",
  henan: "河南",
  hubei: "湖北",
  hunan: "湖南",
  guangdong: "广东",
  guangxi: "广西",
  hainan: "海南",
  chongqing: "重庆",
  sichuan: "四川",
  guizhou: "贵州",
  yunnan: "云南",
  xizang: "西藏",
  gansu: "甘肃",
  qinghai: "青海",
  ningxia: "宁夏",
  xinjiang: "新疆",
  // First-letter abbreviations
  bj: "北京",
  tj: "天津",
  hb: "河北",
  sx: "山西",
  nmg: "内蒙古",
  ln: "辽宁",
  jl: "吉林",
  hlj: "黑龙江",
  sh: "上海",
  js: "江苏",
  zj: "浙江",
  ah: "安徽",
  fj: "福建",
  jx: "江西",
  sd: "山东",
  hn: "河南",
  hub: "湖北",
  hun: "湖南",
  gd: "广东",
  gx: "广西",
  hain: "海南",
  cq: "重庆",
  sc: "四川",
  gz: "贵州",
  yn: "云南",
  xz: "西藏",
  shx: "陕西",
  gs: "甘肃",
  qh: "青海",
  nx: "宁夏",
  xj: "新疆",
};

/** 将省份拼音首字母／全拼转换为中文省份名称，不匹配时返回 null */
export function resolveProvincePinyin(input: string): string | null {
  const key = input.trim().toLowerCase();
  return key ? (PROVINCE_PINYIN[key] ?? null) : null;
}
