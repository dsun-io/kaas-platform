export const queryKeys = {
  events: {
    all: ["events"] as const,
    list: (filters: Record<string, unknown>) =>
      ["events", "list", filters] as const,
  },
  dashboard: {
    summary: (range: string) => ["dashboard", "summary", range] as const,
  },
  admin: {
    tenants: ["admin", "tenants"] as const,
    featureFlags: (tenantId: string) =>
      ["admin", "featureFlags", tenantId] as const,
    deploymentAudit: (since: string) =>
      ["admin", "deploymentAudit", since] as const,
  },
  auditLog: {
    list: (filters: Record<string, unknown>) =>
      ["admin", "auditLog", filters] as const,
  },
  spec: {
    categories: ["spec", "categories"] as const,
    category: (id: number) => ["spec", "category", id] as const,
    bindings: (categoryId: number) => ["spec", "bindings", categoryId] as const,
    attributes: (filters: Record<string, unknown>) =>
      ["spec", "attributes", filters] as const,
    skus: (filters: Record<string, unknown>) =>
      ["spec", "skus", filters] as const,
    sku: (id: number) => ["spec", "sku", id] as const,
    templates: ["spec", "templates"] as const,
    template: (id: number) => ["spec", "template", id] as const,
  },
  pricingData: {
    list: (filters: Record<string, unknown>) =>
      ["pricingData", "list", filters] as const,
  },
  proposals: {
    list: (status?: string) => ["proposals", "list", status] as const,
    recommended: ["proposals", "recommended"] as const,
  },
} as const;
