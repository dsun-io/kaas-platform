/**
 * Single source of truth: v2 design document §6.3 (admin panel)
 */
import { z } from 'zod';

export const AdminRole = {
  SUPER_ADMIN: 'super_admin',
  TENANT_ADMIN: 'tenant_admin',
  READONLY: 'readonly',
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

export const AdminAction = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  VIEW: 'view',
} as const;
export type AdminAction = (typeof AdminAction)[keyof typeof AdminAction];

export const AdminUserSchema = z.object({
  id: z.string(),
  role: z.enum(['super_admin', 'tenant_admin', 'readonly']),
  email: z.string().email(),
});

export const TenantSchema = z.object({
  tenant_id: z.string(),
  name: z.string(),
  is_active: z.boolean(),
});

export const FeatureFlagToggleSchema = z.object({
  tenant_id: z.string(),
  flag_key: z.string(),
  enabled: z.boolean(),
});

export const DeploymentAuditSchema = z.object({
  id: z.string(),
  action: z.enum(['create', 'update', 'delete', 'view']),
  actor_id: z.string(),
  resource_type: z.string(),
  resource_id: z.string(),
  timestamp: z.string(),
});

export type AdminUser = z.infer<typeof AdminUserSchema>;
export type Tenant = z.infer<typeof TenantSchema>;
export type FeatureFlagToggle = z.infer<typeof FeatureFlagToggleSchema>;
export type DeploymentAudit = z.infer<typeof DeploymentAuditSchema>;
