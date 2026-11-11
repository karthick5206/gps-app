-- ETMS E4 security review fixes (docs/employee-transport/evidence/2026-11-11-e4-secfix.md). Additive only: one unique
-- expression index on "RoutePlan" (an E4 table) and three row triggers. No column is added or changed, no table is
-- rewritten. The only existing (pre-E4) table touched is "TransportTrip", which gets a trigger only (CREATE TRIGGER
-- takes a brief SHARE ROW EXCLUSIVE lock; no scan, no rewrite; lock_timeout 5s below).
--
-- L1  Plan create Idempotency-Key: unique ("companyId", options->>'createKey') where a key is present, so two
--     concurrent creates with one key give one plan (the loser is answered as a replay by plan-create.ts). Raw SQL:
--     Prisma cannot express an expression index and ignores it in `migrate diff` (as the other raw partial indexes).
--
-- L8  Composite tenancy / plan links (defence in depth). Real composite FKs are not used: every link here is
--     ON DELETE SET NULL on a nullable column whose partner column (planId / companyId / providerCompanyId) is NOT NULL,
--     and a composite FK's SET NULL would null the partner too (PostgreSQL 15's column-list SET NULL cannot be modelled
--     in the Prisma schema, so `migrate diff` would no longer be empty). Instead BEFORE INSERT / UPDATE triggers check,
--     whenever a link is set or changed to a non-null value (or the tenant column changes):
--     * RoutePlanStop.assignmentId → a RouteAssignment of the same plan (planId);
--     * RoutingJob.planId          → a RoutePlan of the same company (companyId);
--     * TransportTrip.routePlanId  → a RoutePlan of the trip's operator (providerCompanyId), and
--       TransportTrip.routeAssignmentId → a RouteAssignment of that operator and, when routePlanId is set, of that plan.
--     Clearing a link (SET NULL by an FK action during a plan / assignment purge) is never checked, so no purge path
--     can fail. The single-column FKs stay and keep enforcing existence and the delete actions. A trigger check reads
--     the parent without locking it; RouteAssignment.planId and RoutePlan.companyId are never updated by the code.
--     Violations raise SQLSTATE 23503 (foreign_key_violation) with ids only.
--
-- ROLLBACK: redeploy the previous tag (it never relies on these objects). Manual revert (owner decision only):
--   DROP TRIGGER "TransportTrip_route_link_check" ON "TransportTrip";
--   DROP TRIGGER "RoutingJob_plan_company_check" ON "RoutingJob";
--   DROP TRIGGER "RoutePlanStop_assignment_plan_check" ON "RoutePlanStop";
--   DROP FUNCTION "etms_trip_route_link_check"(); DROP FUNCTION "etms_routing_job_plan_check"();
--   DROP FUNCTION "etms_plan_stop_assignment_check"();
--   DROP INDEX "RoutePlan_companyId_createKey_key";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261119090000_e4_security_hardening';
SET lock_timeout = '5s';

-- L1
CREATE UNIQUE INDEX "RoutePlan_companyId_createKey_key" ON "RoutePlan" ("companyId", (("options" ->> 'createKey'))) WHERE ("options" ? 'createKey');

-- L8: RoutePlanStop (assignmentId, planId) → RouteAssignment (id, planId)
CREATE FUNCTION "etms_plan_stop_assignment_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."assignmentId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."assignmentId" IS DISTINCT FROM OLD."assignmentId" OR NEW."planId" IS DISTINCT FROM OLD."planId")
     AND NOT EXISTS (SELECT 1 FROM "RouteAssignment" a WHERE a."id" = NEW."assignmentId" AND a."planId" = NEW."planId") THEN
    RAISE EXCEPTION 'RoutePlanStop %: route assignment % is not on plan %', NEW."id", NEW."assignmentId", NEW."planId" USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RoutePlanStop_assignment_plan_check" BEFORE INSERT OR UPDATE OF "assignmentId", "planId" ON "RoutePlanStop"
  FOR EACH ROW EXECUTE FUNCTION "etms_plan_stop_assignment_check"();

-- L8: RoutingJob (planId, companyId) → RoutePlan (id, companyId)
CREATE FUNCTION "etms_routing_job_plan_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."planId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."planId" IS DISTINCT FROM OLD."planId" OR NEW."companyId" IS DISTINCT FROM OLD."companyId")
     AND NOT EXISTS (SELECT 1 FROM "RoutePlan" p WHERE p."id" = NEW."planId" AND p."companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'RoutingJob %: plan % does not belong to company %', NEW."id", NEW."planId", NEW."companyId" USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RoutingJob_plan_company_check" BEFORE INSERT OR UPDATE OF "planId", "companyId" ON "RoutingJob"
  FOR EACH ROW EXECUTE FUNCTION "etms_routing_job_plan_check"();

-- L8: TransportTrip (routePlanId, providerCompanyId) → RoutePlan (id, companyId);
--     TransportTrip (routeAssignmentId, providerCompanyId[, routePlanId]) → RouteAssignment (id, companyId[, planId])
CREATE FUNCTION "etms_trip_route_link_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tenant_changed boolean := TG_OP = 'UPDATE' AND NEW."providerCompanyId" IS DISTINCT FROM OLD."providerCompanyId";
BEGIN
  IF NEW."routePlanId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR tenant_changed OR NEW."routePlanId" IS DISTINCT FROM OLD."routePlanId")
     AND NOT EXISTS (SELECT 1 FROM "RoutePlan" p WHERE p."id" = NEW."routePlanId" AND p."companyId" = NEW."providerCompanyId") THEN
    RAISE EXCEPTION 'TransportTrip %: plan % does not belong to operator %', NEW."id", NEW."routePlanId", NEW."providerCompanyId" USING ERRCODE = '23503';
  END IF;
  IF NEW."routeAssignmentId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR tenant_changed OR NEW."routeAssignmentId" IS DISTINCT FROM OLD."routeAssignmentId"
          OR (NEW."routePlanId" IS NOT NULL AND NEW."routePlanId" IS DISTINCT FROM OLD."routePlanId"))
     AND NOT EXISTS (SELECT 1 FROM "RouteAssignment" a WHERE a."id" = NEW."routeAssignmentId" AND a."companyId" = NEW."providerCompanyId"
                     AND (NEW."routePlanId" IS NULL OR a."planId" = NEW."routePlanId")) THEN
    RAISE EXCEPTION 'TransportTrip %: route assignment % does not belong to operator % / plan %', NEW."id", NEW."routeAssignmentId", NEW."providerCompanyId", NEW."routePlanId" USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TransportTrip_route_link_check" BEFORE INSERT OR UPDATE OF "routePlanId", "routeAssignmentId", "providerCompanyId" ON "TransportTrip"
  FOR EACH ROW EXECUTE FUNCTION "etms_trip_route_link_check"();
