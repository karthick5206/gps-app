import { PrismaClient } from '@prisma/client';
import { AlertSeverity, NotifyChannel, RecipientEntry, RecipientMode } from '@veetracer/shared';
import { RecipientChain, RecipientListRow, resolveRecipientEntries, ResolvedEntries } from '../logic/recipients';
import { sortGroups } from '../logic/settings-resolution';

export interface Recipient {
  /** Address for the channel: e-mail, +91 mobile, or `user:<id>` for push. */
  address: string;
  kind: RecipientEntry['kind'];
  label: string;
  userId: string | null;
}

export interface ChannelRecipients {
  channel: NotifyChannel;
  mode: RecipientMode;
  decidedBy: ResolvedEntries['decidedBy'];
  entries: RecipientEntry[];
  recipients: Recipient[];
}

export interface ObjectRef {
  id: string;
  companyId: string;
  branchId: string | null;
}

interface CandidateUser {
  id: string;
  name: string;
  email: string | null;
  mobile: string | null;
  isActive: boolean;
  companyId: string;
  roles: { role: { id: string; name: string; dataScope: string } }[];
  branches: { branchId: string }[];
  objects: { objectId: string }[];
}

const userSelect = {
  id: true,
  name: true,
  email: true,
  mobile: true,
  isActive: true,
  companyId: true,
  roles: { select: { role: { select: { id: true, name: true, dataScope: true } } } },
  branches: { select: { branchId: true } },
  objects: { select: { objectId: true } },
} as const;

/** Active user of the company whose data scope includes the object (COMPANY role, the object's branch, or mapped). */
export function userCanSee(u: CandidateUser, object: ObjectRef): boolean {
  if (!u.isActive || u.companyId !== object.companyId) return false;
  if (u.roles.some((r) => r.role.dataScope === 'COMPANY')) return true;
  if (object.branchId && u.branches.some((b) => b.branchId === object.branchId)) return true;
  return u.objects.some((o) => o.objectId === object.id);
}

function addressFor(channel: NotifyChannel, u: { id: string; email: string | null; mobile: string | null }): string | null {
  if (channel === 'EMAIL') return u.email;
  if (channel === 'SMS' || channel === 'WHATSAPP') return u.mobile;
  if (channel === 'PUSH') return `user:${u.id}`;
  return null;
}

/**
 * Turns recipient lists into concrete addresses for one object: resolves list modes, expands users/roles/dynamic
 * entries and drops users whose data scope doesn't include the object. Used by the API (preview/test) and the notifier.
 */
export class RecipientExpander {
  constructor(private readonly prisma: PrismaClient) {}

  async chainFor(object: ObjectRef): Promise<RecipientChain> {
    const groups = await this.prisma.vehicleGroupMember.findMany({
      where: { objectId: object.id, group: { isActive: true, companyId: object.companyId } },
      select: { group: { select: { id: true, name: true, alertPriority: true } } },
    });
    const sorted = sortGroups(groups.map((g) => ({ groupId: g.group.id, name: g.group.name, priority: g.group.alertPriority })));
    return {
      companyId: object.companyId,
      branchId: object.branchId,
      groupIdsByPriorityAsc: sorted.reverse().map((g) => g.groupId),
      objectId: object.id,
    };
  }

  async loadLists(companyId: string): Promise<RecipientListRow[]> {
    const rows = await this.prisma.recipientList.findMany({ where: { companyId } });
    return rows.map((r) => ({
      level: r.level,
      targetId: r.targetId,
      alertType: r.alertType,
      severity: r.severity,
      channel: r.channel,
      mode: r.mode,
      entries: Array.isArray(r.entries) ? (r.entries as unknown as RecipientEntry[]) : [],
    }));
  }

  async resolve(
    object: ObjectRef,
    alertType: string,
    severity: AlertSeverity,
    channels: NotifyChannel[],
    lists?: RecipientListRow[],
    chain?: RecipientChain,
  ): Promise<ChannelRecipients[]> {
    const rows = lists ?? (await this.loadLists(object.companyId));
    const c = chain ?? (await this.chainFor(object));
    const out: ChannelRecipients[] = [];
    for (const channel of channels) {
      const resolved = resolveRecipientEntries(rows, c, alertType, severity, channel);
      out.push({ channel, ...resolved, recipients: await this.expand(object, resolved.entries, channel) });
    }
    return out;
  }

  async expand(object: ObjectRef, entries: RecipientEntry[], channel: NotifyChannel): Promise<Recipient[]> {
    if (channel === 'INAPP') return [];
    const userIds = entries.filter((e) => e.kind === 'USER').map((e) => e.value);
    const roleIds = entries.filter((e) => e.kind === 'ROLE').map((e) => e.value);
    const dynamic = new Set(entries.filter((e) => e.kind === 'DYNAMIC').map((e) => e.value));
    const or: object[] = [];
    if (userIds.length) or.push({ id: { in: userIds } });
    if (roleIds.length) or.push({ roles: { some: { roleId: { in: roleIds } } } });
    if (dynamic.has('OBJECT_USERS')) {
      or.push({ objects: { some: { objectId: object.id } } });
      if (object.branchId) or.push({ branches: { some: { branchId: object.branchId } } });
    }
    // Every company user; userCanSee below keeps only those who can see the object.
    if (dynamic.has('ALL_VIEWERS')) or.push({ companyId: object.companyId });
    if (dynamic.has('BRANCH_MANAGERS') && object.branchId) {
      or.push({ AND: [{ branches: { some: { branchId: object.branchId } } }, { roles: { some: { role: { name: 'Manager' } } } }] });
    }
    const users: CandidateUser[] = or.length
      ? await this.prisma.user.findMany({ where: { companyId: object.companyId, OR: or }, select: userSelect })
      : [];

    const out: Recipient[] = [];
    const seen = new Set<string>();
    const push = (r: Recipient) => {
      const k = r.address.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(r);
    };
    for (const u of users) {
      if (!userCanSee(u, object)) continue;
      const address = addressFor(channel, u);
      if (!address) continue;
      const kind = userIds.includes(u.id) ? 'USER' : u.roles.some((r) => roleIds.includes(r.role.id)) ? 'ROLE' : 'DYNAMIC';
      push({ address, kind, label: u.name, userId: u.id });
    }
    for (const e of entries) {
      if (e.kind === 'EMAIL' && channel === 'EMAIL') push({ address: e.value.trim().toLowerCase(), kind: 'EMAIL', label: e.label ?? e.value, userId: null });
      if (e.kind === 'MOBILE' && (channel === 'SMS' || channel === 'WHATSAPP')) push({ address: e.value.trim(), kind: 'MOBILE', label: e.label ?? e.value, userId: null });
    }
    return out;
  }
}
