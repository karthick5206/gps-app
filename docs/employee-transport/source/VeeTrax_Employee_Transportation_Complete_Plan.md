# VeeTrax Employee Transportation Management System (ETMS)

(Owner's blueprint as provided 2026-11-11, stored verbatim in substance for E0 agents. Baseline facts in §3 and §20
are outdated; `../00-e0-brief.md` §1 is authoritative for the current state.)

## Complete Architecture and Multi-Agent Implementation Plan

**Scope:** Corporate-managed transportation and transport providers serving multiple corporate customers; ad-hoc and
scheduled journeys; India and US markets; web dispatcher/admin experience, Employee App and Driver App.

**Status:** Proposed blueprint. Repository validation is mandatory before implementation.

## 1. Executive summary

Build ETMS as a first-class module inside the existing VeeTrax platform. Do not create a greenfield replacement.

The system must support: companies managing their own employee transportation; transport operators managing multiple
corporate customers; ad-hoc and recurring bookings; door-to-door cars, sedans, SUVs and vans; roadside shuttles using
designated pickup/drop-off stops; mixed fleets and capacity-aware assignment; employee self-service through an
Employee App; driver duty and trip execution through a Driver App; dispatcher and administrator workflows in the
existing VeeTrax web app; employee safety, SOS, trip monitoring, notifications and analytics.

**Reuse-first rule:** Existing authentication, tenants, users, vehicles, drivers, GPS telemetry, notifications, audit,
billing, routing and database conventions must be inspected and reused where their semantics fit. Do not create
duplicate registries, services, queues, routing engines or databases without a documented reason.

## 2. Product decisions

| Area | Decision |
|---|---|
| Customer model | Corporate self-managed + transport provider managing multiple corporate customers |
| Booking | Ad-hoc + scheduled/recurring |
| Market | India + US, international-ready |
| Web | Extend existing VeeTrax React app |
| Employee App | Extend existing Expo app if architecture supports it |
| Driver App | Extend existing Expo app if architecture supports it |
| Backend | Existing NestJS architecture |
| Database | Existing PostgreSQL/Prisma architecture |
| Routing | Existing VeeTrax routing work through an adapter |
| Notifications | Reuse existing email/SMS/push services |
| Rollout | Feature flags, staged pilot, explicit production approval |

## 3. Existing VeeTrax architecture to preserve and verify

Known baseline from previous project work: TypeScript monorepo; NestJS 11 backend; React 19, Vite, Tailwind and
MapLibre web app; PostgreSQL and Prisma; Valkey/Redis-compatible infrastructure; PM2-managed services; existing Expo
mobile applications; API, TCP gateway, stream processor, notifier and summarizer services; GPS protocol support
including Concox GT06, Teltonika, AIS-140 and JT808/JT1078; existing users/roles, vehicles/devices, annual device
licensing, notifications, audit, billing and reports.

Treat this as a discovery baseline, not as verified current repository state. E0 must inspect the actual branch and
confirm package names, module paths, Prisma models, API routes, queue/event contracts, mobile navigation, permissions
and notification providers.

### 3.1 Existing routing work

The existing routing workstream has historically included: Valhalla for road routing, route calculation and map
matching; OpenStreetMap regional/India graph preparation; OR-Tools as a separate Python optimization worker; NestJS
orchestration and routing API; MapLibre integration; background optimization jobs with progress, retries, timeout,
cancellation and recovery; route plans, versions, stop editing, vehicle/driver assignment, publishing and audit;
company isolation and usage metering; feature flags including `ROUTING_ENGINE_V2` and a web routing flag.

Historical caveats from the last known status: routing was not production-ready; routing feature flags were off; full
India graph hosting needed a separately sized environment (unsuitable for the known 4 GB production server);
geocoding and ETA calibration had outstanding gaps; no routing server provisioning or production rollout had been
approved. Claude must inspect the latest branch, commits, APIs, migrations and tests. Do not assume these historical
statuses remain unchanged.

### 3.2 Routing integration architecture

