import { DataScope, PermissionMap } from '@veetracer/shared';
import { Request } from 'express';

/** Who is calling and in which company they act; built per request from the access token. */
export interface AuthContext {
  userId: string;
  /** The user's own company. */
  homeCompanyId: string;
  /** Effective company: the user's own, or the one selected by the Super Admin via X-Company-Id. */
  companyId: string;
  isSuperAdmin: boolean;
  permissions: PermissionMap;
  dataScope: DataScope;
  branchIds: string[];
  objectIds: string[];
  ip: string | null;
}

export interface AccessTokenPayload {
  sub: string;
  cid: string;
  sa: boolean;
}

export type AuthedRequest = Request & { auth?: AuthContext };
