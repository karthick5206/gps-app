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
  /** Set when the caller is a customer API key (public API v1) instead of a signed-in user. */
  apiKey?: { id: string; name: string; scopes: string[] };
  /** Super Admin only: reason sent in X-Licence-Override to create a user / device without a free licence seat. */
  licenceOverride?: string | null;
}

export interface AccessTokenPayload {
  sub: string;
  cid: string;
  sa: boolean;
  /** Session id: a signed-out session's access tokens stop working immediately. */
  sid?: string;
}

export type AuthedRequest = Request & { auth?: AuthContext };
