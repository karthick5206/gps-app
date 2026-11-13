import { CompanyFeature, DataScope, PermissionMap, TransportDataProfile, TransportGrant } from '@veetracer/shared';
import { Request } from 'express';

/** A vehicle of another company that this company may view (see VehicleShare). */
export interface SharedVehicle {
  objectId: string;
  ownerCompanyId: string;
  /** Nothing from before this time may be shown (ms). */
  startAt: number;
  alertsOn: boolean;
}

/**
 * ETMS (D1): an ACTIVE service agreement in which the acting company is the transport provider, loaded per request like
 * `shares`. The provider acts for `customerCompanyId` only within `grants` and `siteIds`; ctx.companyId never changes.
 */
export interface TransportAgreementScope {
  id: string;
  customerCompanyId: string;
  grants: TransportGrant[];
  /** Customer site (Poi) ids; empty = every customer site. */
  siteIds: string[];
  dataProfile: TransportDataProfile;
  /** ms */
  validFrom: number;
  /** ms; null = open-ended. */
  validTo: number | null;
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
  /**
   * Holds the built-in "Admin" role of the company it acts in (R-12): exempt from the role-grant ceiling, like the
   * Super Admin. The Admin role cannot be renamed or re-scoped, and only callers above the ceiling may edit it.
   */
  isCompanyAdmin?: boolean;
  permissions: PermissionMap;
  dataScope: DataScope;
  branchIds: string[];
  objectIds: string[];
  /**
   * Vehicles shared with the company, in force now. Whole-company users only. Read paths opt in to these one by one
   * (objectReadScopeWhere); objectScopeWhere never includes them, so edits and commands can't reach a shared vehicle.
   */
  shares?: SharedVehicle[];
  /** Add-ons of the acting company (Company.settings.features); module menus are stripped from `permissions` without them. */
  features?: CompanyFeature[];
  /**
   * v1.16: the acting company's own automatic route planning switch (Company.settings.etms.autoRouting). Routing is
   * active only with the platform switch and the env as well (PlanningFeatureGuard, routing-switch.ts).
   */
  autoRouting?: boolean;
  /**
   * ETMS: active agreements where the acting company is the provider (only when the add-on `etms` is on). Read only
   * through access/transport-scope.ts; existing GPS modules never look at it.
   */
  agreements?: TransportAgreementScope[];
  /**
   * ETMS E1b customer context (doc 07 §2.5): the customer company the request is narrowed to (header
   * X-Transport-Customer, validated by TransportFeatureGuard). When set, `agreements` holds only that customer's agreement
   * (none when it is the own company) and own-company rows are hidden when it is another company; `agreementsAll` keeps
   * the unnarrowed list (for the picker).
   */
  transportCustomerId?: string;
  agreementsAll?: TransportAgreementScope[];
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
