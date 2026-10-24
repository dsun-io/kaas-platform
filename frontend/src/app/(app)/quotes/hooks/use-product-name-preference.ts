"use client";

/**
 * 客户 × 产品的英文名偏好（A 项 2026-10-24）——**默认英文名的来源**。
 *
 * 数据源 `GET /quotes/product-name-preference?customer_id=&product_key=`：
 * 该客户**最近一次**报同一产品时用的那个英文名。行卡据此决定本单默认名：
 *   · 有历史且仍在本产品英文名列表里 ⇒ 沿用客户上次用的名；
 *   · 没历史（首次给这个客户报这个产品）⇒ 产品默认英文名（name_en）。
 *
 * 三个刻意的选择：
 * 1. **按 `product_key` 查，不按英文名查**：英文名本身就是本接口要查的变量，
 *    拿它当身份会在团队改名后失真（后端 `quote_api.py:quote_product_name_preference`）。
 * 2. `retry: false`：查不到是常态，重试只会让行卡多等几轮（同 `use-reference-price`）。
 * 3. `silent: true`：这是**默认可覆盖**的偏好，失败时由行卡回落到产品默认名即可，
 *    不该弹通用报错（未知产品/客户 404 属于可预期状态）。
 */
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface ProductNamePreference {
  /** 客户上次给该产品用的英文名；无历史为 `null` */
  product_name: string | null;
}

export function useProductNamePreference(
  customerId: string | null | undefined,
  productKey: string | null | undefined,
) {
  return useQuery({
    queryKey: ["quotes", "product-name-preference", customerId, productKey],
    queryFn: async () => {
      const { data } = await apiClient.get<ProductNamePreference>(
        "/quotes/product-name-preference",
        {
          params: { customer_id: customerId, product_key: productKey },
          silent: true,
        },
      );
      return data;
    },
    enabled: !!customerId && !!productKey,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
