import type { MeTransportProfileDto } from '@veetracer/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, ScrollView, Switch, View } from 'react-native';
import { Button, Card, Chips, ErrorBanner, Field, SectionTitle, Text } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { SPACE } from '@/lib/theme';
import { contactsInput, homeInput, keptBookingsText, PROFILE_LIMITS, type ContactRow, type HomeChoice } from '../my-profile';
import { isNotPassenger, transportErrorText } from '../passenger-api';
import { profileErrorMessage, useMyPolicy, useMyProfile, useSaveProfile, useSetHome } from '../self-service-api';
import { Line, TOUCH, TransportEmpty } from '../ui';
import { PointPicker, type PickedPoint } from './PointPicker';

type HomeMode = 'MAP' | 'TYPED';

/** D-A9 home location: self-hosted address search / map pin, or a typed position. Needs the routing consent. */
function HomeEditor({ profile }: { profile: MeTransportProfileDto }) {
  const { t } = useTranslation();
  const setHome = useSetHome();
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<HomeMode>('MAP');
  const [picked, setPicked] = useState<PickedPoint | null>(null);
  const [typed, setTyped] = useState('');
  const [address, setAddress] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [kept, setKept] = useState<{ text: string; count: number } | null | undefined>(undefined);
  const home = profile.home;
  const current = home && home.lat !== null && home.lng !== null ? { lat: home.lat, lng: home.lng } : null;

  if (!profile.routingConsent) {
    return (
      <Card style={{ gap: SPACE.sm }}>
        <Text weight="500">{home?.address ?? t('No home location')}</Text>
        <Text size="sm" tone="muted">
          {t('Your home location is used only with your transport consent. Give it under Privacy & consent first.')}
        </Text>
        <Button title={t('Privacy & consent')} variant="outline" onPress={() => router.push('/commute/consent')} style={{ minHeight: TOUCH }} />
      </Card>
    );
  }

  const save = () => {
    setFormError(null);
    const choice: HomeChoice | null =
      mode === 'TYPED' ? { kind: 'TYPED', text: typed, address } : picked ? (picked.source === 'SEARCH' ? { kind: 'SEARCH', label: address || picked.label, lat: picked.lat, lng: picked.lng } : { kind: 'PIN', lat: picked.lat, lng: picked.lng, address }) : null;
    const req = homeInput(choice);
    if (!req.ok) {
      setFormError(t(req.error));
      return;
    }
    setHome.mutate(req.body, {
      onSuccess: (r) => {
        setKept(keptBookingsText(r.openBookingsKept));
        setEditing(false);
        setPicked(null);
        setTyped('');
      },
    });
  };
  const clear = () =>
    Alert.alert(t('Remove your home location?'), t('New bookings then need a pickup point from you or the desk.'), [
      { text: t('Keep'), style: 'cancel' },
      { text: t('Remove'), style: 'destructive', onPress: () => setHome.mutate({ clear: true }, { onSuccess: (r) => setKept(keptBookingsText(r.openBookingsKept)) }) },
    ]);

  return (
    <Card style={{ gap: SPACE.sm }}>
      <Text weight="500">{home?.address ?? (current ? t('Home location set') : t('No home location'))}</Text>
      {kept !== undefined && (
        <Text size="sm" tone="muted" accessibilityLiveRegion="polite">
          {t('Home location saved.')} {kept ? t(kept.text, { count: kept.count }) : ''}
        </Text>
      )}
      {!editing ? (
        <View style={{ gap: SPACE.sm }}>
          <Button title={current ? t('Change home location') : t('Set home location')} variant="outline" onPress={() => setEditing(true)} style={{ minHeight: TOUCH }} />
          {current && <Button title={t('Remove home location')} variant="ghost" onPress={clear} loading={setHome.isPending} style={{ minHeight: TOUCH }} />}
        </View>
      ) : (
        <View style={{ gap: SPACE.sm }}>
          <Chips<HomeMode>
            options={[
              { value: 'MAP', label: t('Search or map') },
              { value: 'TYPED', label: t('Type the position') },
            ]}
            value={mode}
            onChange={setMode}
          />
          {mode === 'MAP' ? (
            <PointPicker
              value={picked}
              center={current}
              onChange={(p) => {
                setPicked(p);
                if (p.source === 'SEARCH') setAddress(p.label.slice(0, PROFILE_LIMITS.addressMax));
              }}
            />
          ) : (
            <Field label={t('Latitude, longitude')} value={typed} onChangeText={setTyped} placeholder="12.9716, 77.5946" keyboardType="numbers-and-punctuation" />
          )}
          <Field label={t('Address (optional)')} value={address} onChangeText={setAddress} maxLength={PROFILE_LIMITS.addressMax} />
          {formError && <ErrorBanner message={formError} />}
          {setHome.isError && <ErrorBanner message={profileErrorMessage(setHome.error)} />}
          <Button title={t('Save home location')} onPress={save} loading={setHome.isPending} style={{ minHeight: TOUCH }} />
          <Button title={t('Cancel')} variant="ghost" onPress={() => setEditing(false)} style={{ minHeight: TOUCH }} />
          <Text size="xs" tone="muted">
            {t('Bookings you already have keep their earlier pickup point. New bookings use the new home location.')}
          </Text>
        </View>
      )}
    </Card>
  );
}

