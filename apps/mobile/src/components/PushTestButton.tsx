import { useMutation } from '@tanstack/react-query';
import { BellRingIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';
import { Button } from '@/components/ui';
import { registerForPush, sendTestPush } from '@/features/notifications/push';
import { errorMessage } from '@/lib/api';

/** Registers (if needed) and asks the server for a test notification, so users can check alerts reach the phone. */
export function PushTestButton() {
  const { t } = useTranslation();
  const test = useMutation({
    mutationFn: async () => {
      const notRegistered = await registerForPush();
      if (notRegistered) return notRegistered;
      return sendTestPush();
    },
    onSuccess: (reason) =>
      reason
        ? Alert.alert(t('Notifications not working'), t(reason))
        : Alert.alert(t('Test sent'), t('A test notification is on its way to this phone.')),
    onError: (err) => Alert.alert(t('Notifications not working'), errorMessage(err)),
  });
  return <Button title={t('Send test notification')} icon={BellRingIcon} variant="outline" loading={test.isPending} onPress={() => test.mutate()} />;
}
