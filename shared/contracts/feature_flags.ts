/**
 * Single source of truth: v2 design document §4.2 (feature flag strategy)
 */
import { z } from 'zod';

export const FeatureFlagName = {
  USE_V2: 'use_v2',
  SAMPLING_ENABLED: 'sampling_enabled',
} as const;
export type FeatureFlagName = (typeof FeatureFlagName)[keyof typeof FeatureFlagName];

export const FeatureFlagSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
});

export const FeatureFlagsSchema = z.record(z.boolean());

export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;