ETMS must consume routing through a stable `RoutingProvider`/adapter interface. Business modules must not depend
directly on Valhalla or OR-Tools implementation details. The adapter should expose: route calculation; distance/time
matrix; stop sequencing; optimization job submission; job status, progress and cancellation; route geometry and leg
details; map matching/live-route comparison where supported; constraint violation and infeasibility explanations;
provider capability/health information.

ETMS administration and booking must remain available if routing is down. Routing-dependent actions must show a clear
degraded/unavailable state; never invent ETA or distance. Authorized manual dispatch may be allowed by policy. Do not
turn on the unfinished routing engine or provision infrastructure as part of E0.

### 3.3 Existing database architecture

Use the current PostgreSQL and Prisma conventions. No second database or parallel ORM. E0 must inspect:
Company/Tenant and user models; roles, permissions and auth guards; employee/person models; vehicle, driver and device
relationships; GPS telemetry references; notification and delivery models; audit/event models; billing and annual
device licensing; existing routing schema and migration chain. Reuse matching entities. Extend only where safe. Create
ETMS-specific tables only for new domain concepts. Avoid duplicate master records. Use explicit foreign keys, indexes,
unique constraints, tenant ownership and documented delete/retention behavior. All early migrations additive and
rollback-aware. No production database migration without explicit approval.

## 4. Three connected product experiences

### 4.1 Web application: Corporate Admin, Provider Admin and Dispatcher

Extend the existing VeeTrax React app and design system.

**Corporate administrator:** manage employees, locations, shifts, holidays and policies; manage approved vehicles,
drivers and vendors; create recurring schedules; review ad-hoc bookings; view trips, costs, reports and authorized
incidents.

**Transport provider administrator:** manage multiple corporate customer accounts; manage service agreements,
operating zones and fleet allocations; assign drivers and vehicles to customer contracts; configure customer-specific
rules; monitor provider operations and customer service levels; never access unrelated customers or providers.

**Dispatcher:** view bookings, unassigned passengers, vehicles, occupancy and driver status; create and assign trips;
optimize routes and compare scenarios; reassign passengers, vehicles and drivers; handle delays, breakdowns,
cancellations and safety alerts; publish route versions and audit manual changes.

Suggested navigation: 1 Transport Dashboard, 2 Corporate Customers / Providers, 3 Employees, 4 Bookings, 5 Schedules
and Shifts, 6 Vehicles, 7 Drivers, 8 Pickup and Shuttle Stops, 9 Routes and Optimization, 10 Live Dispatch, 11 Trips,
12 Safety Policies, 13 Incidents and SOS, 14 Notifications, 15 Reports and Analytics, 16 Service Agreements / Costing,
17 Configuration and Audit. Preserve VeeTrax branding and existing functionality. Accessible status/progress cues,
restrained animation; do not obscure dispatch data or disrupt workflows.

### 4.2 Employee App

Use the existing Expo application if it supports secure role-based navigation. No separate binary until E0
demonstrates a technical, security, app-store or operational reason.

**Onboarding and profile:** secure login through existing VeeTrax authentication; organization-approved employee
activation; employee ID and corporate account; contact information and emergency contact; home/default pickup and
office destination; preferred pickup point; accessibility/special transport requirements; language and notification
preferences; clear location-sharing explanation and controls.

**Ad-hoc booking:** pickup from saved address, map pin or explicitly shared current location; destination, date and
pickup time; one-way or round trip; passenger count where policy permits; preferred mode (car, shuttle, accessible
vehicle or automatic); approved shuttle stop or door-to-door where allowed; booking status and reliable estimated
pickup window; submit, modify or cancel according to policy; assignment and necessary driver/vehicle information.

**Scheduled transport:** view recurring commute; subscribe to approved office/home services; request schedule
changes; pause or cancel future trips within cut-off rules; report leave/non-attendance where HR integration permits;
view upcoming trip instances.

**Trip-day experience:** booking confirmation; driver/vehicle assignment; vehicle approaching status and ETA when
reliable; pickup reminder; pickup confirmation; live vehicle tracking during the authorized trip window; drop-off
confirmation and trip completion; delay, missed pickup or breakdown reporting.

