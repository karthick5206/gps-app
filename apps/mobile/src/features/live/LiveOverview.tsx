import { MOVEMENT_STATUSES, STATUS_META, type LiveObject, type MovementStatus } from '@veetracer/shared';
import { ChevronDownIcon, ChevronUpIcon, GaugeIcon, PauseIcon, WifiOffIcon, type LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui';
import { RADIUS, SPACE, statusColor, useColors, useScheme } from '@/lib/theme';

/** Idle longer than this, or signal lost within this window, needs a look (same rules as the web live map). */
const IDLE_ATTENTION_MS = 15 * 60_000;
const OFFLINE_ATTENTION_MS = 24 * 60 * 60_000;

export interface AttentionItem {
  kind: 'OVERSPEED' | 'IDLE' | 'OFFLINE';
  object: LiveObject;
  forMs: number;
}

/** Overspeeding (fastest first), idle over 15 min (longest first), signal lost in the last day (most recent first). */
export function attentionItems(objects: LiveObject[], now: number): AttentionItem[] {
  const rank = { OVERSPEED: 0, IDLE: 1, OFFLINE: 2 };
  const out: AttentionItem[] = [];
  for (const o of objects) {
    if (o.inMaintenance) continue;
    const since = o.statusSince ? Date.parse(o.statusSince) : NaN;
    const forMs = Number.isNaN(since) ? 0 : Math.max(0, now - since);
    if (o.status === 'OVERSPEED') out.push({ kind: 'OVERSPEED', object: o, forMs });
    else if (o.status === 'IDLE' && o.type !== 'PERSON' && forMs >= IDLE_ATTENTION_MS) out.push({ kind: 'IDLE', object: o, forMs });
    else if (o.status === 'OFFLINE' && forMs > 0 && forMs <= OFFLINE_ATTENTION_MS) out.push({ kind: 'OFFLINE', object: o, forMs });
  }
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === 'OVERSPEED' ? b.object.speedKph - a.object.speedKph : a.kind === 'IDLE' ? b.forMs - a.forMs : a.forMs - b.forMs));
}

const share = (n: number, total: number) => (!total || !n ? '0' : Math.round((n / total) * 100) < 1 ? '<1' : String(Math.round((n / total) * 100)));

/** Status cards: count, a bar of the share of the fleet and the percentage; tap to filter (tap again for all). */
export function StatusCards({ counts, total, status, onStatus }: { counts: Record<MovementStatus, number>; total: number; status: MovementStatus | 'ALL'; onStatus: (s: MovementStatus | 'ALL') => void }) {
  const c = useColors();
  const scheme = useScheme();
  const { t } = useTranslation();
  return (
    <View style={{ gap: SPACE.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: status === 'ALL' }}
        onPress={() => onStatus('ALL')}
        style={[styles.all, status === 'ALL' ? { backgroundColor: c.primary, borderColor: c.primary } : { backgroundColor: c.card, borderColor: c.border }]}
      >
        <Text size="sm" weight="700" style={{ color: status === 'ALL' ? c.primaryForeground : c.foreground }}>
          {t('All')}
        </Text>
        <Text size="sm" weight="700" style={{ color: status === 'ALL' ? c.primaryForeground : c.foreground }}>
          {total}
        </Text>
      </Pressable>
      <View style={styles.grid}>
        {MOVEMENT_STATUSES.map((s) => {
          const on = status === s;
          const color = statusColor(s, scheme);
          const pct = share(counts[s], total);
          return (
            <Pressable
              key={s}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t('{{status}}: {{count}}, {{pct}}% of fleet', { status: t(STATUS_META[s].label), count: counts[s], pct })}
              onPress={() => onStatus(on ? 'ALL' : s)}
              style={({ pressed }) => [styles.card, { borderColor: on ? color : c.border, backgroundColor: on ? `${color}1f` : c.card, opacity: pressed ? 0.85 : 1 }]}
            >
              <View style={styles.head}>
                <View style={[styles.dot, { backgroundColor: color }]} />
                <Text size="xs" tone="muted" weight="600" numberOfLines={1} style={{ flex: 1 }}>
                  {t(STATUS_META[s].label)}
                </Text>
              </View>
              <Text size="lg" weight="700">
                {counts[s]}
              </Text>
              <View style={[styles.track, { backgroundColor: c.muted }]}>
                <View style={{ width: `${counts[s] ? Math.max((counts[s] / (total || 1)) * 100, 3) : 0}%`, height: '100%', borderRadius: 2, backgroundColor: color }} />
              </View>
              <Text size="xs" tone="muted">
                {t('{{pct}}% of fleet', { pct })}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const ICON: Record<AttentionItem['kind'], LucideIcon> = { OVERSPEED: GaugeIcon, IDLE: PauseIcon, OFFLINE: WifiOffIcon };
const dur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

/** "Needs attention": the most urgent vehicles first; tap one to open it. Collapsible. */
export function NeedsAttention({ items, onPick }: { items: AttentionItem[]; onPick: (id: string) => void }) {
  const c = useColors();
  const scheme = useScheme();
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  return (
    <View style={[styles.box, { borderColor: c.border, backgroundColor: c.card }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)} style={styles.boxHead}>
        <Text weight="700" style={{ flex: 1 }}>
          {t('Needs attention')}
        </Text>
        <View style={[styles.badge, { backgroundColor: c.destructiveSoft }]}>
          <Text size="xs" weight="700" style={{ color: c.destructiveText }}>
            {items.length}
          </Text>
        </View>
        {open ? <ChevronUpIcon size={18} color={c.mutedForeground} /> : <ChevronDownIcon size={18} color={c.mutedForeground} />}
      </Pressable>
      {open &&
        items.slice(0, 5).map((i) => {
          const Icon = ICON[i.kind];
          const color = statusColor(i.kind, scheme);
          const reason = i.kind === 'OVERSPEED' ? t('Overspeeding at {{speed}} km/h', { speed: Math.round(i.object.speedKph) }) : i.kind === 'IDLE' ? t('Idling for {{time}}', { time: dur(i.forMs) }) : t('No signal for {{time}}', { time: dur(i.forMs) });
          return (
            <Pressable key={i.object.objectId} accessibilityRole="button" onPress={() => onPick(i.object.objectId)} style={({ pressed }) => [styles.item, { borderTopColor: c.border }, pressed && { backgroundColor: c.muted }]}>
              <View style={[styles.itemIcon, { backgroundColor: `${color}22` }]}>
                <Icon size={16} color={color} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" weight="700" numberOfLines={1}>
                  {i.object.name}
                </Text>
                <Text size="xs" tone="muted" numberOfLines={1}>
                  {reason}
                </Text>
              </View>
            </Pressable>
          );
        })}
      {open && items.length > 5 && (
        <Text size="xs" tone="muted" style={{ paddingHorizontal: SPACE.md, paddingBottom: SPACE.sm }}>
          {t('+{{n}} more', { n: items.length - 5 })}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  all: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.md, height: 36 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  card: { flexBasis: '31%', flexGrow: 1, borderWidth: 1, borderRadius: RADIUS.sm, padding: SPACE.sm, gap: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 2 },
  box: { borderWidth: 1, borderRadius: RADIUS.md, overflow: 'hidden' },
  boxHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, minHeight: 44 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  item: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  itemIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
