import { compare, hash } from 'bcryptjs';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const BCRYPT_COST = 12;

/** ≥ 8 characters with at least one letter and one digit. */
export const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
export const PASSWORD_MESSAGE = 'Password must be at least 8 characters and contain a letter and a digit';
export const MOBILE_PATTERN = /^\+[1-9]\d{7,14}$/;
export const MOBILE_MESSAGE = 'Mobile must be in E.164 format, e.g. +919876543210';

export const hashPassword = (password: string): Promise<string> => hash(password, BCRYPT_COST);
export const verifyPassword = (password: string, passwordHash: string): Promise<boolean> => compare(password, passwordHash);

/** Random URL-safe token. */
export const randomToken = (bytes: number): string => randomBytes(bytes).toString('base64url');

/** Hash for high-entropy tokens stored at rest (refresh tokens, reset tokens). */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const hmac = (secret: string, value: string): string => createHmac('sha256', secret).update(value).digest('hex');