**Safety:** prominent SOS during an active trip; emergency contact access; report incident or concern; share trip
status with approved contacts where configured; receive emergency updates; accessible alternatives to map-only
interaction.

**Employee privacy:** no continuous tracking merely because of a profile; prefer registered or explicitly selected
pickup points; request GPS only when the employee chooses it and OS permission is granted; explain purpose and
duration; restrict live location to an authorized trip/time window; stop collection when the window ends; handle
denied permission and unavailable GPS; never expose other passengers' personal details or addresses.

### 4.3 Driver App

Use the existing Expo application with a distinct driver navigation shell and server-enforced permissions. Separate
binary only if justified by E0.

**Driver onboarding and duty:** secure driver login; driver profile and assigned provider; licence/document and
verification status; assigned vehicle and permitted corporate accounts; availability, shift and operating zone;
emergency contact; notification and connectivity checks.

**Driver trip workflow:** view today's duty and assigned trips; acknowledge assignment; view vehicle and ordered
stops; start duty/trip; navigate to next stop; mark arrived; confirm passenger pickup; mark no-show with reason;
continue stop sequence; confirm drop-off; complete trip; report delay, breakdown, obstruction or incident; request
dispatcher assistance; trigger SOS.

**Driver privacy and safety:** only passengers of the active trip; contact details only when operationally
necessary; never the full employee directory; shuttle shows stop and passenger counts, individual details only when
required; hide sensitive trip data after completion per policy; avoid distracting interactions while moving; mandatory
pre-trip checks; block trip start if driver, vehicle or safety checks fail; record trip events with timestamp, actor
and source.

**Offline and poor-network support:** clear offline/pending-sync state; queue permissible trip events locally in
secure storage; idempotency keys and server reconciliation; never show an event as server-confirmed until
acknowledged; resolve conflicting or out-of-order events safely; offline mode never bypasses safety or authorization.

Suggested Driver App navigation: Duty Dashboard, Assigned Trips, Trip Details, Stop-by-stop Navigation, Passenger
Pickup/Drop, Vehicle and Duty Checks, Incident / SOS, Notifications, Trip History, Profile and Documents.

### 4.4 Shared mobile foundations

Employee and Driver may share: authentication foundation, secure token storage, API client, push registration,
localization, design primitives, connectivity monitoring, crash reporting and telemetry, accessibility patterns. They
must not share authorization assumptions; backend permission checks on every request.

## 5. Customer and tenancy model

Two operating models. **Corporate-managed:** one corporate customer manages its employees, fleet, drivers, schedules,
bookings, policies and dispatch. **Provider-managed:** one transport provider manages multiple corporate customers
through explicit service agreements.

Conceptual relationships: VeeTrax tenant/company; transport provider account; corporate customer account;
provider-customer service agreement; operating location and service zone; fleet and driver allocation; employee
transport profile; booking and trip. A provider may access only customers linked by an active agreement and only
within assigned scope. Employee data belongs to the corporate customer; the provider receives minimum necessary
information. Do not assume current VeeTrax Company maps one-to-one to provider or customer; determine actual
semantics from Prisma schema and auth code.

## 6. Backend domain modules

Transport Accounts (provider, corporate customer, service agreement); Employee Transport (profile, preferences,
emergency contacts); Fleet Integration (existing vehicle/device references and transport attributes); Driver
Management (profile, availability, documents, duty); Booking (ad-hoc lifecycle); Scheduling (recurrence, shifts,
exceptions, trip generation); Stops (shuttle stops, pickup zones, access rules); Policy Engine (eligibility, capacity,
safety, service constraints); Routing Adapter; Optimization (job orchestration, scenarios, proposals); Dispatch
(manual assignment, dispatch, publishing); Trip Execution (driver and passenger events); Safety (SOS, incidents,
deviations, escalation); Notifications (templates, delivery, retries); Analytics; Billing Integration (existing
billing/licensing). Business rules belong in backend domain services, not controllers or mobile clients.

## 7. Routing and optimization

