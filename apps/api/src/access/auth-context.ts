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
  /** Login session behind the access token (absent for internal contexts such as sockets or schedulers). */
  sessionId?: string | null;
}

export interface AccessTokenPayload {
  sub: string;
  cid: string;
  sa: boolean;
  /** Session id: a signed-out session's access tokens stop working immediately. */
  sid?: string;
}

export type AuthedRequest = Request & { auth?: AuthContext };
