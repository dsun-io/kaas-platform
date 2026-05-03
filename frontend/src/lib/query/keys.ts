export const queryKeys = {
  events: {
    all: ['events'] as const,
    list: (filters: Record<string, unknown>) => ['events', 'list', filters] as const,
  },
  dashboard: {
    summary: (range: string) => ['dashboard', 'summary', range] as const,
  },
  admin: {
    tenants: ['admin', 'tenants'] as const,
    featureFlags: (tenantId: string) => ['admin', 'featureFlags', tenantId] as const,
    deploymentAudit: (since: string) => ['admin', 'deploymentAudit', since] as const,
  },
  auditLog: {
    list: (filters: Record<string, unknown>) => ['admin', 'auditLog', filters] as const,
  },
} as const;