**Door-to-door:** pickup at approved employee location; minimize walking; group passengers when practical; respect
road access, vehicle type and safety; support individual journeys where grouping is unsuitable.

**Roadside shuttle:** designated pickup/drop stops; avoid routing shuttles into every residential street; walking
distance to approved stops; max walking distance and accessible-stop rules; group along common corridors, reduce
detours; respect dwell time and boarding capacity.

**Mixed fleet:** shuttles for dense corridors; cars/vans for dispersed passengers, special needs or time constraints;
compare alternatives with consistent assumptions; explain unassigned passengers.

**Inputs:** pickup/destination coordinates; pickup time windows and shift times; vehicle type and capacity; driver
availability and duty limits; vehicle availability and operating zone; road restrictions and access; shuttle stop
definitions; maximum walking distance; maximum passenger ride duration; maximum pickup delay; accessibility needs;
customer policies and mandatory safety requirements; operating cost assumptions.

**Hard constraints:** safety compliance; vehicle capacity; driver qualification and availability; vehicle
suitability and access; service agreement and operating zone; mandatory time and accessibility rules.

**Soft objectives:** minimize total distance; passenger travel time; walking distance; pickup/drop delays; empty
kilometres; fleet count where service quality is maintained; improve occupancy within comfort/capacity; minimize
operating cost. Never trade away safety or capacity constraints for a shorter route.

**Failure behavior:** bookings durable if routing unavailable; degraded state, no fabricated ETA/distance; authorized
manual dispatch if policy allows; recoverable, idempotent optimization jobs; revalidate assignment before publishing.

## 8. Database architecture and conceptual entities

Use existing PostgreSQL/Prisma. Candidate concepts, not a mandate; first map to existing models.

Reuse mapping: tenant/company (reuse if semantics fit); user/auth (reuse); employee (extend existing person/user
model?); vehicle (reuse registry); GPS device (reference existing device/vehicle relationship); driver (reuse
existing Driver if present, else transport profile); notifications (reuse delivery infrastructure); audit (reuse);
billing (integrate without changing annual device licensing); route/optimization (integrate with current routing
work/schema).

Candidate new concepts: **accounts and services** (transport_provider_accounts, corporate_transport_accounts,
transport_service_agreements, transport_operating_locations, transport_operating_zones, transport_fleet_allocations);
**employee** (employee_transport_profiles, employee_transport_preferences, employee_emergency_contacts,
employee_location_consent_records); **driver and vehicle** (transport_driver_profiles only if Driver cannot be
extended, transport_driver_availability, transport_driver_documents, transport_vehicle_profiles only for fields not
suitable on Vehicle, transport_vehicle_availability, transport_vehicle_assignments); **stops and schedules**
(transport_pickup_stops, transport_stop_access_rules, transport_shift_definitions, transport_schedules,
transport_schedule_exceptions, transport_schedule_instances); **bookings and trips** (transport_bookings,
transport_booking_passengers, transport_trips, transport_trip_passengers, transport_trip_stops, transport_trip_events,
transport_trip_versions); **safety and optimization** (transport_safety_policies, transport_safety_policy_versions,
transport_safety_evaluations, transport_incidents, transport_escalation_events, transport_optimization_jobs,
transport_optimization_results/proposal snapshots, transport_cost_records).

For each entity define: PK convention; tenant/customer/provider ownership; FKs and delete behavior; unique
constraints and indexes; timestamps; actor/audit references; state transitions; retention and archival;
personal-data classification. Potential indexes: tenant + customer + status; tenant + pickup time; vehicle + trip
interval; driver + duty interval; employee + booking date; trip + event timestamp. Geospatial indexes only if
supported by current conventions. Prevent duplicate booking, double vehicle/driver assignment, capacity
over-allocation and cross-tenant references with transactions and constraints. Do not store a duplicate GPS stream in
ETMS tables; reference existing telemetry. Migration discipline: additive first; no destructive changes early;
reviewed backfills; test fresh DB and production-like copy; test tenant purge; document rollback/forward-fix; no
production migration without approval.

## 9. Booking and trip lifecycle

