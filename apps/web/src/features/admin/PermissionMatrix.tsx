import { ACTIONS, MENUS, type Action, type MenuKey, type PermissionMap } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { GROUP_LABELS } from '@/features/shell/nav';
import { humanize } from '@/lib/format';

/** Company roles never include the Super Admin-only platform menus. */
const ROLE_MENUS = MENUS.filter((m) => !m.superAdminOnly);

function checkState(selected: number, total: number): boolean | 'indeterminate' {
  return selected === 0 ? false : selected === total ? true : 'indeterminate';
}

/**
 * Rows = menus, columns = actions; a checkbox only where the menu supports the action.
 * Granting any action implies `view`; removing `view` clears the row.
 */
export function PermissionMatrix({ value, onChange, disabled }: { value: PermissionMap; onChange: (v: PermissionMap) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const has = (menu: MenuKey, action: Action) => value[menu]?.includes(action) ?? false;

  const setRow = (menu: MenuKey, actions: Action[]) => {
    const next = { ...value };
    if (actions.length) next[menu] = actions;
    else delete next[menu];
    onChange(next);
  };

  const toggle = (menu: MenuKey, action: Action, on: boolean) => {
    const current = value[menu] ?? [];
    if (!on) return setRow(menu, action === 'view' ? [] : current.filter((a) => a !== action));
    const next = new Set<Action>([...current, action, 'view']);
    setRow(menu, ACTIONS.filter((a) => next.has(a)));
  };

  const toggleColumn = (action: Action, on: boolean) => {
    const next = { ...value };
    for (const m of ROLE_MENUS) {
      if (!m.actions.includes(action)) continue;
      const set = new Set<Action>(next[m.key] ?? []);
      if (on) {
        set.add(action);
        set.add('view');
      } else if (action === 'view') set.clear();
      else set.delete(action);
      const actions = ACTIONS.filter((a) => set.has(a));
      if (actions.length) next[m.key] = actions;
      else delete next[m.key];
    }
    onChange(next);
  };

  let lastGroup = '';
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">{t('Menu')}</th>
            {ACTIONS.map((a) => {
              const eligible = ROLE_MENUS.filter((m) => m.actions.includes(a));
              const selected = eligible.filter((m) => has(m.key, a)).length;
              return (
                <th key={a} className="px-2 py-2 text-center text-xs font-medium text-muted-foreground">
                  <label className="flex flex-col items-center gap-1.5 uppercase">
                    {t(humanize(a))}
                    <Checkbox disabled={disabled} checked={checkState(selected, eligible.length)} onCheckedChange={(v) => toggleColumn(a, v === true)} aria-label={t('Toggle {{action}} for all menus', { action: t(humanize(a)) })} />
                  </label>
                </th>
              );
            })}
            <th className="px-2 py-2 text-center text-xs font-medium text-muted-foreground uppercase">{t('All')}</th>
          </tr>
        </thead>
        <tbody>
          {ROLE_MENUS.map((m) => {
            const groupRow = m.group !== lastGroup;
            lastGroup = m.group;
            const selected = value[m.key]?.length ?? 0;
            return [
              groupRow && (
                <tr key={`g-${m.group}`} className="bg-muted/30">
                  <td colSpan={ACTIONS.length + 2} className="px-3 py-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    {t(GROUP_LABELS[m.group])}
                  </td>
                </tr>
              ),
              <tr key={m.key} className="border-t hover:bg-muted/30">
                <td className="px-3 py-2 font-medium whitespace-nowrap">{t(m.label)}</td>
                {ACTIONS.map((a) => (
                  <td key={a} className="px-2 py-2 text-center">
                    {m.actions.includes(a) ? (
                      <Checkbox disabled={disabled} checked={has(m.key, a)} onCheckedChange={(v) => toggle(m.key, a, v === true)} aria-label={`${t(m.label)}: ${t(humanize(a))}`} className="mx-auto" />
                    ) : (
                      <span className="text-muted-foreground/40" aria-hidden>
                        ·
                      </span>
                    )}
                  </td>
                ))}
                <td className="px-2 py-2 text-center">
                  <Checkbox
                    disabled={disabled}
                    checked={checkState(selected, m.actions.length)}
                    onCheckedChange={(v) => setRow(m.key, v === true ? [...m.actions] : [])}
                    aria-label={`${t(m.label)}: ${t('all actions')}`}
                    className="mx-auto"
                  />
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
