import { NavigationIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Switch, View } from 'react-native';
import { Card, SectionTitle, Text } from '@/components/ui';
import { AccountScreen } from '@/features/transport/AccountScreen';
import { navHandoff, useNavHandoff } from '@/features/transport/nav-setting';
import { useDriverQueue } from '@/features/transport/queue-store';
import { SPACE, useColors } from '@/lib/theme';

/** Driver account: the common account screen plus the navigation hand-off switch (owner decision L6; off by default). */
export default function DriverAccountTab() {
  const { t } = useTranslation();
  const c = useColors();
  const q = useDriverQueue();
  const nav = useNavHandoff();
  return (
    <AccountScreen pendingEvents={q.pending}>
      <SectionTitle>{t('Navigation')}</SectionTitle>
      <Card style={{ gap: SPACE.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 48 }}>
          <NavigationIcon size={20} color={c.primary} />
          <Text weight="600" style={{ flex: 1 }}>
            {t('Open stops in a navigation app')}
          </Text>
          <Switch value={nav} onValueChange={navHandoff.set} accessibilityLabel={t('Open stops in a navigation app')} />
        </View>
        <Text size="xs" tone="muted">
          {t('Off by default. When on, the Navigate button sends only the stop coordinates and "Stop <number>" to the navigation app you choose (such as Google Maps or OsmAnd). That app’s provider then sees those coordinates.')}
        </Text>
      </Card>
    </AccountScreen>
  );
}
