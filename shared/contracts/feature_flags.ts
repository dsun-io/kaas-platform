/**
 * Single source of truth: v2 design document §4.2 (feature flag strategy)
 */

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description?: string;
}

export type FeatureFlags = Record<string, boolean>;
