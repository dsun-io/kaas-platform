/**
 * Single source of truth: v2 design document §6.3 (admin panel)
 */

export enum AdminRole {
  SUPER_ADMIN = 'super_admin',
  TENANT_ADMIN = 'tenant_admin',
  READONLY = 'readonly',
}

export enum AdminAction {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  VIEW = 'view',
}

export interface AdminUser {
  id: string;
  role: AdminRole;
  email: string;
}
