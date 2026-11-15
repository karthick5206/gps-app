import { MENUS, type MenuKey } from '@veetracer/shared';
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { SignupPage } from '@/features/auth/SignupPage';
import { ClaimPage } from '@/features/claim/ClaimPage';
import { GuidePage } from '@/features/guide/GuidePage';
import { TroubleshootingPage } from '@/features/guide/TroubleshootingPage';
import { DownloadPage } from '@/features/download/DownloadPage';
import { PublicSharePage } from '@/features/live-share/PublicSharePage';
import { DeleteAccountPage, PrivacyPage } from '@/features/legal/LegalPages';
import { RedirectIfAuthenticated, RequireAuth, RequirePermission } from '@/features/auth/guards';
import { LoginPage } from '@/features/auth/LoginPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { ForbiddenPage, NotFoundPage, UnexpectedErrorPage } from '@/features/errors/ErrorPages';
import { AppShell } from '@/features/shell/AppShell';

function page<M extends Record<string, unknown>>(loader: () => Promise<M>, name: keyof M): LazyExoticComponent<ComponentType> {
  return lazy(() => loader().then((m) => ({ default: m[name] as ComponentType })));
}

/** One page per menu; paths come from MENUS so navigation and routing never drift apart. */
const PAGES: Record<MenuKey, LazyExoticComponent<ComponentType>> = {
  dashboard: page(() => import('@/features/dashboard/DashboardPage'), 'DashboardPage'),
  live_map: page(() => import('@/features/live/LiveMapPage'), 'LiveMapPage'),
  video: page(() => import('@/features/video/VideoPage'), 'VideoPage'),
  driver_events: page(() => import('@/features/driver-events/DriverEventsPage'), 'DriverEventsPage'),
  dms: page(() => import('@/features/dms/DmsPage'), 'DmsPage'),
  objects: page(() => import('@/features/masters/pages/ObjectsPage'), 'ObjectsPage'),
  drivers: page(() => import('@/features/masters/pages/DriversPage'), 'DriversPage'),
  documents: page(() => import('@/features/documents/DocumentsPage'), 'DocumentsPage'),
  devices: page(() => import('@/features/masters/pages/DevicesPage'), 'DevicesPage'),
  vehicle_groups: page(() => import('@/features/masters/pages/VehicleGroupsPage'), 'VehicleGroupsPage'),
  branches: page(() => import('@/features/masters/pages/BranchesPage'), 'BranchesPage'),
  lookups: page(() => import('@/features/masters/pages/LookupsPage'), 'LookupsPage'),
  users: page(() => import('@/features/admin/UsersPage'), 'UsersPage'),
  roles: page(() => import('@/features/admin/RolesPage'), 'RolesPage'),
  audit_log: page(() => import('@/features/admin/AuditLogPage'), 'AuditLogPage'),
  settings: page(() => import('@/features/admin/SettingsPage'), 'SettingsPage'),
  api: page(() => import('@/features/developer/DeveloperApiPage'), 'DeveloperApiPage'),
  sa_companies: page(() => import('@/features/platform/CompaniesPage'), 'CompaniesPage'),
  sa_device_models: page(() => import('@/features/platform/DeviceModelsPage'), 'DeviceModelsPage'),
  sa_device_inventory: page(() => import('@/features/platform/DeviceInventoryPage'), 'DeviceInventoryPage'),
  sa_inventory: page(() => import('@/features/inventory/InventoryPage'), 'InventoryPage'),
  sa_sim_cards: page(() => import('@/features/sims/SimCardsPage'), 'SimCardsPage'),
  sa_unknown_devices: page(() => import('@/features/platform/UnknownDevicesPage'), 'UnknownDevicesPage'),
  sa_licences: page(() => import('@/features/billing/admin/LicencesAdminPage'), 'LicencesAdminPage'),
  sa_platform_settings: page(() => import('@/features/billing/admin/PlatformSettingsPage'), 'PlatformSettingsPage'),
  billing: page(() => import('@/features/billing/BillingPage'), 'BillingPage'),
  sa_system_health: page(() => import('@/features/platform/SystemHealthPage'), 'SystemHealthPage'),
  sa_relay: page(() => import('@/features/platform/relay/DataForwardingPage'), 'DataForwardingPage'),
  history: page(() => import('@/features/history/HistoryPage'), 'HistoryPage'),
  reports: page(() => import('@/features/reports/ReportsPage'), 'ReportsPage'),
  report_schedules: page(() => import('@/features/reports/ScheduledReportsPage'), 'ScheduledReportsPage'),
  alerts: page(() => import('@/features/alerts/AlertsPage'), 'AlertsPage'),
  parking_mode: page(() => import('@/features/parking/ParkingModePage'), 'ParkingModePage'),
  driver_scores: page(() => import('@/features/driver-scores/DriverScoresPage'), 'DriverScoresPage'),
  attendance: page(() => import('@/features/attendance/AttendancePage'), 'AttendancePage'),
  expenses: page(() => import('@/features/expenses/ExpensesPage'), 'ExpensesPage'),
  stock: page(() => import('@/features/stock/StockPage'), 'StockPage'),
  geofences: page(() => import('@/features/geofences/GeofencesPage'), 'GeofencesPage'),
  pois: page(() => import('@/features/pois/PoisPage'), 'PoisPage'),
  routes: page(() => import('@/features/routes/RoutesPage'), 'RoutesPage'),
  plannedTrips: page(() => import('@/features/planned-trips/PlannedTripsPage'), 'PlannedTripsPage'),
  // Employee transport (ETMS, E1a): menus exist only while the company add-on etms is on (permissions are stripped server-side).
  etms_dashboard: page(() => import('@/features/transport/TransportDashboardPage'), 'TransportDashboardPage'),
  etms_partners: page(() => import('@/features/transport/PartnersPage'), 'PartnersPage'),
  // E2: passengers (list, editor, import, consent, app access).
  etms_passengers: page(() => import('@/features/transport/PassengersPage'), 'PassengersPage'),
  // E3: shifts & schedules, bookings, dispatch board (WP 3.4–3.5).
  etms_schedules: page(() => import('@/features/transport/dispatch/ShiftsSchedulesPage'), 'ShiftsSchedulesPage'),
  etms_bookings: page(() => import('@/features/transport/dispatch/BookingsPage'), 'BookingsPage'),
  etms_dispatch: page(() => import('@/features/transport/dispatch/DispatchPage'), 'DispatchPage'),
  // E4 WP 4.5: route planner (web flag etmsRouting + API ETMS_ROUTING; the page checks both).
  etms_planning: page(() => import('@/features/transport/planning/PlanningPage'), 'PlanningPage'),
  // E5 WP 5.4: the open SOS lane (acknowledge / resolve).
  etms_incidents: page(() => import('@/features/transport/incidents/IncidentsPage'), 'IncidentsPage'),
  etms_settings: page(() => import('@/features/transport/TransportSettingsPage'), 'TransportSettingsPage'),
  etms_vendors: page(() => import('@/features/transport/vendors/VendorsPage'), 'VendorsPage'),
  etms_billing: page(() => import('@/features/transport/vendors/VendorBillingPage'), 'VendorBillingPage'),
  // E3 WP 3.6: the passenger's own bookings and trips (vehicle only inside the trip window).
  etms_self: page(() => import('@/features/transport/dispatch/MyTransportPage'), 'MyTransportPage'),
  etms_driver: page(() => import('@/features/transport/MobileAppOnlyPage'), 'MyTransportDutyPage'),
  // Doc 19 pricing area: placeholder until the Pricing UI lands (the API is behind the pricing add-on).
  pricing: page(() => import('@/features/pricing/PricingDashboardPage'), 'PricingDashboardPage'),
  pricing_contracts: page(() => import('@/features/pricing/ContractsPage'), 'ContractsPage'),
  pricing_vehicle_rates: page(() => import('@/features/pricing/VehicleRatesPage'), 'VehicleRatesPage'),
  pricing_trip_charges: page(() => import('@/features/pricing/TripChargesPage'), 'TripChargesPage'),
  pricing_availability: page(() => import('@/features/pricing/AvailabilityPage'), 'AvailabilityPage'),
  pricing_invoices: page(() => import('@/features/pricing/InvoicesPage'), 'InvoicesPage'),
  pricing_adjustments: page(() => import('@/features/pricing/AdjustmentsPage'), 'AdjustmentsPage'),
  pricing_reports: page(() => import('@/features/pricing/PricingReportsPage'), 'PricingReportsPage'),
  pricing_costs: page(() => import('@/features/pricing/OperatingCostsPage'), 'OperatingCostsPage'),
  alert_settings: page(() => import('@/features/alerting/AlertSettingsPage'), 'AlertSettingsPage'),
  message_templates: page(() => import('@/features/templates/TemplatesPage'), 'TemplatesPage'),
};

