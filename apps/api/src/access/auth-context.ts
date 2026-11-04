import { DataScope, PermissionMap } from '@veetracer/shared';
import { Request } from 'express';

/** A vehicle of another company that this company may view (see VehicleShare). */
export interface SharedVehicle {
  objectId: string;
  ownerCompanyId: string;
  /** Nothing from before this time may be shown (ms). */
  startAt: number;
  alertsOn: boolean;
}

/** Who is calling and in which company they act; built per request from the access token. */
export interface AuthContext {
  userId: string;
  /** The user's own company. */
  homeCompanyId: string;
  /** Effective company: the user's own, or the one selected by the Super Admin via X-Company-Id. */
  companyId: string;
  /**
   * Super Admin with X-Company-Id "all": the live map and the vehicle / device / driver lists show every company
   * (see allCompaniesOr). Everything else keeps acting in companyId (the Super Admin's own company).
   */
  allCompanies?: boolean;
  isSuperAdmin: boolean;
  permissions: PermissionMap;
  dataScope: DataScope;
  branchIds: string[];
  objectIds: string[];
  /**
   * Vehicles shared with the company, in force now. Whole-company users only. Read paths opt in to these one by one
   * (objectReadScopeWhere); objectScopeWhere never includes them, so edits and commands can't reach a shared vehicle.
   */
  shares?: SharedVehicle[];
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
