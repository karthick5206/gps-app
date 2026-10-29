import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  MOVEMENT_STATUSES,
  OBJECT_TYPES,
  STATUS_META,
  VEHICLE_TYPES,
  displayStatus,
  displayStatusLabel,
  personActivity,
  type BasemapType,
  type BranchDto,
  type LiveObject,
  type MovementStatus,
  type Paginated,
  type PoiDto,
  type VehicleGroupDto,
} from '@veetracer/shared';
import { router } from 'expo-router';
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, LayersIcon, LocateFixedIcon, MapPinIcon, MapPinPlusIcon, MaximizeIcon, SearchIcon, XIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { PickerSheet, type PickOption } from '@/components/PickerSheet';
import { Button, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { AddressLine } from '@/features/geocoding/use-address';
import { VehicleSummary } from '@/features/live/components';
import { useDayStats, VehicleDayDetails, type DayStatsMap } from '@/features/live/day-stats';
import { liveStore } from '@/features/live/live-store';
import { LiveSheet, type SheetSnap } from '@/features/live/LiveSheet';
import { useLiveVersion, useNow, useRealtimeStatus } from '@/features/live/use-live';
import { basemap, useBasemap } from '@/features/map/basemap';
import { FleetMap, type FleetMapHandle, type MapView } from '@/features/map/FleetMap';
import { usePoiCategories } from '@/features/pois/categories';
import { PoiLayer } from '@/features/pois/PoiLayer';
import { api } from '@/lib/api';
import { humanize, relativeTime, timeInStatus } from '@/lib/format';
import { RADIUS, SPACE, statusColor, useColors, useScheme } from '@/lib/theme';

type StatusFilter = MovementStatus | 'ALL';
type Picker = 'branch' | 'group' | 'type' | null;

const TYPE_OPTIONS: PickOption[] = [
  ...VEHICLE_TYPES.map((t) => ({ value: `vt:${t}`, label: humanize(t) })),
  ...OBJECT_TYPES.filter((t) => t !== 'VEHICLE').map((t) => ({ value: `ot:${t}`, label: humanize(t) })),
];

function matchesSearch(o: LiveObject, q: string) {
  if (!q) return true;
  return `${o.name}\u0000${o.plateNumber ?? ''}\u0000${o.uniqueId ?? ''}\u0000${o.driverName ?? ''}`.toLowerCase().includes(q);
}

/** One list row: status dot, name, plate · speed, coloured status with its duration, last update. */
function VehicleRow({ o, now, onPress, stats }: { o: LiveObject; now: number; onPress: () => void; stats: DayStatsMap | undefined }) {
  const c = useColors();
  const scheme = useScheme();
  const color = statusColor(displayStatus(o), scheme);
  const { t } = useTranslation();
  const meta = STATUS_META[o.status];
  const activity = personActivity(o);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { borderBottomColor: c.border }, pressed && { backgroundColor: c.muted }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text weight="700" numberOfLines={1}>
          {o.name}
        </Text>
        <Text size="sm" tone="muted" numberOfLines={1}>
          {[o.plateNumber, `${Math.round(o.speedKph)} km/h`, o.driverName].filter(Boolean).join(' · ')}
        </Text>
        <VehicleDayDetails o={o} stats={stats?.[o.objectId]} now={now} />
      </View>
      <View style={{ alignItems: 'flex-end', alignSelf: 'flex-start' }}>
        <Text size="sm" weight="600" style={{ color }}>
          {activity ? t(displayStatusLabel(o)) : (timeInStatus(t(meta.label), o.statusSince, now) ?? t(meta.label))}
        </Text>
        <Text size="xs" tone="muted">
          {relativeTime(o.serverTime ?? o.fixTime, now)}
        </Text>
      </View>
    </Pressable>
  );
}

function FilterButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} style={[styles.filter, { borderColor: active ? c.primary : c.border, backgroundColor: active ? c.accent : c.card }]}>
      <Text size="sm" numberOfLines={1} style={{ flex: 1 }} tone={active ? 'primary' : 'default'} weight={active ? '600' : '400'}>
        {label}
      </Text>
      <ChevronDownIcon size={16} color={c.mutedForeground} />
    </Pressable>
  );
}

