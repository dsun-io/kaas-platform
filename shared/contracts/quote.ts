/**
 * Single source of truth: v2 design document §3.7 (quote flow)
 */

import type { ProductCategory } from './categories';

export interface QuoteItem {
  product_category: ProductCategory;
  product_spec: Record<string, unknown>;
  quantity: number;
  unit_price: number | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface QuoteRequest {
  session_id: string;
  customer_id: string;
  items: QuoteItem[];
}

export interface QuoteResponse {
  session_id: string;
  customer_id: string;
  items: QuoteItem[];
  status: 'matched' | 'estimated' | 'spec_not_supported';
  source: 'quotations_db' | 'L1_L2_formula';
}
