/**
 * Phase 0 session cache — returns hardcoded tenant.
 * Phase 1 will replace with next-auth JWT session lookup.
 */

export interface Session {
  tenant: {
    tenant_id: string;
  };
  accessToken: string | null;
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

export function getCurrentSession(): Session {
  return {
    tenant: {
      tenant_id: 'default-tenant',
    },
    accessToken: null,
  };
}
