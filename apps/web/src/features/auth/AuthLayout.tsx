import { MapPinnedIcon, ShieldCheckIcon, ZapIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Logo, LogoMark } from '@/components/logo';

const HIGHLIGHTS = [
  { icon: MapPinnedIcon, text: 'Live fleet map with second-by-second updates' },
  { icon: ZapIcon, text: 'Built for 10,000+ vehicles per account' },
  { icon: ShieldCheckIcon, text: 'Role-based access down to branch and vehicle' },
];

export function AuthLayout({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-sidebar-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-20 size-96 rounded-full bg-primary/20 blur-3xl" />
        <span className="relative inline-flex items-center gap-2.5">
          <LogoMark />
          <span className="text-lg font-semibold tracking-tight text-sidebar-accent-foreground">
            Vee<span className="text-sidebar-primary">Tracer</span>
          </span>
        </span>
        <div className="relative max-w-md space-y-6">
          <h2 className="text-3xl leading-tight font-semibold text-sidebar-accent-foreground">Every vehicle, every second, one screen.</h2>
          <ul className="space-y-3">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm">
                <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-primary">
                  <Icon className="size-4" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-sidebar-muted">© {new Date().getFullYear()} VeeTracer</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm space-y-7">
          <Logo className="lg:hidden" />
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