Booking: `REQUESTED -> VALIDATING -> PENDING_ASSIGNMENT -> ASSIGNED -> CONFIRMED`; exceptions `REJECTED`,
`CANCELLED`, `EXPIRED`, `WAITLISTED`, `FAILED`. Acceptance and vehicle assignment may be separate.

Trip: `PLANNED -> PUBLISHED -> DRIVER_ACKNOWLEDGED -> DRIVER_EN_ROUTE -> ARRIVED_AT_PICKUP -> BOARDING -> IN_PROGRESS
-> ARRIVED_AT_DROPOFF -> COMPLETED`; exceptions `CANCELLED`, `DELAYED`, `NO_SHOW`, `BREAKDOWN`, `EMERGENCY`,
`INTERRUPTED`. Explicit events for audit and reconstruction; mobile clients must not set arbitrary states. Recurring
schedules: time zones, overnight shifts, holidays, exceptions, idempotent rolling-horizon generation, US DST.

## 10. Safety, SOS and privacy

Configurable safety policy: verified driver and vehicle; driver qualification; escort requirement; female-driver
preference/requirement where lawful; passenger grouping restrictions; approved stops and zones; late-night rules; trip
sharing; SOS escalation; route deviation/unexpected stop; pickup/drop confirmation. No hardcoded universal female
employee rule; policies configurable, versioned, explainable, reviewed for local law.

Policy evaluation before assignment: resolve policy version; evaluate employee, journey, driver, vehicle, shift;
pass / warning / block; record version and reasons; override only where allowed; audit overrides; re-evaluate on
changes.

SOS: employee or driver activates; durable incident; notify dispatcher/escalation contacts with trip and vehicle
context and last known location with timestamp; retry and record delivery; escalate unacknowledged; record
acknowledgement, action, resolution; restrict access. Never claim delivery without provider status/ack; offline
fallback instructions.

Access control: server-side authorization everywhere; provider limited to contracted customers; driver sees assigned
trips and minimum data; employee sees own; dispatcher limited to scope; live employee location only for authorized
purpose and time; audit sensitive access; minimize personal data in logs; configurable retention.

## 11. Notifications and events

Reuse existing delivery infrastructure. Channels: push, SMS, email, in-app. Events: booking
submitted/accepted/rejected/changed/cancelled; driver/vehicle assigned; approaching/arrived; pickup reminder and
confirmation; trip started/completed; delay, deviation, breakdown; SOS and escalation; schedule change and duty
update. Requirements: template versioning and localization; India/US phone formatting; preferences for non-critical;
mandatory safety messages per policy; retry, dead-letter, dedup, delivery status; provider message and correlation
IDs; no secrets/unnecessary personal data in logs. Versioned event schemas (event ID, tenant/customer scope,
aggregate ID, timestamp, actor/source, idempotency/correlation key). Potential events: BookingCreated,
BookingCancelled, BookingAssigned, ScheduleInstanceGenerated, OptimizationRequested, OptimizationCompleted,
RoutePublished, DriverAcknowledged, TripStarted, PassengerPickedUp, PassengerDroppedOff, VehicleDelayed,
SafetyPolicyBlocked, IncidentCreated, SOSActivated, TripCompleted. No second event infrastructure if current services
meet durability needs.

## 12. API groups

Employees; Bookings; Schedules; Fleet; Drivers; Stops; Dispatch (board, optimize, job status/cancel, manual
assignment, publish/recalculate); Driver trip (start duty/trip, arrive, pickup/no-show, drop, complete, incident,
SOS); Safety (policy evaluation, incident lifecycle); Analytics. Idempotency keys for booking creation and trip
events; server-side permissions, tenant scope, state transitions, rate limits, audit.

## 13. Dispatcher UI and scenario comparison

Live board: pending bookings and unassigned passengers; vehicles, occupancy, driver status; active routes and trips;
delays, missed pickups, alerts; SOS/incidents; routing/optimization health. Actions: assign/reassign; add/remove
passenger; change pickup stop; change vehicle type; optimize/re-optimize; compare scenarios; publish route version;
cancel/suspend trip; escalate incident. Compare cars, shared cars, vans, shuttle and mixed fleet by distance and
time, fleet count and occupancy, walking distance, ride time, punctuality feasibility, cost estimate, unassigned
passengers, constraint warnings. No cost estimates without configured inputs; label uncalibrated ETAs.

