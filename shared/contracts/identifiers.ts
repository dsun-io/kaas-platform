/**
 * Single source of truth: v2 design document §5 (shared contract layer)
 * Branded type pattern for type-safe identifiers, with zod schemas.
 */
import { z } from 'zod';

export type TenantId = string & { readonly __brand: 'TenantId' };
export type TraceId = string & { readonly __brand: 'TraceId' };
export type RouteVersion = string & { readonly __brand: 'RouteVersion' };

export const tenantIdSchema = z.string().min(1);
export const customerIdSchema = z.string().min(1);
export const agentIdSchema = z.string().min(1);
export const sessionIdSchema = z.string().min(1);
export const traceIdSchema = z.string().min(1);
export const specHashSchema = z.string().min(1);
