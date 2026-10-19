import { Camera, GeoJSONSource, Layer, Map, type MapRef } from '@maplibre/maplibre-react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { POI_DEFAULT_COLOR, POI_DEFAULT_RADIUS_M, POI_MAX_RADIUS_M, POI_MIN_RADIUS_M, type BranchDto, type LatLng, type Paginated, type PoiDto } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { CrosshairIcon, PlusIcon, Trash2Icon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { blankToNull, ChoiceField, SwitchRow } from '@/components/form';
import { Button, Chips, ErrorBanner, Field, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { circleRing } from '@/features/geofences/geo-shapes';
import { liveStore } from '@/features/live/live-store';
import { boundsOf } from '@/features/map/FleetMap';
import { formatRadius, usePoiCategories } from '@/features/pois/categories';
import { api, errorMessage } from '@/lib/api';
import { MAP_STYLE } from '@/lib/config';
import { RADIUS, SPACE, useColors, useScheme } from '@/lib/theme';

const COLORS = [POI_DEFAULT_COLOR, '#0f766e', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#475569'];
const RADII = [50, 100, 250, 500, 1000];

const parseCoord = (v: string | undefined, max: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
};

export default function PoiScreen() {
  const params = useLocalSearchParams<{ id: string; lat?: string; lng?: string }>();
  const id = params.id;
  const isNew = id === 'new';
  const c = useColors();
  const scheme = useScheme();
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const queryClient = useQueryClient();
  const mapRef = useRef<MapRef>(null);
  const categories = usePoiCategories();
  const editable = isNew ? can('pois', 'create') : can('pois', 'edit');
  const assignedScope = me?.dataScope === 'ASSIGNED';

  const record = useQuery({ queryKey: ['pois', 'one', id], queryFn: ({ signal }) => api.get<PoiDto>(`/pois/${id}`, undefined, signal), enabled: !isNew });
  const branches = useQuery({
    queryKey: ['options', '/branches', 'pois'],
    queryFn: ({ signal }) => api.get<Paginated<BranchDto>>('/branches', { pageSize: 200, status: 'ACTIVE' }, signal),
    enabled: editable && can('branches'),
    staleTime: 60_000,
  });

  const paramLat = parseCoord(params.lat, 90);
  const paramLng = parseCoord(params.lng, 180);
  const [pos, setPos] = useState<LatLng | null>(isNew && paramLat !== null && paramLng !== null ? { lat: paramLat, lng: paramLng } : null);
  const [f, setF] = useState({
    name: '',
    category: 'OTHER' as string | null,
    radiusM: String(POI_DEFAULT_RADIUS_M),
    color: POI_DEFAULT_COLOR,
    address: '',
    description: '',
    branchId: null as string | null,
    isActive: true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  const r = record.data;
  useEffect(() => {
    if (!r) return;
    setF({ name: r.name, category: r.category, radiusM: String(r.radiusM), color: r.color, address: r.address ?? '', description: r.description ?? '', branchId: r.branchId, isActive: r.isActive });
    setPos({ lat: r.lat, lng: r.lng });
  }, [r]);

  const radius = Number(f.radiusM);
  const radiusError =
    f.radiusM.trim() === '' || !Number.isInteger(radius) || radius < POI_MIN_RADIUS_M || radius > POI_MAX_RADIUS_M
      ? t('{{min}} – {{max}} m', { min: POI_MIN_RADIUS_M, max: POI_MAX_RADIUS_M })
      : undefined;

  const shapes = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!pos) return { type: 'FeatureCollection', features: [] };
    const features: GeoJSON.Feature[] = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] }, properties: { kind: 'pin' } }];
    if (!radiusError) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleRing(pos, radius)] }, properties: { kind: 'area' } });
    return { type: 'FeatureCollection', features };
  }, [pos, radius, radiusError]);

  const branchOptions = (branches.data?.items ?? []).map((b) => ({ value: b.id, label: b.name }));
  if (r?.branchId && !branchOptions.some((o) => o.value === r.branchId)) branchOptions.unshift({ value: r.branchId, label: r.branchName ?? '…' });
  const categoryOptions = categories.options.some((o) => o.value === f.category) || !f.category ? categories.options : [{ value: f.category, label: categories.label(f.category) }, ...categories.options];

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['pois'] });
    router.back();
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (isNew ? api.post<PoiDto>('/pois', body) : api.patch<PoiDto>(`/pois/${id}`, body)),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.delete(`/pois/${id}`), onSuccess: done, onError: (err) => Alert.alert(t('Not deleted'), errorMessage(err)) });

  const submit = () => {
    if (!f.name.trim()) return Alert.alert(t('Name is required'));
    if (!pos) return Alert.alert(t('Set the location: move the map and tap "Use map centre"'));
    if (radiusError) return;
    if (assignedScope && can('branches') && !f.branchId) return Alert.alert(t('Choose one of your branches as the owner'));
    save.mutate({
      name: f.name.trim(),
      category: f.category ?? 'OTHER',
      lat: Number(pos.lat.toFixed(6)),
      lng: Number(pos.lng.toFixed(6)),
      radiusM: radius,
      color: f.color,
      address: blankToNull(f.address),
      description: blankToNull(f.description),
      isActive: f.isActive,
      ...(can('branches') ? { branchId: f.branchId } : {}),
    });
  };
  const confirmDelete = () =>
    Alert.alert(t('Delete {{name}}?', { name: f.name || t('point of interest') }), t('Visits already recorded are kept in reports.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Delete'), style: 'destructive', onPress: () => remove.mutate() },
    ]);

  const fleet = boundsOf(liveStore.all());
  // The map is mounted once the record is loaded, so it can start on the POI.
  const start = pos ?? (r ? { lat: r.lat, lng: r.lng } : null);
  const initialView = start ? { center: [start.lng, start.lat] as [number, number], zoom: 16 } : fleet ? { bounds: fleet, padding: { top: 40, bottom: 40, left: 40, right: 40 } } : { center: [80.27, 13.08] as [number, number], zoom: 11 };
  const takeMapCentre = async () => {
    const centre = await mapRef.current?.getCenter();
    if (centre) setPos({ lat: centre[1], lng: centre[0] });
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: isNew ? t('New point of interest') : editable ? t('Edit point of interest') : t('Point of interest'),
          headerRight: () =>
            !isNew && can('pois', 'delete') ? (
              <Pressable onPress={confirmDelete} hitSlop={10} accessibilityLabel={t('Delete')} style={{ paddingHorizontal: SPACE.sm }}>
                {remove.isPending ? <ActivityIndicator /> : <Trash2Icon size={22} color={c.destructive} />}
              </Pressable>
            ) : null,
        }}
      />
      <View style={{ height: 280, backgroundColor: c.muted }}>
        {(isNew || r) && (
          <Map
            ref={mapRef}
            style={{ flex: 1 }}
            mapStyle={MAP_STYLE[scheme]}
            logo={false}
            attributionPosition={{ bottom: 4, left: 8 }}
            touchPitch={false}
            onPress={(e) => editable && setPos({ lat: e.nativeEvent.lngLat[1], lng: e.nativeEvent.lngLat[0] })}
          >
            <Camera initialViewState={initialView} />
            <GeoJSONSource id="poi-shape" data={shapes}>
              <Layer id="poi-area" type="fill" filter={['==', ['get', 'kind'], 'area']} paint={{ 'fill-color': f.color, 'fill-opacity': 0.15 }} />
              <Layer id="poi-edge" type="line" filter={['==', ['get', 'kind'], 'area']} paint={{ 'line-color': f.color, 'line-width': 2 }} />
              <Layer id="poi-pin" type="circle" filter={['==', ['get', 'kind'], 'pin']} paint={{ 'circle-radius': 8, 'circle-color': f.color, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 }} />
            </GeoJSONSource>
          </Map>
        )}
        {editable && (
          <>
            <View pointerEvents="none" style={styles.crosshair}>
              <PlusIcon size={28} color={c.foreground} strokeWidth={1.5} />
            </View>
            <View style={styles.mapActions} pointerEvents="box-none">
              <Pressable onPress={() => void takeMapCentre()} style={[styles.centreButton, { backgroundColor: c.card, borderColor: c.border }]} accessibilityRole="button">
                <CrosshairIcon size={16} color={c.primary} />
                <Text size="sm" weight="600" tone="primary">
                  {t('Use map centre')}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          {!isNew && record.isPending ? (
            <ActivityIndicator style={{ margin: SPACE.xl }} />
          ) : (
            <>
              <Text size="sm" tone={pos ? 'muted' : 'default'}>
                {pos
                  ? t('Location: {{lat}}, {{lng}}', { lat: pos.lat.toFixed(6), lng: pos.lng.toFixed(6) })
                  : t('Move the map so the + is on the place, then tap "Use map centre" (or tap the map).')}
              </Text>
              <Field label={t('Name *')} value={f.name} onChangeText={(v) => set('name', v)} placeholder={t('e.g. Chennai depot')} editable={editable} maxLength={100} />
              <ChoiceField label={t('Category')} value={f.category} allowEmpty={false} options={categoryOptions} onChange={(v) => set('category', v)} />
              <View style={{ gap: 6 }}>
                <Field
                  label={t('Radius (m)')}
                  value={f.radiusM}
                  onChangeText={(v) => set('radiusM', v.replace(/\D/g, ''))}
                  keyboardType="number-pad"
                  error={radiusError}
                  hint={t('A stop within this distance counts as a visit.')}
                  editable={editable}
                />
                {editable && <Chips value={f.radiusM} onChange={(v) => set('radiusM', v)} options={RADII.map((m) => ({ value: String(m), label: formatRadius(m) }))} />}
              </View>
              <View style={{ gap: 6 }}>
                <Text size="sm" weight="500">
                  {t('Colour')}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }}>
                  {COLORS.map((col) => (
                    <Pressable
                      key={col}
                      disabled={!editable}
                      onPress={() => set('color', col)}
                      accessibilityLabel={t('Colour {{color}}', { color: col })}
                      style={[styles.swatch, { backgroundColor: col, borderColor: col === f.color ? c.foreground : 'transparent' }]}
                    />
                  ))}
                </View>
              </View>
              <Field label={t('Address')} value={f.address} onChangeText={(v) => set('address', v)} editable={editable} maxLength={300} />
              <Field
                label={t('Description')}
                value={f.description}
                onChangeText={(v) => set('description', v)}
                editable={editable}
                maxLength={1000}
                multiline
                style={{ height: 80, textAlignVertical: 'top', paddingTop: 10 }}
              />
              {can('branches') && (
                <ChoiceField
                  label={t('Owner')}
                  value={f.branchId}
                  options={branchOptions}
                  allowEmpty={!assignedScope}
                  emptyLabel={assignedScope ? t('Choose a branch') : t('Company-wide')}
                  onChange={(v) => set('branchId', v)}
                />
              )}
              <SwitchRow label={t('Active')} value={f.isActive} onChange={(v) => set('isActive', v)} />
              {editable && <Button title={isNew ? t('Add point of interest') : t('Save')} onPress={submit} loading={save.isPending} />}
              {isNew && (
                <Text size="xs" tone="muted">
                  {t('Importing POIs from KML, GPX, GeoJSON or CSV files is in the web app.')}
                </Text>
              )}
            </>
          )}
          {!!(save.error ?? record.error) && <ErrorBanner message={errorMessage(save.error ?? record.error)} />}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  crosshair: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  mapActions: { position: 'absolute', top: SPACE.sm, left: 0, right: 0, alignItems: 'center' },
  centreButton: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: 6, borderRadius: RADIUS.full, borderWidth: StyleSheet.hairlineWidth, elevation: 3 },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 3 },
});
