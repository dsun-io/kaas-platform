/**
 * 调研工位的数据类型（从 page.tsx 抽出，行为不变）。
 *
 * 形状 = `/api/v1/research/*` 与 `/leads` 的响应；页面与拆出的组件共用一份，
 * 避免表格/挑选区/编辑弹窗各抄一份漂移。
 */

export interface ResearchProduct {
  id: number;
  source_ref: number | null;
  source: string | null;
  product_name: string | null;
  product_name_cn: string | null;
  product_image_url: string | null;
  spec_raw: string | null;
  spec_normalized: Record<string, unknown> | null;
  product_category: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  shop_name: string | null;
  shop_type: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  link_url: string | null;
  price_local: number | null;
  price_currency: string | null;
  market_note: string | null;
  can_supply: boolean | null;
  supply_notes: string | null;
  research_status: string;
  created_at: string;
}

export interface ResearchStats {
  total: number;
  can_supply_yes: number;
  by_country: { country: string; total: number; can_supply: number }[];
  by_category: { product_category: string; total: number }[];
}

export interface LeadOption {
  id: number;
  company_name: string;
  country: string | null;
  city: string | null;
  shop_type: string | null;
  product_name: string | null;
  product_name_cn: string | null;
  crawl_status: string | null;
  can_supply: boolean | null;
  website: string | null;
}

export interface ResearchRun {
  id: number;
  config: Record<string, unknown> | null;
  status: string;
  leads_scanned: number | null;
  products_found: number | null;
  products_kept: number | null;
  created_at: string;
}

export type TabKey = "products" | "pick" | "runs";

export interface ResearchProductPage {
  items: ResearchProduct[];
  total: number;
  page: number;
  page_size: number;
}
