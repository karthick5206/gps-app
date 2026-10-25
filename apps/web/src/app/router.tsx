import { MENUS, type MenuKey } from '@veetracer/shared';
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { SignupPage } from '@/features/auth/SignupPage';
import { ClaimPage } from '@/features/claim/ClaimPage';
import { GuidePage } from '@/features/guide/GuidePage';
import { DownloadPage } from '@/features/download/DownloadPage';
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
  geofences: page(() => import('@/features/geofences/GeofencesPage'), 'GeofencesPage'),
  pois: page(() => import('@/features/pois/PoisPage'), 'PoisPage'),
  alert_settings: page(() => import('@/features/alerting/AlertSettingsPage'), 'AlertSettingsPage'),
  message_templates: page(() => import('@/features/templates/TemplatesPage'), 'TemplatesPage'),
};

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
  { path: '/download', element: <DownloadPage /> },
  { path: '/privacy', element: <PrivacyPage /> },
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
            path: '/claim',
            element: (
              <RequirePermission menu="devices">
                <Suspense fallback={<PageFallback />}>
                  <ClaimPage />
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
