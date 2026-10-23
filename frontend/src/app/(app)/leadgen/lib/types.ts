/**
 * 线索开发工位的数据类型（从 page.tsx 抽出，行为不变）。
 *
 * 字段形状 = `ws_leadgen.py` / `GET /leads` 与 `GET /leads/{id}` 的响应；
 * 页面与拆出的组件共用同一份定义，避免"表格用一份、抽屉又抄一份"。
 */

export interface LeadgenRun {
  id: number;
  status: string;
  leads_found: number | null;
  leads_kept: number | null;
  error: string | null;
  deduplicated?: boolean;
  started_at: string | null;
  finished_at: string | null;
}

export interface Lead {
  id: number;
  place_id: string | null;
  company_name: string;
  country: string | null;
  region: string | null;
  city: string | null;
  email: string | null;
  website: string | null;
  phone: string | null;
  industry: string | null;
  google_rating: number | null;
  google_reviews: number | null;
  fit_score: number | null;
  fit_reasons: string[] | null;
  opening_line: string | null;
  outreach_status: string;
  inquiry_status: string;
  demand_index: number | null;
  blank_index: number | null;
  created_at: string;
  // 产品信息（Google Places 拿不到，来自爬官网 / CSV 导入）
  shop_type: string | null;
  product_name: string | null;
  product_name_cn: string | null;
  product_image_url: string | null;
  spec_raw: string | null;
  link_url: string | null;
  can_supply: boolean | null;
  supply_notes: string | null;
  crawl_status: string | null;
  crawled_at: string | null;
}

export interface LeadDetail extends Lead {
  outreach_history: {
    id: number;
    status: string;
    error: string | null;
    sent_at: string | null;
  }[];
  inquiry_history: { id: number; status: string; created_at: string }[];
}

/** 「抓取配置」表单值（受控于页面，便于校验/跑批共用同一份配置）。 */
export interface LeadgenConfig {
  region: string;
  industry: string;
  icp: string;
  quantity: number;
  source: string;
}

/** 配置校验结果（`POST /leadgen/validate`）。 */
export interface LeadgenValidation {
  valid: boolean;
  issues: string[];
  path: string;
}
