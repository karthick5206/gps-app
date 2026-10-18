import { Camera, GeoJSONSource, Layer, Map, type CameraRef } from '@maplibre/maplibre-react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GeofenceDto, GeofenceGeometry, GeofenceMode, LatLng } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { CircleIcon, PentagonIcon, Trash2Icon, Undo2Icon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { blankToNull, SwitchRow } from '@/components/form';
import { Button, Chips, ErrorBanner, Field, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { geometryBounds, geometryFeature } from '@/features/geofences/geo-shapes';
import { liveStore } from '@/features/live/live-store';
import { boundsOf } from '@/features/map/FleetMap';
import { api, errorMessage } from '@/lib/api';
import { MAP_STYLE } from '@/lib/config';
import { RADIUS, SPACE, useColors, useScheme } from '@/lib/theme';

type Shape = 'CIRCLE' | 'POLYGON';
const COLORS = ['#0f766e', '#2563eb', '#9333ea', '#dc2626', '#d97706', '#16a34a'];
const RADII = [100, 250, 500, 1000, 2000, 5000];

export default function GeofenceEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const c = useColors();
  const scheme = useScheme();
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const camera = useRef<CameraRef>(null);
  const canSave = isNew ? can('geofences', 'create') : can('geofences', 'edit');

  const record = useQuery({ queryKey: ['geofence', id], queryFn: ({ signal }) => api.get<GeofenceDto>(`/geofences/${id}`, undefined, signal), enabled: !isNew });
  const [shape, setShape] = useState<Shape>('CIRCLE');
  const [center, setCenter] = useState<LatLng | null>(null);
  const [radiusM, setRadiusM] = useState(500);
  const [points, setPoints] = useState<LatLng[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [mode, setMode] = useState<GeofenceMode>('NORMAL');
  const [notifyEnter, setNotifyEnter] = useState(true);
  const [notifyExit, setNotifyExit] = useState(true);
  const [speedLimit, setSpeedLimit] = useState('');
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    const g = record.data;
    if (!g) return;
    setName(g.name);
    setColor(g.color);
    setMode(g.mode);
    setNotifyEnter(g.notifyEnter);
    setNotifyExit(g.notifyExit);
    setSpeedLimit(g.speedLimitKph ? String(g.speedLimitKph) : '');
    setIsActive(g.isActive);
    if (g.geometry.type === 'CIRCLE') {
      setShape('CIRCLE');
      setCenter(g.geometry.center);
      setRadiusM(g.geometry.radiusM);
    } else {
      setShape('POLYGON');
      setPoints(g.geometry.points);
    }
    setTimeout(() => camera.current?.fitBounds(geometryBounds(g.geometry), { padding: { top: 40, bottom: 40, left: 40, right: 40 }, duration: 0 }), 300);
  }, [record.data]);

  const geometry: GeofenceGeometry | null = shape === 'CIRCLE' ? (center ? { type: 'CIRCLE', center, radiusM } : null) : points.length >= 3 ? { type: 'POLYGON', points } : null;
  const fill = useMemo<GeoJSON.FeatureCollection>(() => {
    const f = geometry ? geometryFeature(geometry) : null;
    return { type: 'FeatureCollection', features: f ? [f] : [] };
  }, [geometry]);
  const vertices = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: (shape === 'CIRCLE' ? (center ? [center] : []) : points).map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: {} })),
    }),
    [shape, center, points],
  );

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['geofences'] });
    router.back();
  };
  const limit = speedLimit.trim() === '' ? null : Number(speedLimit);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), geometry, color, mode, notifyEnter, notifyExit, speedLimitKph: limit, isActive, address: blankToNull(record.data?.address ?? '') };
      return isNew ? api.post('/geofences', body) : api.patch(`/geofences/${id}`, body);
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.delete(`/geofences/${id}`), onSuccess: done, onError: (err) => Alert.alert(t('Not deleted'), errorMessage(err)) });

  const onMapPress = (lng: number, lat: number) => {
    if (!canSave) return;
    if (shape === 'CIRCLE') setCenter({ lat, lng });
    else setPoints((p) => [...p, { lat, lng }]);
  };
  const submit = () => {
    if (!name.trim()) return Alert.alert(t('Name is required'));
    if (!geometry) return Alert.alert(shape === 'CIRCLE' ? t('Tap the map to place the centre') : t('Tap at least 3 points on the map'));
    if (limit !== null && (!Number.isInteger(limit) || limit < 5 || limit > 250)) return Alert.alert(t('Speed limit must be 5 – 250 km/h'));
    save.mutate();
  };

  const fleet = liveStore.all();
  const start = boundsOf(fleet);
  return (
    <>
      <Stack.Screen
        options={{
          title: isNew ? t('New geofence') : t('Edit geofence'),
          headerRight: () =>
            !isNew && can('geofences', 'delete') ? (
              <Pressable
                onPress={() =>
                  Alert.alert(t('Delete {{name}}?', { name: name || t('geofence') }), t('Visits already recorded are kept in reports.'), [
                    { text: t('Cancel'), style: 'cancel' },
                    { text: t('Delete'), style: 'destructive', onPress: () => remove.mutate() },
                  ])
                }
                hitSlop={10}
                style={{ paddingHorizontal: SPACE.sm }}
              >
                {remove.isPending ? <ActivityIndicator /> : <Trash2Icon size={22} color={c.destructive} />}
              </Pressable>
            ) : null,
        }}
      />
      <View style={{ height: 320 }}>
        <Map style={{ flex: 1 }} mapStyle={MAP_STYLE[scheme]} logo={false} attributionPosition={{ bottom: 4, left: 8 }} touchPitch={false} onPress={(e) => onMapPress(e.nativeEvent.lngLat[0], e.nativeEvent.lngLat[1])}>
          <Camera
            ref={camera}
            initialViewState={start ? { bounds: start, padding: { top: 40, bottom: 40, left: 40, right: 40 } } : { center: [80.27, 13.08], zoom: 11 }}
          />
          <GeoJSONSource id="gf-fill" data={fill}>
            <Layer id="gf-area" type="fill" paint={{ 'fill-color': color, 'fill-opacity': 0.2 }} />
            <Layer id="gf-edge" type="line" paint={{ 'line-color': color, 'line-width': 2.5 }} />
          </GeoJSONSource>
          <GeoJSONSource id="gf-points" data={vertices}>
            <Layer id="gf-vertex" type="circle" paint={{ 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': color, 'circle-stroke-width': 3 }} />
          </GeoJSONSource>
        </Map>
        {canSave && (
          <View style={[styles.hint, { backgroundColor: c.card }]}>
            <Text size="xs" weight="600">
              {shape === 'CIRCLE' ? (center ? t('Tap to move the centre') : t('Tap the map to place the centre')) : t('Tap to add points ({{count}})', { count: points.length })}
            </Text>
            {shape === 'POLYGON' && points.length > 0 && (
              <Pressable onPress={() => setPoints((p) => p.slice(0, -1))} hitSlop={8} accessibilityLabel={t('Undo last point')}>
                <Undo2Icon size={16} color={c.primary} />
              </Pressable>
            )}
          </View>
        )}
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          {!isNew && record.isPending && <ActivityIndicator />}
          <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
            {(['CIRCLE', 'POLYGON'] as Shape[]).map((s) => {
              const on = shape === s;
              const Icon = s === 'CIRCLE' ? CircleIcon : PentagonIcon;
              return (
                <Pressable key={s} disabled={!canSave} onPress={() => setShape(s)} style={[styles.shape, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.accent : c.card }]}>
                  <Icon size={18} color={on ? c.primary : c.mutedForeground} />
                  <Text weight={on ? '600' : '400'} tone={on ? 'primary' : 'default'}>
                    {s === 'CIRCLE' ? t('Circle') : t('Polygon')}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {shape === 'CIRCLE' && (
            <View style={{ gap: 6 }}>
              <Text size="sm" weight="500">
                {t('Radius')}
              </Text>
              <Chips value={String(radiusM)} onChange={(v) => setRadiusM(Number(v))} options={RADII.map((r) => ({ value: String(r), label: r >= 1000 ? `${r / 1000} km` : `${r} m` }))} />
            </View>
          )}
          <Field label={t('Name *')} value={name} onChangeText={setName} placeholder={t('e.g. Chennai depot')} editable={canSave} />
          <View style={{ gap: 6 }}>
            <Text size="sm" weight="500">
              {t('Type')}
            </Text>
            <Chips
              value={mode}
              onChange={setMode}
              options={[
                { value: 'NORMAL', label: t('Normal') },
                { value: 'NO_GO', label: t('No-go') },
                { value: 'KEEP_IN', label: t('Keep-in') },
              ]}
            />
            <Text size="xs" tone="muted">
              {t('No-go: entering is critical. Keep-in: leaving is critical.')}
            </Text>
          </View>
          <View style={{ gap: 6 }}>
            <Text size="sm" weight="500">
              {t('Colour')}
            </Text>
            <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
              {COLORS.map((col) => (
                <Pressable key={col} onPress={() => setColor(col)} accessibilityLabel={t('Colour {{color}}', { color: col })} style={[styles.swatch, { backgroundColor: col, borderColor: col === color ? c.foreground : 'transparent' }]} />
              ))}
            </View>
          </View>
          <SwitchRow label={t('Alert on entry')} value={notifyEnter} onChange={setNotifyEnter} />
          <SwitchRow label={t('Alert on exit')} value={notifyExit} onChange={setNotifyExit} />
          <Field label={t('Speed limit inside (km/h)')} value={speedLimit} onChangeText={(v) => setSpeedLimit(v.replace(/\D/g, ''))} keyboardType="number-pad" placeholder={t('None')} hint={t('Overspeed inside this geofence raises an alert.')} editable={canSave} />
          <SwitchRow label={t('Active')} value={isActive} onChange={setIsActive} />
          <Text size="xs" tone="muted">
            {record.data && !record.data.appliesTo.all ? t('Applies to selected branches / groups / vehicles (set on the web).') : t('Applies to all vehicles.')} {t('Time windows, vehicle selection and import are in the web app.')}
          </Text>
          {save.isError && <ErrorBanner message={errorMessage(save.error)} />}
          {canSave && <Button title={isNew ? t('Create geofence') : t('Save')} onPress={submit} loading={save.isPending} />}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  hint: { position: 'absolute', top: SPACE.sm, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: 6, borderRadius: RADIUS.full, elevation: 3 },
  shape: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, height: 44, borderRadius: RADIUS.sm, borderWidth: 1 },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 3 },
});
