import { z } from 'zod';

/** Spec: at least 8 characters with a letter and a digit. */
export const passwordRule = z
  .string()
  .min(8, 'At least 8 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one digit');
