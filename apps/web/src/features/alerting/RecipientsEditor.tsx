import { useQuery } from '@tanstack/react-query';
import type {
  AlertLevel,
  AlertSeverity,
  AlertTypeCode,
  NotifyChannel,
  Paginated,
  RecipientEntry,
  RecipientKind,
  RecipientListDto,
  RecipientMode,
  RoleDto,
  UserDto,
} from '@veetracer/shared';
import { MailIcon, MessageSquareIcon, PlusIcon, SmartphoneIcon, BellIcon, UserIcon, UsersIcon, SparklesIcon, XIcon, RotateCcwIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { CHANNEL_LABEL, SENDABLE_CHANNELS, useDeleteRecipientList, usePutRecipientList } from './api';
import { levelLabel } from './inheritance';
import { dedupeEntries, entryKey, MODE_LABEL, modeUsesEntries, parseContacts } from './recipients';

const CHANNEL_ICON: Record<NotifyChannel, typeof MailIcon> = { EMAIL: MailIcon, SMS: SmartphoneIcon, WHATSAPP: MessageSquareIcon, PUSH: BellIcon, INAPP: BellIcon };
const MODES: RecipientMode[] = ['DEFAULT', 'ADD', 'ONLY', 'NONE'];
const DYNAMIC: { value: string; label: string; hint: string }[] = [
  { value: 'OBJECT_USERS', label: 'Assigned users', hint: 'Users mapped to the vehicle or its branch' },
  { value: 'BRANCH_MANAGERS', label: 'Branch managers', hint: "Managers of the vehicle's branch" },
];

/** Entry kinds that make sense per channel (contacts without a login only on email/SMS/WhatsApp). */
const KINDS: Record<NotifyChannel, RecipientKind[]> = {
  EMAIL: ['USER', 'ROLE', 'DYNAMIC', 'EMAIL'],
  SMS: ['USER', 'ROLE', 'DYNAMIC', 'MOBILE'],
  WHATSAPP: ['USER', 'ROLE', 'DYNAMIC', 'MOBILE'],
  PUSH: ['USER', 'ROLE', 'DYNAMIC'],
  INAPP: ['USER', 'ROLE', 'DYNAMIC'],
};

const KIND_ICON: Record<RecipientKind, typeof UserIcon> = { USER: UserIcon, ROLE: UsersIcon, DYNAMIC: SparklesIcon, EMAIL: MailIcon, MOBILE: SmartphoneIcon };

function useDirectory() {
  const { can } = useAuth();
  const users = useQuery({
    queryKey: ['options', '/users', 'recipients'],
    queryFn: ({ signal }) => api.get<Paginated<UserDto>>('/users', { pageSize: 100, status: 'ACTIVE' }, signal),
    enabled: can('users'),
    staleTime: 5 * 60_000,
  });
  const roles = useQuery({
    queryKey: ['options', '/roles', 'recipients'],
    queryFn: ({ signal }) => api.get<Paginated<RoleDto>>('/roles', { pageSize: 100 }, signal),
    enabled: can('roles'),
    staleTime: 5 * 60_000,
  });
  return {
    users: users.data?.items ?? [],
    roles: roles.data?.items ?? [],
    canUsers: can('users'),
    canRoles: can('roles'),
  };
}

function entryLabel(e: RecipientEntry, dir: ReturnType<typeof useDirectory>): string {
  if (e.label) return e.label;
  if (e.kind === 'USER') return dir.users.find((u) => u.id === e.value)?.name ?? 'User';
  if (e.kind === 'ROLE') return `Role: ${dir.roles.find((r) => r.id === e.value)?.name ?? 'role'}`;
  if (e.kind === 'DYNAMIC') return DYNAMIC.find((d) => d.value === e.value)?.label ?? e.value;
  return e.value;
}

function PickList({ items, onPick, empty }: { items: { value: string; label: string; hint?: string }[]; onPick: (v: { value: string; label: string }) => void; empty: string }) {
  const [q, setQ] = useState('');
  const shown = items.filter((i) => !q || i.label.toLowerCase().includes(q.toLowerCase()) || i.hint?.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-1.5">
      {items.length > 6 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="h-8" aria-label="Search" />}
      <ul className="max-h-52 overflow-y-auto">
        {shown.map((i) => (
          <li key={i.value}>
            <button type="button" onClick={() => onPick(i)} className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
              <span className="truncate">{i.label}</span>
              {i.hint && <span className="truncate text-xs text-muted-foreground">{i.hint}</span>}
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-2 py-4 text-center text-xs text-muted-foreground">{empty}</li>}
      </ul>
    </div>
  );
}

function ContactInput({ kind, onAdd }: { kind: 'EMAIL' | 'MOBILE'; onAdd: (entries: RecipientEntry[]) => void }) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const add = () => {
    const r = parseContacts(text, kind);
    setInvalid(r.invalid);
    if (r.entries.length) onAdd(r.entries);
    setText(r.invalid.join(', '));
  };
  return (
    <div className="space-y-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        placeholder={kind === 'EMAIL' ? 'ops@company.in, security@company.in' : '98765 43210, +91 91234 56789'}
        aria-label={kind === 'EMAIL' ? 'Email addresses' : 'Mobile numbers'}
        className="h-8"
      />
      {invalid.length > 0 && <p className="text-xs text-destructive">Not valid: {invalid.join(', ')}</p>}
      <p className="text-xs text-muted-foreground">{kind === 'EMAIL' ? 'Separate several with commas.' : 'Indian mobiles; saved as +91XXXXXXXXXX.'}</p>
      <Button size="sm" onClick={add} disabled={!text.trim()}>
        Add
      </Button>
    </div>
  );
}

function EntryPicker({ channel, onAdd, disabled }: { channel: NotifyChannel; onAdd: (entries: RecipientEntry[]) => void; disabled?: boolean }) {
  const dir = useDirectory();
  const [open, setOpen] = useState(false);
  const kinds = KINDS[channel].filter((k) => (k === 'USER' ? dir.canUsers : k === 'ROLE' ? dir.canRoles : true));
  const pick = (entries: RecipientEntry[]) => {
    onAdd(entries);
    setOpen(false);
  };
  const tabLabel: Record<RecipientKind, string> = { USER: 'Users', ROLE: 'Roles', DYNAMIC: 'Dynamic', EMAIL: 'Email', MOBILE: 'Mobile' };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={disabled}>
          <PlusIcon className="size-3.5" /> Add
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <Tabs defaultValue={kinds[0]}>
          <TabsList className="w-full">
            {kinds.map((k) => (
              <TabsTrigger key={k} value={k} className="px-1.5 text-xs">
                {tabLabel[k]}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="pt-2">
            <TabsContent value="USER">
              <PickList
                empty="No users"
                items={dir.users.map((u) => ({ value: u.id, label: u.name, hint: [u.email, u.mobile].filter(Boolean).join(' · ') }))}
                onPick={(i) => pick([{ kind: 'USER', value: i.value, label: i.label }])}
              />
            </TabsContent>
            <TabsContent value="ROLE">
              <PickList empty="No roles" items={dir.roles.map((r) => ({ value: r.id, label: r.name, hint: `${r.userCount} user(s)` }))} onPick={(i) => pick([{ kind: 'ROLE', value: i.value, label: `Role: ${i.label}` }])} />
            </TabsContent>
            <TabsContent value="DYNAMIC">
              <PickList empty="—" items={DYNAMIC} onPick={(i) => pick([{ kind: 'DYNAMIC', value: i.value, label: i.label }])} />
            </TabsContent>
            <TabsContent value="EMAIL">
              <ContactInput kind="EMAIL" onAdd={pick} />
            </TabsContent>
            <TabsContent value="MOBILE">
              <ContactInput kind="MOBILE" onAdd={pick} />
            </TabsContent>
          </div>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

function ChannelRow({
  channel,
  list,
  isDefaultList,
  onSave,
  onReset,
  pending,
  readOnly,
}: {
  channel: NotifyChannel;
  list: RecipientListDto | undefined;
  isDefaultList: boolean;
  onSave: (mode: RecipientMode, entries: RecipientEntry[]) => void;
  onReset: () => void;
  pending: boolean;
  readOnly: boolean;
}) {
  const dir = useDirectory();
  const Icon = CHANNEL_ICON[channel];
  const mode: RecipientMode = list?.mode ?? (isDefaultList ? 'ONLY' : 'DEFAULT');
  const entries = list?.entries ?? [];
  const showEntries = isDefaultList ? mode !== 'NONE' && mode !== 'DEFAULT' : modeUsesEntries(mode);
  const modes = isDefaultList ? (['ADD', 'ONLY', 'NONE'] as RecipientMode[]) : MODES;
  const modeLabel = (m: RecipientMode) => (isDefaultList ? { DEFAULT: 'Inherit', ADD: 'Inherited + these', ONLY: 'Only these', NONE: 'Nobody' }[m] : MODE_LABEL[m]);

  return (
    <div className="grid gap-2 rounded-lg border p-2.5 sm:grid-cols-[7.5rem_11rem_1fr] sm:items-start">
      <div className="flex items-center gap-2 pt-1 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" />
        {CHANNEL_LABEL[channel]}
      </div>
      <Select value={mode} onValueChange={(m) => onSave(m as RecipientMode, entries)} disabled={readOnly || pending}>
        <SelectTrigger className="h-8 text-xs" aria-label={`${CHANNEL_LABEL[channel]} recipients mode`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {modes.map((m) => (
            <SelectItem key={m} value={m}>
              {modeLabel(m)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {!list && <span className="text-xs text-muted-foreground">{isDefaultList ? 'Inherited from the level above' : 'Uses the default list'}</span>}
        {list && !showEntries && <span className="text-xs text-muted-foreground">{mode === 'NONE' ? 'Nobody is notified on this channel' : 'Uses the default list'}</span>}
        {showEntries &&
          entries.map((e) => {
            const KIcon = KIND_ICON[e.kind];
            return (
              <span key={entryKey(e)} className="inline-flex max-w-full items-center gap-1 rounded-md bg-secondary py-0.5 pr-1 pl-1.5 text-xs text-secondary-foreground">
                <KIcon className="size-3 shrink-0 opacity-70" />
                <span className="truncate">{entryLabel(e, dir)}</span>
                {!readOnly && (
                  <button type="button" aria-label={`Remove ${entryLabel(e, dir)}`} className="rounded p-0.5 hover:bg-background/60" onClick={() => onSave(mode, entries.filter((x) => entryKey(x) !== entryKey(e)))} disabled={pending}>
                    <XIcon className="size-3" />
                  </button>
                )}
              </span>
            );
          })}
        {showEntries && !entries.length && <span className="text-xs text-warning">No recipients yet</span>}
        {showEntries && !readOnly && <EntryPicker channel={channel} disabled={pending} onAdd={(add) => onSave(mode, dedupeEntries([...entries, ...add]))} />}
        {list && !readOnly && (
          <Tooltip content={`Remove this list (${levelLabel(list.level)} level) and inherit`}>
            <Button variant="ghost" size="icon-sm" className="ml-auto size-7" aria-label="Reset recipients to inherited" onClick={onReset} disabled={pending}>
              <RotateCcwIcon className="size-3.5" />
            </Button>
          </Tooltip>
        )}
        {pending && <Spinner className="text-muted-foreground" />}
      </div>
    </div>
  );
}

/**
 * Recipient lists for one level target and alert type (or '*' = default lists), one row per sendable channel:
 * mode (Use default / Default + additional / Only this list / None) and an entries editor.
 */
export function RecipientsEditor({
  level,
  targetId,
  alertType,
  lists,
  readOnly,
}: {
  level: AlertLevel;
  targetId: string;
  alertType: AlertTypeCode | '*';
  lists: RecipientListDto[];
  readOnly: boolean;
}) {
  const [severity, setSeverity] = useState<AlertSeverity | '*'>('*');
  const put = usePutRecipientList(level, targetId);
  const del = useDeleteRecipientList();
  const [busy, setBusy] = useState<NotifyChannel | null>(null);
  const isDefaultList = alertType === '*';
  const mine = useMemo(() => lists.filter((l) => l.alertType === alertType && l.severity === severity), [lists, alertType, severity]);
  const otherSeverities = useMemo(() => new Set(lists.filter((l) => l.alertType === alertType && l.severity !== '*').map((l) => l.severity)), [lists, alertType]);

  return (
    <div className="space-y-2">
      {!isDefaultList && (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Applies to</span>
        <Select value={severity} onValueChange={(v) => setSeverity(v as AlertSeverity | '*')}>
          <SelectTrigger className="h-7 w-auto min-w-[9rem] text-xs" aria-label="Severity for these lists">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="*">All severities</SelectItem>
            {(['INFO', 'WARNING', 'CRITICAL'] as AlertSeverity[]).map((s) => (
              <SelectItem key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()} only{otherSeverities.has(s) ? ' •' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {otherSeverities.size > 0 && severity === '*' && <Badge variant="muted">Has severity-specific lists</Badge>}
      </div>
      )}
      {SENDABLE_CHANNELS.map((channel) => {
        const list = mine.find((l) => l.channel === channel);
        return (
          <ChannelRow
            key={channel}
            channel={channel}
            list={list}
            isDefaultList={isDefaultList}
            readOnly={readOnly}
            pending={busy === channel && (put.isPending || del.isPending)}
            onSave={(mode, entries) => {
              setBusy(channel);
              put.mutate({ alertType, severity, channel, mode, entries: modeUsesEntries(mode) || isDefaultList ? entries : [] });
            }}
            onReset={() => {
              if (!list) return;
              setBusy(channel);
              del.mutate(list.id);
            }}
          />
        );
      })}
    </div>
  );
}