/** Detail pages inside a menu (same permission as the menu). */
const PlannedTripDetailPage = page(() => import('@/features/planned-trips/PlannedTripDetailPage'), 'PlannedTripDetailPage');
const TransportTripDetailPage = page(() => import('@/features/transport/dispatch/TransportTripDetailPage'), 'TransportTripDetailPage');
/** v1.16.12: one vendor on one page (details, branches, vehicles with type / seats / rate applied, drivers, rates). */
const VendorDetailPage = page(() => import('@/features/transport/vendors/VendorDetailPage'), 'VendorDetailPage');
/** Doc 19 pricing detail screens (same permission as their menu). */
const ContractDetailPage = page(() => import('@/features/pricing/ContractDetailPage'), 'ContractDetailPage');
const TripChargeDetailPage = page(() => import('@/features/pricing/TripChargeDetailPage'), 'TripChargeDetailPage');
const InvoiceDetailPage = page(() => import('@/features/pricing/InvoiceDetailPage'), 'InvoiceDetailPage');
const PricingSettingsPage = page(() => import('@/features/pricing/PricingSettingsPage'), 'PricingSettingsPage');
const PlanReviewPage = page(() => import('@/features/transport/planning/PlanReviewPage'), 'PlanReviewPage');
/** E4 WP-W: review & publish selected routes of a plan. */
const PlanPublishPage = page(() => import('@/features/transport/planning/PlanPublishPage'), 'PlanPublishPage');
const AgreementDetailPage = page(() => import('@/features/transport/AgreementDetailPage'), 'AgreementDetailPage');
/** E1b: the customer's sensitive-access log (static path, ranked above /transport/partners/:id). */
const AccessLogPage = page(() => import('@/features/transport/AccessLogPage'), 'AccessLogPage');
/** E2 vehicle seats: a fleet screen of the transport module (permission objects; the page checks the etms add-on). */
const VehicleSeatsPage = page(() => import('@/features/transport/VehicleSeatsPage'), 'VehicleSeatsPage');