## 14. Reports and analytics

Daily operations; booking history; ad-hoc vs scheduled; vehicle/driver utilization; occupancy; route
distance/duration; empty km; pickup/drop punctuality; no-shows and cancellations; shuttle vs car efficiency;
unassigned reasons; safety incidents and response times; customer-wise service performance; cost per employee/trip.
All reports enforce tenant/customer permissions.

## 15. India and US localization

Country-aware configuration, not forks: phone validation; time zones and DST; address formats; localized
dates/numbers; currency and tax; holidays; customer/country safety policy; templates and languages;
retention/privacy settings. Legal review before enabling mandatory safety or employee-monitoring policies.

## 16. Multi-agent plan (summary)

Agent 0 Lead Architect / Integrator; Agent 1 Platform & Database Auditor; Agent 2 Routing & Optimization Auditor;
Agent 3 Web UX / Dispatcher Architect; Agent 4 Employee App Architect; Agent 5 Driver App Architect; Agent 6
Security, Safety & Privacy Auditor; Agent 7 QA, Reliability & Performance Architect. Coordination: Lead defines
terminology first; Agents 1–7 read-only during E0; record exact paths and evidence; separate verified facts from
proposals; Agent 1 owns DB mapping, Agent 2 routing contract, Lead approves; no competing schema/contract edits; no
deployment, paid resources, production config or destructive DB operations; Lead reviews all outputs.

Phases: E0 discovery; E1 account/authorization; E2 employee/driver/fleet; E3 booking & scheduling; E4 routing &
optimization; E5 driver operations & notifications; E6 safety; E7 dispatcher & analytics; E8 integrations &
localization; E9 hardening & pilot. Dependency gates between phases.

## 17. Exit criteria (summary)

E0 architecture explicitly approved, no implementation. E1 cross-tenant tests pass, existing customers unaffected.
E2 no duplicate master records, ownership/capacity tested. E3 booking/schedule E2E tests. E4 routing corpus passes,
outage degrades safely, no false ETA. E5 driver-to-employee lifecycle E2E. E6 mandatory violations block assignment,
emergency workflow and delivery status tested. E7 dispatchers manage normal and exception journeys. E8
integration/localization suites. E9 signed acceptance, rollback plan, monitoring, explicit deployment approval.

## 18. Tests and acceptance (summary)

Functional: both customer models; ad-hoc and recurring; self-service; driver duty; capacity, shuttle, door-to-door,
mixed fleet; notifications, SOS, incidents. Security: cross-tenant denied; provider limited; driver limited; employee
limited; sensitive access audited; location permissions server-side. Routing: capacity never exceeded; safety never
violated; shuttle uses designated stops; walking limit; unassigned reasons; no fabricated ETA; manual edits versioned.
Reliability: idempotency; queue retry; cache outage; worker restart; mobile offline sync; notification failure;
concurrent dispatcher edits. Performance: large imports; booking volume; multi-customer optimization; large fleets;
live refresh; poor connectivity.

## 19–20. Commercial and guardrails

Integrate with existing billing and annual device licensing; do not convert to monthly. Future pricing dimensions not
in E0. Guardrails: no paid infra, no public endpoints, no production deployment or migration without approval, no
firewall/SSH/service changes, synthetic data only, ETMS and routing flags off until approved.

## 21–22. E0 deliverables and final assignment

Docs under `docs/employee-transport/` (README, 01–13). E0 only; multiple agents for read-only discovery; Lead
integrates. Answer the twelve questions (see `../00-e0-brief.md` §5) with repository evidence. Final report: branch
and commit; files inspected; agent outputs; verified vs proposed; reuse matrix; ERD and API contracts; routing
readiness and risks; Employee and Driver screen maps; E1–E9 backlog with dependencies and estimates; tests and
acceptance. **Stop after E0.** Never claim completion without command output or repository evidence.
