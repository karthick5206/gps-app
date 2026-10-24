import { BookOpenIcon, LaptopIcon, LogOutIcon, ShieldCheckIcon, ShieldIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth, useMe } from '@/features/auth/auth-context';
import { SessionsDialog } from './SessionsDialog';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export function UserMenu() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const me = useMe();
  const { signOut } = useAuth();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('Account menu')}
          className="flex size-9 items-center justify-center rounded-full bg-navy text-xs font-semibold text-navy-foreground ring-offset-2 ring-offset-background transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {initials(me.user.name) || '?'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="space-y-0.5 py-2 font-normal">
          <p className="truncate text-sm font-medium text-foreground">{me.user.name}</p>
          <p className="truncate text-xs">{me.user.email ?? me.user.mobile}</p>
          <p className="truncate text-xs">{me.company.name}</p>
        </DropdownMenuLabel>
        {me.user.isSuperAdmin && (
          <DropdownMenuLabel className="flex items-center gap-1.5 pt-0 text-primary">
            <ShieldIcon className="size-3.5" /> {t('Super Admin')}
          </DropdownMenuLabel>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/guide')}>
          <BookOpenIcon /> {t('Getting-started guide')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setSessionsOpen(true)}>
          <LaptopIcon /> {t('Signed-in devices')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/privacy')}>
          <ShieldCheckIcon /> {t('Privacy policy')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/delete-account')}>
          <Trash2Icon /> {t('Delete account')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={signOut}>
          <LogOutIcon /> {t('Sign out')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <SessionsDialog open={sessionsOpen} onOpenChange={setSessionsOpen} />
    </>
  );
}
