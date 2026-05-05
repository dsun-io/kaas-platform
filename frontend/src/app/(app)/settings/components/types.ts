export interface Tenant {
  tenant_id: string;
  display_name: string;
  locale: string;
  region: string;
  product_categories?: string[];
  is_active: boolean;
}

export interface ReloadResult {
  reloaded_count: number;
  active_tenants: Tenant[];
}
