import type { AlertSeverity, AlertStatus } from '@veetracer/shared';

export const SEVERITY_LABEL: Record<AlertSeverity, string> = { INFO: 'Info', WARNING: 'Warning', CRITICAL: 'Critical' };

/** Map paint colours (light/dark agnostic, readable on both basemaps). */
export const SEVERITY_COLOR: Record<AlertSeverity, string> = { INFO: '#2563eb', WARNING: '#d97706', CRITICAL: '#dc2626' };

export const SEVERITY_BADGE: Record<AlertSeverity, 'secondary' | 'warning' | 'destructive'> = {
  INFO: 'secondary',
  WARNING: 'warning',
  CRITICAL: 'destructive',
};

export const STATUS_LABEL: Record<AlertStatus, string> = { NEW: 'New', ACKNOWLEDGED: 'Acknowledged', RESOLVED: 'Resolved' };
export const STATUS_BADGE: Record<AlertStatus, 'default' | 'muted' | 'success'> = { NEW: 'default', ACKNOWLEDGED: 'muted', RESOLVED: 'success' };