const toRows = (p: MeTransportProfileDto): ContactRow[] => {
  const rows = p.emergencyContacts.map((c) => ({ name: c.name, phone: c.phone, relation: c.relation ?? '' }));
  while (rows.length < PROFILE_LIMITS.contactsMax) rows.push({ name: '', phone: '', relation: '' });
  return rows.slice(0, PROFILE_LIMITS.contactsMax);
};

function ProfileForm({ profile }: { profile: MeTransportProfileDto }) {
  const { t } = useTranslation();
  const policy = useMyPolicy();
  const save = useSaveProfile();
  const [stopId, setStopId] = useState<string>(profile.defaultStop?.id ?? '');
  const [contacts, setContacts] = useState<ContactRow[]>(() => toRows(profile));
  const [wheelchair, setWheelchair] = useState(!!profile.accessibility.wheelchair);
  const [notes, setNotes] = useState(profile.accessibility.notes ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const stops = [...(policy.data?.stops ?? [])];
  if (profile.defaultStop && !stops.some((s) => s.id === profile.defaultStop!.id)) stops.unshift(profile.defaultStop);
  const setContact = (i: number, k: keyof ContactRow, v: string) => setContacts((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const submit = () => {
    setFormError(null);
    setSaved(false);
    const c = contactsInput(contacts);
    if (!c.ok) {
      setFormError(t(c.error));
      return;
    }
    const n = notes.trim().slice(0, PROFILE_LIMITS.notesMax);
    save.mutate({ defaultStopId: stopId || null, emergencyContacts: c.contacts, accessibility: { wheelchair, notes: n || null } }, { onSuccess: () => setSaved(true) });
  };
  return (
    <>
      <SectionTitle>{t('Default stop')}</SectionTitle>
      {stops.length === 0 ? (
        <Text size="sm" tone="muted">
          {t('Your company has no stops to choose from.')}
        </Text>
      ) : (
        <Chips<string> options={[{ value: '', label: t('None') }, ...stops.map((s) => ({ value: s.id, label: s.name }))]} value={stopId} onChange={setStopId} />
      )}

      <SectionTitle>{t('Emergency contacts')}</SectionTitle>
      {contacts.map((r, i) => (
        <Card key={i} style={{ gap: SPACE.sm }}>
          <Text size="sm" weight="500">
            {t('Contact {{n}}', { n: i + 1 })}
          </Text>
          <Field label={t('Name')} value={r.name} onChangeText={(v) => setContact(i, 'name', v)} maxLength={PROFILE_LIMITS.nameMax} />
          <Field label={t('Phone')} value={r.phone} onChangeText={(v) => setContact(i, 'phone', v)} maxLength={PROFILE_LIMITS.phoneMax} keyboardType="phone-pad" />
          <Field label={t('Relation (optional)')} value={r.relation} onChangeText={(v) => setContact(i, 'relation', v)} maxLength={PROFILE_LIMITS.relationMax} />
        </Card>
      ))}

      <SectionTitle>{t('Accessibility')}</SectionTitle>
      <Card style={{ gap: SPACE.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: TOUCH }}>
          <Text style={{ flex: 1 }} weight="500">
            {t('I use a wheelchair')}
          </Text>
          <Switch value={wheelchair} onValueChange={setWheelchair} accessibilityLabel={t('I use a wheelchair')} />
        </View>
        <Field label={t('Other needs (optional)')} value={notes} onChangeText={setNotes} maxLength={PROFILE_LIMITS.notesMax} multiline />
      </Card>

      {formError && <ErrorBanner message={formError} />}
      {save.isError && <ErrorBanner message={profileErrorMessage(save.error)} />}
      {saved && (
        <Text size="sm" tone="primary" accessibilityLiveRegion="polite">
          {t('Saved.')}
        </Text>
      )}
      <Button title={t('Save profile')} onPress={submit} loading={save.isPending} style={{ minHeight: TOUCH }} />
    </>
  );
}

/**
 * My transport profile (WP 3.9 wave 2, D-A9): own details (identity read-only), home location (consent required),
 * default stop, emergency contacts (≤ 3) and accessibility. Data only from /api/me/transport/profile (own profile).
 */
export function MyProfileScreen() {
  const { t } = useTranslation();
  const q = useMyProfile();
  if (q.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (isNotPassenger(q.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
      </View>
    );
  }
  if (q.error instanceof ApiError && q.error.status === 404 && !q.error.code) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('Not available yet')} description={t('Your transport desk keeps your profile for now.')} />
      </View>
    );
  }
  if (q.isError || !q.data) return <ErrorBanner message={transportErrorText(q.error)} onRetry={() => void q.refetch()} />;
  const p = q.data;
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
      <Card>
        <Line label={t('Name')}>{p.displayName}</Line>
        <Line label={t('Employee code')}>{p.employeeCode}</Line>
        {p.branchName ? <Line label={t('Branch')}>{p.branchName}</Line> : null}
        {p.officeName ? <Line label={t('Office')}>{p.officeName}</Line> : null}
        <Line label={t('Login email')}>{p.email ?? '—'}</Line>
        <Line label={t('Login mobile')}>{p.mobile ?? '—'}</Line>
        <Text size="xs" tone="muted" style={{ marginTop: SPACE.sm }}>
          {t('Your name, email and mobile are kept by your company. Ask your transport desk to change them.')}
        </Text>
      </Card>

      <SectionTitle>{t('Home location')}</SectionTitle>
      <HomeEditor profile={p} />

      <ProfileForm profile={p} />
    </ScrollView>
  );
}