export default function LiveMapScreen() {
  const c = useColors();
  const scheme = useScheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { can } = useAuth();
  const version = useLiveVersion(1000);
  const now = useNow();
  const connection = useRealtimeStatus();
  const map = useRef<FleetMapHandle>(null);

  const [height, setHeight] = useState(0);
  const [snap, setSnap] = useState<SheetSnap>('half');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [branchId, setBranchId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dayStats = useDayStats();
  const [follow, setFollow] = useState(false);
  const [view, setView] = useState<MapView | null>(null);
  const [showPois, setShowPois] = useState(false);
  const [mapTypesOpen, setMapTypesOpen] = useState(false);
  const { type: mapType, satelliteAvailable } = useBasemap();
  const mapTypeOptions: { value: BasemapType; label: string }[] = [
    { value: 'standard', label: t('Standard') },
    { value: 'light', label: t('Light') },
    ...(satelliteAvailable ? [{ value: 'satellite' as const, label: t('Satellite') }] : []),
  ];
  const [poi, setPoi] = useState<PoiDto | null>(null);
  const poiCategories = usePoiCategories();

  // POIs in the visible area (bbox rounded so small pans reuse the cached page; the API caps a page at 200).
  const bbox = view ? [view.bounds[1], view.bounds[0], view.bounds[3], view.bounds[2]].map((v, i) => (i < 2 ? Math.floor(v * 100) / 100 : Math.ceil(v * 100) / 100)).join(',') : null;
  const pois = useQuery({
    queryKey: ['pois', 'map', bbox],
    queryFn: ({ signal }) => api.get<Paginated<PoiDto>>('/pois', { bbox: bbox!, pageSize: 200, status: 'ACTIVE' }, signal),
    enabled: can('pois') && showPois && !!bbox,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const branches = useQuery({
    queryKey: ['options', 'branches-all'],
    queryFn: ({ signal }) => api.get<Paginated<BranchDto>>('/branches', { pageSize: 200, status: 'ACTIVE' }, signal),
    enabled: can('branches'),
    staleTime: 5 * 60_000,
  });
  const groups = useQuery({
    queryKey: ['options', 'groups-all'],
    queryFn: ({ signal }) => api.get<Paginated<VehicleGroupDto>>('/vehicle-groups', { pageSize: 200, status: 'ACTIVE' }, signal),
    enabled: can('vehicle_groups'),
    staleTime: 5 * 60_000,
  });
  const groupMembers = useMemo(() => new Map((groups.data?.items ?? []).map((g) => [g.id, new Set(g.objects.map((o) => o.id))])), [groups.data]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => liveStore.all(), [version]);
  // Everything except the status chips, so the chips show counts for the other filters (same as the web panel).
  const base = useMemo(() => {
    const s = q.trim().toLowerCase();
    const members = groupId ? groupMembers.get(groupId) : null;
    const [kind, value] = type ? type.split(':') : [null, null];
    return all
      .filter(
        (o) =>
          matchesSearch(o, s) &&
          (!branchId || o.branchId === branchId) &&
          (!members || members.has(o.objectId)) &&
          (kind !== 'vt' || o.vehicleType === value) &&
          (kind !== 'ot' || o.type === value),
      )
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [all, q, branchId, groupId, groupMembers, type]);
  const visible = useMemo(() => (status === 'ALL' ? base : base.filter((o) => o.status === status)), [base, status]);
  const counts = useMemo(() => {
    const n = Object.fromEntries(MOVEMENT_STATUSES.map((s) => [s, 0])) as Record<MovementStatus, number>;
    for (const o of base) n[o.status]++;
    return n;
  }, [base]);
  const selected = selectedId ? liveStore.get(selectedId) : undefined;

  // Frame the fleet once the first snapshot arrives, then whenever the filters change.
  const framed = useRef(false);
  useEffect(() => {
    if (!framed.current && liveStore.snapshotLoaded && all.length) {
      framed.current = true;
      map.current?.fitAll(all, false);
    }
  }, [all]);
  useEffect(() => {
    if (framed.current) map.current?.fitAll(visible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, branchId, groupId, type]);
  useEffect(() => {
    if (follow && selected) map.current?.focus(selected, 16);
  }, [follow, selected]);

  const select = (id: string | null) => {
    setPoi(null);
    setSelectedId(id);
    setFollow(false);
    const o = id ? liveStore.get(id) : undefined;
    if (o) {
      map.current?.focus(o);
      setSnap('peek');
    }
  };

  const branchOptions: PickOption[] = (branches.data?.items ?? []).map((b) => ({ value: b.id, label: b.name }));
  const groupOptions: PickOption[] = (groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }));
  const typeOptions = useMemo(() => TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.label) })), [t]);
  const labelOf = (opts: PickOption[], v: string | null, all: string) => (v ? (opts.find((o) => o.value === v)?.label ?? all) : all);
  const filtersActive = !!(q || branchId || groupId || type || status !== 'ALL');

  const listHeader = (
    <View style={{ paddingHorizontal: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.md }}>
      <View style={[styles.search, { borderColor: c.border, backgroundColor: c.background }]}>
        <SearchIcon size={18} color={c.mutedForeground} />
        <TextInput
          value={q}
          onChangeText={setQ}
          onFocus={() => setSnap('full')}
          placeholder={t('Search name, plate or IMEI')}
          placeholderTextColor={c.mutedForeground}
          autoCorrect={false}
          autoCapitalize="none"
          style={{ flex: 1, fontSize: 15, color: c.foreground, paddingVertical: 0 }}
        />
        {!!q && (
          <Pressable onPress={() => setQ('')} hitSlop={10} accessibilityLabel={t('Clear search')}>
            <XIcon size={16} color={c.mutedForeground} />
          </Pressable>
        )}
      </View>
      <View style={styles.chips}>
        {(['ALL', ...MOVEMENT_STATUSES] as StatusFilter[]).map((s) => {
          const on = status === s;
          const color = s === 'ALL' ? c.primary : statusColor(s, scheme);
          return (
            <Pressable
              key={s}
              onPress={() => setStatus(on && s !== 'ALL' ? 'ALL' : s)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.chip, on ? { backgroundColor: color, borderColor: color } : { borderColor: c.border, backgroundColor: c.card }]}
            >
              {s !== 'ALL' && <View style={[styles.chipDot, { backgroundColor: on ? '#fff' : color }]} />}
              <Text size="sm" weight="600" style={{ color: on ? '#fff' : c.foreground }}>
                {s === 'ALL' ? t('All') : t(STATUS_META[s].label)} <Text size="sm" style={{ color: on ? '#fff' : c.mutedForeground }}>{s === 'ALL' ? base.length : counts[s]}</Text>
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
        {can('branches') && <FilterButton label={labelOf(branchOptions, branchId, t('All branches'))} active={!!branchId} onPress={() => setPicker('branch')} />}
        {can('vehicle_groups') && <FilterButton label={labelOf(groupOptions, groupId, t('All groups'))} active={!!groupId} onPress={() => setPicker('group')} />}
        <FilterButton label={labelOf(typeOptions, type, t('All types'))} active={!!type} onPress={() => setPicker('type')} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text size="sm" tone="muted" style={{ flex: 1 }}>
          {t('{{count}} shown', { count: visible.length })}
        </Text>
        {filtersActive && (
          <Pressable
            onPress={() => {
              setQ('');
              setStatus('ALL');
              setBranchId(null);
              setGroupId(null);
              setType(null);
            }}
            hitSlop={8}
          >
            <Text size="sm" tone="primary" weight="600">
              {t('Clear filters')}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );

  const selectedHeader = selected && (
    <View style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.lg, gap: SPACE.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <Pressable onPress={() => select(null)} hitSlop={10} accessibilityLabel={t('Back to list')} style={{ padding: 2 }}>
          <ArrowLeftIcon size={20} color={c.foreground} />
        </Pressable>
        <Text size="sm" tone="muted" style={{ flex: 1 }}>
          {t('All vehicles')}
        </Text>
      </View>
      <VehicleSummary o={selected} now={now} />
      <VehicleDayDetails o={selected} stats={dayStats.data?.[selected.objectId]} now={now} />
      {selected.driverName && (
        <Text size="sm" tone="muted">
          {t('Driver:')} <Text size="sm" weight="600">{selected.driverName}</Text>
        </Text>
      )}
      <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
        <Button title={t('Details')} icon={ChevronRightIcon} style={{ flex: 1 }} onPress={() => router.push(`/vehicle/${selected.objectId}`)} />
        <Button
          title={follow ? t('Following') : t('Follow')}
          icon={LocateFixedIcon}
          variant={follow ? 'primary' : 'outline'}
          style={{ flex: 1 }}
          onPress={() => setFollow((f) => !f)}
        />
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      <FleetMap ref={map} objects={visible} selectedId={selectedId} onSelect={select} onViewChange={setView}>
        {showPois && can('pois') && (
          <PoiLayer
            pois={pois.data?.items ?? []}
            selectedId={poi?.id}
            onSelect={(p) => {
              setPoi(p);
              setSnap('peek');
            }}
          />
        )}
      </FleetMap>

      <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
        {connection === 'disconnected' && (
          <View style={[styles.offline, { backgroundColor: c.warning }]}>
            <Text size="xs" weight="600" style={{ color: '#fff' }}>
              {t('Reconnecting… positions may be out of date')}
            </Text>
          </View>
        )}
        <Pressable accessibilityLabel={t('Show all vehicles')} onPress={() => map.current?.fitAll(visible)} style={[styles.fab, { backgroundColor: c.card, borderColor: c.border }]}>
          <MaximizeIcon size={20} color={c.foreground} />
        </Pressable>
        <Pressable
          accessibilityLabel={t('Map type')}
          accessibilityState={{ expanded: mapTypesOpen }}
          onPress={() => setMapTypesOpen((v) => !v)}
          style={[styles.fab, mapTypesOpen ? { backgroundColor: c.primary, borderColor: c.primary } : { backgroundColor: c.card, borderColor: c.border }]}
        >
          <LayersIcon size={20} color={mapTypesOpen ? '#fff' : c.foreground} />
        </Pressable>
        {mapTypesOpen && (
          <View style={[styles.mapTypes, { backgroundColor: c.card, borderColor: c.border }]} accessibilityRole="radiogroup">
            {mapTypeOptions.map((o) => (
              <Pressable
                key={o.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: mapType === o.value }}
                onPress={() => {
                  basemap.set(o.value);
                  setMapTypesOpen(false);
                }}
                style={[styles.mapTypeOption, mapType === o.value && { backgroundColor: c.accent }]}
              >
                <Text size="sm" weight={mapType === o.value ? '600' : '400'}>
                  {o.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {can('pois') && (
          <Pressable
            accessibilityLabel={showPois ? t('Hide points of interest') : t('Show points of interest')}
            accessibilityState={{ selected: showPois }}
            onPress={() => {
              setShowPois((v) => !v);
              setPoi(null);
            }}
            style={[styles.fab, showPois ? { backgroundColor: c.primary, borderColor: c.primary } : { backgroundColor: c.card, borderColor: c.border }]}
          >
            <MapPinIcon size={20} color={showPois ? '#fff' : c.foreground} />
          </Pressable>
        )}
        {can('pois', 'create') && (
          <Pressable
            accessibilityLabel={t('Add POI here')}
            onPress={() =>
              router.push(view ? { pathname: '/pois/[id]', params: { id: 'new', lat: view.center[1].toFixed(6), lng: view.center[0].toFixed(6) } } : { pathname: '/pois/[id]', params: { id: 'new' } })
            }
            style={[styles.fab, { backgroundColor: c.card, borderColor: c.border }]}
          >
            <MapPinPlusIcon size={20} color={c.foreground} />
          </Pressable>
        )}
        {poi && (
          <Pressable onPress={() => router.push(`/pois/${poi.id}`)} style={[styles.poiCard, { backgroundColor: c.card, borderColor: c.border }]}>
            <View style={[styles.dot, { backgroundColor: poi.color }]} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text weight="700" numberOfLines={1}>
                {poi.name}
              </Text>
              <Text size="sm" tone="muted" numberOfLines={1}>
                {[poiCategories.label(poi.category), `${poi.radiusM} m`, poi.address].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <Pressable onPress={() => setPoi(null)} hitSlop={10} accessibilityLabel={t('Close')}>
              <XIcon size={18} color={c.mutedForeground} />
            </Pressable>
          </Pressable>
        )}
      </SafeAreaView>

      {height > 0 && (
        <LiveSheet containerHeight={height} topInset={insets.top + 56} snap={snap} onSnapChange={setSnap} header={selected ? selectedHeader : listHeader}>
          {!selected && (
            <FlatList
              data={visible}
              keyExtractor={(o) => o.objectId}
              keyboardShouldPersistTaps="handled"
              initialNumToRender={20}
              contentContainerStyle={{ paddingBottom: insets.bottom + SPACE.xl }}
              renderItem={({ item }) => <VehicleRow o={item} now={now} stats={dayStats.data} onPress={() => select(item.objectId)} />}
              ListEmptyComponent={
                liveStore.snapshotLoaded ? (
                  <Text tone="muted" style={{ textAlign: 'center', padding: SPACE.xl }}>
                    {all.length ? t('No vehicles match these filters.') : t('No vehicles yet.')}
                  </Text>
                ) : undefined
              }
            />
          )}
        </LiveSheet>
      )}

      <PickerSheet open={picker === 'branch'} title={t('Branch')} allLabel={t('All branches')} options={branchOptions} value={branchId} onChange={setBranchId} onClose={() => setPicker(null)} />
      <PickerSheet open={picker === 'group'} title={t('Vehicle group')} allLabel={t('All groups')} options={groupOptions} value={groupId} onChange={setGroupId} onClose={() => setPicker(null)} />
      <PickerSheet open={picker === 'type'} title={t('Type')} allLabel={t('All types')} options={typeOptions} value={type} onChange={setType} onClose={() => setPicker(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', top: 0, right: 0, left: 0, alignItems: 'flex-end', gap: SPACE.sm, paddingTop: SPACE.sm, paddingHorizontal: SPACE.lg },
  offline: { alignSelf: 'center', paddingHorizontal: SPACE.md, paddingVertical: 4, borderRadius: RADIUS.full },
  fab: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, elevation: 3 },
  mapTypes: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: 4, gap: 2, minWidth: 120, elevation: 3 },
  mapTypeOption: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS.sm },
  search: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, height: 46, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 32, borderRadius: RADIUS.full, borderWidth: 1 },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  filter: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, height: 40, borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingHorizontal: SPACE.lg, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 10, height: 10, borderRadius: 5 },
  poiCard: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, elevation: 3 },
});
