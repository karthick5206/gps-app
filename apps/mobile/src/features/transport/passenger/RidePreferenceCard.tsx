import type { RidePreference, TransportBookingJourney, TransportSharingPolicyDto } from '@veetracer/shared';
import { CheckSquareIcon, SquareIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Card, Chips, SectionTitle, Text } from '@/components/ui';
import { SPACE, useColors } from '@/lib/theme';
import { defaultPreference, limitLines, limitsFor, needsAcceptance, PREFERENCE_HINT, PREFERENCE_LABEL, preferenceChoices } from '../ride-preference';
import { TOUCH } from '../ui';

function PolicyText({ policy }: { policy: TransportSharingPolicyDto }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = policy.text.length > 240;
  return (
    <View style={{ gap: SPACE.xs }}>
      <Text size="sm" weight="600">
        {policy.version > 0 ? t('Sharing policy (version {{v}})', { v: policy.version }) : t('Sharing policy')}
      </Text>
      <Text size="sm" tone="muted" numberOfLines={open || !long ? undefined : 5}>
        {policy.text}
      </Text>
      {long && (
        <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" style={{ minHeight: TOUCH, justifyContent: 'center' }}>
          <Text size="sm" tone="primary" weight="600">
            {open ? t('Show less') : t('Read the whole policy')}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function Limits({ policy, pref }: { policy: TransportSharingPolicyDto; pref: RidePreference }) {
  const { t } = useTranslation();
  const lines = limitLines(limitsFor(policy, pref), policy.companyMaxRideS);
  if (!lines.length) return null;
  return (
    <View style={{ gap: 2 }} accessibilityLabel={t('Sharing limits')}>
      {lines.map((l) => (
        <Text key={l.key} size="sm">
          • {t(l.key, l.vars)}
        </Text>
      ))}
    </View>
  );
}

/**
 * Request a ride (doc 20 §7): shared / private / flexible with the company sharing policy text and the limits the
 * passenger accepts. Shared / flexible point-to-point rides need the explicit acceptance; its version is sent.
 */
export function RidePreferenceCard({ policy, journey, value, onChange, accepted, onAccept }: { policy: TransportSharingPolicyDto; journey: TransportBookingJourney; value: RidePreference | null; onChange: (p: RidePreference) => void; accepted: boolean; onAccept: (v: boolean) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const pref = value ?? defaultPreference(journey);
  const required = needsAcceptance(pref, journey);
  return (
    <>
      <SectionTitle>{t('Ride preference')}</SectionTitle>
      <Chips<RidePreference> options={preferenceChoices(policy).map((p) => ({ value: p, label: t(PREFERENCE_LABEL[p]) }))} value={pref} onChange={onChange} />
      <Text size="xs" tone="muted">
        {t(PREFERENCE_HINT[pref])}
      </Text>
      {pref !== 'PRIVATE' && (
        <Card style={{ gap: SPACE.sm }}>
          <PolicyText policy={policy} />
          <Limits policy={policy} pref={pref} />
          <Pressable
            onPress={() => onAccept(!accepted)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: accepted }}
            accessibilityLabel={t('I accept the sharing policy and these limits')}
            style={({ pressed }) => [{ minHeight: TOUCH, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }, pressed && { opacity: 0.8 }]}
          >
            {accepted ? <CheckSquareIcon size={24} color={c.primary} /> : <SquareIcon size={24} color={c.mutedForeground} />}
            <View style={{ flex: 1 }}>
              <Text weight="600">{t('I accept the sharing policy and these limits')}</Text>
              {!required && (
                <Text size="xs" tone="muted">
                  {t('Optional for commute rides: they are shared rides by default.')}
                </Text>
              )}
            </View>
          </Pressable>
        </Card>
      )}
    </>
  );
}

/** Book (commute): commute rides are shared rides under the company policy (the commute booking has no choice yet). */
export function CommuteSharingNote({ policy }: { policy: TransportSharingPolicyDto }) {
  const { t } = useTranslation();
  return (
    <Card style={{ gap: SPACE.sm }}>
      <Text weight="600">{t('Commute rides are shared rides')}</Text>
      <Text size="sm" tone="muted">
        {t('You may ride with colleagues going the same way. For a private ride, use Request a ride.')}
      </Text>
      <Limits policy={policy} pref="SHARED" />
      <PolicyText policy={policy} />
    </Card>
  );
}