function PageFallback() {
  return (
    <div className="space-y-4 p-6" aria-busy>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

/** `/` goes to the first menu the user can view. */
function HomeRedirect() {
  const { can } = useAuth();
  const first = MENUS.find((m) => can(m.key));
  return first ? <Navigate to={first.path} replace /> : <ForbiddenPage />;
}

export const router = createBrowserRouter([
  {
    element: <RedirectIfAuthenticated />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/signup', element: <SignupPage /> },
    ],
  },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  // Public: linked from the mobile apps, help sheets and emails.
  { path: '/guide', element: <GuidePage /> },
  { path: '/guide/troubleshooting', element: <TroubleshootingPage /> },
  { path: '/download', element: <DownloadPage /> },
  { path: '/privacy', element: <PrivacyPage /> },
  // Live location share link: anyone with the link, no sign-in.
  { path: '/share/:token', element: <PublicSharePage /> },
  // Interactive deletion page. App stores get the static public/delete-account.html (readable without JavaScript).
  { path: '/delete-account', element: <DeleteAccountPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        errorElement: <UnexpectedErrorPage />,
        children: [
          { index: true, element: <HomeRedirect /> },
          ...MENUS.map((m) => {
            const Page = PAGES[m.key];
            return {
              path: m.path,
              element: (
                <RequirePermission menu={m.key}>
                  <Suspense fallback={<PageFallback />}>
                    <Page />
                  </Suspense>
                </RequirePermission>
              ),
            };
          }),
          {
            path: '/planned-trips/:id',
            element: (
              <RequirePermission menu="plannedTrips">
                <Suspense fallback={<PageFallback />}>
                  <PlannedTripDetailPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/transport/partners/access-log',
            element: (
              <RequirePermission menu="etms_partners">
                <Suspense fallback={<PageFallback />}>
                  <AccessLogPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/transport/partners/:id',
            element: (
              <RequirePermission menu="etms_partners">
                <Suspense fallback={<PageFallback />}>
                  <AgreementDetailPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/vendors/:id',
            element: (
              <RequirePermission menu="etms_vendors">
                <Suspense fallback={<PageFallback />}>
                  <VendorDetailPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/transport/trips/:id',
            element: (
              <RequirePermission menu="etms_dispatch">
                <Suspense fallback={<PageFallback />}>
                  <TransportTripDetailPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/transport/planning/:id/publish',
            element: (
              <RequirePermission menu="etms_planning">
                <Suspense fallback={<PageFallback />}>
                  <PlanPublishPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/transport/planning/:id',
            element: (
              <RequirePermission menu="etms_planning">
                <Suspense fallback={<PageFallback />}>
                  <PlanReviewPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/transport/vehicles',
            element: (
              <RequirePermission menu="objects">
                <Suspense fallback={<PageFallback />}>
                  <VehicleSeatsPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/claim',
            element: (
              <RequirePermission menu="devices">
                <Suspense fallback={<PageFallback />}>
                  <ClaimPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/pricing/settings',
            element: (
              <RequirePermission menu="pricing_contracts">
                <Suspense fallback={<PageFallback />}>
                  <PricingSettingsPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/pricing/contracts/:id',
            element: (
              <RequirePermission menu="pricing_contracts">
                <Suspense fallback={<PageFallback />}>
                  <ContractDetailPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/pricing/trip-charges/:tripId',
            element: (
              <RequirePermission menu="pricing_trip_charges">
                <Suspense fallback={<PageFallback />}>
                  <TripChargeDetailPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          {
            path: '/pricing/invoices/:id',
            element: (
              <RequirePermission menu="pricing_invoices">
                <Suspense fallback={<PageFallback />}>
                  <InvoiceDetailPage />
                </Suspense>
              </RequirePermission>
            ),
          },
          { path: '/403', element: <ForbiddenPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
