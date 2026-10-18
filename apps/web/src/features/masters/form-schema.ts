import { z } from 'zod';
import { i18n } from '@/lib/i18n';

/*
 * Forms keep plain strings (input type == output type) and convert on submit, which keeps
 * react-hook-form + zod typing simple. Helpers below validate and convert those strings.
 */
export const requiredText = (max = 120) => z.string().trim().min(1, 'Required').max(max, `At most ${max} characters`);
export const optionalText = (max = 200) => z.string().trim().max(max, `At most ${max} characters`);

/** Numeric text field; empty allowed unless `required`. */
export function numericText({ min = 0, max = 1_000_000, required = false, integer = false } = {}) {
  return z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      if (v === '') {
        if (required) ctx.addIssue({ code: 'custom', message: 'Required' });
        return;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) ctx.addIssue({ code: 'custom', message: 'Enter a number' });
      else if (integer && !Number.isInteger(n)) ctx.addIssue({ code: 'custom', message: 'Enter a whole number' });
      else if (n < min || n > max) ctx.addIssue({ code: 'custom', message: i18n.t('Must be between {{min}} and {{max}}', { min, max }) });
    });
}

/** '' → null, otherwise the trimmed string. */
export function nullIfBlank(v: string): string | null {
  const t = v.trim();
  return t === '' ? null : t;
}

/** '' → null, otherwise a number. */
export function numberOrNull(v: string): number | null {
  return v.trim() === '' ? null : Number(v);
}

export function str(v: string | number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}
