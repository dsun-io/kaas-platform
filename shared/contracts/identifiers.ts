/**
 * Single source of truth: v2 design document §5 (shared contract layer)
 * Branded type pattern for type-safe identifiers.
 */

export type TenantId = string & { readonly __brand: 'TenantId' };
export type TraceId = string & { readonly __brand: 'TraceId' };
export type RouteVersion = string & { readonly __brand: 'RouteVersion' };
