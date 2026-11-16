import { can, isModuleMenu, MENUS, menuAvailable, type Action, type CompanyFeature, type MenuKey, type PermissionMap } from '@veetracer/shared';

/**
 * What a protected page shows (QA BUG-4). A module menu (MenuDef.requires, e.g. ETMS) whose add-on is off in the acting
 * company is "not found", like the API's plain 404, so a company without the module can't tell the page exists. Otherwise
 * a missing grant is "forbidden". A menu behind a company switch (requires.companySetting, e.g. photo notes) is not a
 * hidden module: while the switch is off its grant is stripped from the permissions, so the page is "forbidden".
 */
export function routeAccess(menu: MenuKey, action: Action, permissions: PermissionMap, features: readonly CompanyFeature[]): 'allow' | 'forbidden' | 'notFound' {
  const def = MENUS.find((m) => m.key === menu);
  if (def && isModuleMenu(def) && !menuAvailable(def, features)) return 'notFound';
  return can(permissions, menu, action) ? 'allow' : 'forbidden';
}
