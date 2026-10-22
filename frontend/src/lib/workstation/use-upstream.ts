"use client";

/**
 * 上游选项（订单 / 报价单 / 客户）—— 供开单时选择来源。
 *
 * 为什么单证必须有上游：单证要「继承」上游谈定的货物、金额与贸易条款。
 * 手输单号既容易错，也会绕开继承逻辑，所以这里一律用下拉选择。
 *
 * 业务客户同样是**选择**而不是手输：三张单据表的 `customer_id` 都是外键
 * （2026-10-11 的包含关系设计），手输的字符串过不了后端闸门，
 * 还会让客户页的「往来记录」树挂错节点。
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

interface Paged<T> {
  items: T[];
  total: number;
}

export interface OrderOption {
  id: number;
  order_no: string;
  customer_name: string | null;
  status: string;
  currency: string;
  total_amount: number | null;
  order_date: string | null;
  delivery_date: string | null;
  incoterm: string | null;
  payment_terms: string | null;
  port_of_loading: string | null;
  port_of_destination: string | null;
  shipping_marks: string | null;
  country_of_origin: string | null;
  // ── 来源链与确认痕迹（设计 §3.2 / §5.1，迁移 202610220004）──────────────
  // 门面/内核的 row_to_order 已返回；缺省（历史行/旧 mock）按 direct 处理，
  // 所以这里都是可选字段 —— 不让前端因为"老数据没有这几列"而崩。
  /** inquiry=询盘转化（含经报价转化）/ direct=直接下单 */
  source_type?: "inquiry" | "direct" | null;
  /** 询盘/订单渠道（与询盘渠道同一份枚举；null = 渠道未知，历史单不伪造） */
  source_channel?: string | null;
  inquiry_id?: number | null;
  quote_id?: number | null;
  confirmed_at?: string | null;
  confirmed_by?: string | number | null;
  /** manual / deposit_receipt */
  confirmed_source?: string | null;
}

export interface QuoteOption {
  id: number;
  quote_no: string;
  customer_name: string | null;
  status: string;
  currency: string;
  total_amount: number | null;
  incoterm: string | null;
}

export interface CustomerOption {
  id: number | string;
  /**
   * 真实后端 `row_to_customer` 输出的字段是 **`company_name`**；
   * `name` / `customer_name` 是历史形态与 MSW mock 数据的字段。
   * 三个都留着，是为了"选择器永远显示得出名字"，而不是显示一串 undefined。
   */
  company_name?: string | null;
  name?: string | null;
  customer_name?: string | null;
  country?: string | null;
  default_port?: string | null;
  stage?: string | null;
}

/** 客户显示名：按后端 → 历史 → mock 的顺序取第一个有值的字段。 */
export function customerOptionName(
  customer: CustomerOption | null | undefined,
): string {
  if (!customer) return "";
  const named =
    customer.company_name || customer.name || customer.customer_name || "";
  return named || `#${customer.id}`;
}

/**
 * 提交给后端的 `customer_id`。
 *
 * 为什么要转：报价/订单/单证的 `customer_id` 都是 **BIGINT**，
 * 而选择器内部的 value 是字符串（DOM/URL 友好）。纯数字就转成 number，
 * 非数字（历史 mock 形态的字符串 ID）原样传，让后端校验去拒绝，
 * 而不是本地静默造一个 NaN 出去。
 */
export function toCustomerIdPayload(id: string): number | string {
  return /^\d+$/.test(id) ? Number(id) : id;
}

export function useOrderOptions() {
  return useQuery({
    queryKey: ["upstream", "orders"],
    queryFn: async () => {
      const { data } = await apiClient.get<Paged<OrderOption>>("/orders", {
        params: { page_size: 100 },
      });
      return data.items;
    },
  });
}

export function useQuoteOptions() {
  return useQuery({
    queryKey: ["upstream", "quotes"],
    queryFn: async () => {
      const { data } = await apiClient.get<Paged<QuoteOption>>("/quotes", {
        params: { page_size: 100 },
      });
      return data.items;
    },
  });
}

export function useCustomerOptions() {
  return useQuery({
    queryKey: ["upstream", "customers"],
    queryFn: async () => {
      const { data } = await apiClient.get<Paged<CustomerOption>>(
        "/customers",
        {
          params: { page_size: 200 },
        },
      );
      return data.items;
    },
  });
}

/**
 * 业务客户搜索（报价 / 订单 / 单证 三处选择器共用）。
 *
 * 为什么走服务端 `q` 而不是本地过滤 `useCustomerOptions()`：
 * 客户是**跨年累积**的主数据，一次拉 200 条既漏（超出部分搜不到）又慢；
 * `GET /customers?q=` 是客户管理页已有的同一条件，
 * 这样"选择器能搜到的"与"客户页能看到的"永远是同一批人。
 */
export function useCustomerSearch(keyword: string, pageSize = 20) {
  const q = keyword.trim();
  return useQuery({
    queryKey: ["upstream", "customers", "search", q, pageSize],
    queryFn: async () => {
      const params: Record<string, string | number> = { page_size: pageSize };
      if (q) params.q = q;
      const { data } = await apiClient.get<Paged<CustomerOption>>(
        "/customers",
        {
          params,
        },
      );
      return data;
    },
    staleTime: 60 * 1000,
  });
}

/**
 * 只有 id、还没有名字时补名字（深链 `?customer_id=7` 就是这种情况）。
 *
 * 为什么要补：报价单落库时会写 `customer_name` 作为**开单快照**，
 * 深链进来直接保存的话快照会是空的 —— 单据上就没买方名了。
 * 接口失败不影响使用：名字退化成 `#id`，不阻断任何主流程。
 */
export function useCustomerName(id: string | null) {
  return useQuery({
    queryKey: ["upstream", "customer", id],
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await apiClient.get<CustomerOption>(`/customers/${id}`);
      return customerOptionName(data);
    },
  });
}
