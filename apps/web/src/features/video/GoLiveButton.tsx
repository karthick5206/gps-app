import type { VideoChannelsDto } from '@veetracer/shared';
import { RadioIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { floatingVideo } from './floating-video-store';
import { videoErrorText } from './VideoPlayer';

/** Opens the vehicle's cameras in the floating live player (all channels, one below another). */
export function GoLiveButton({ objectId, vehicle, size = 'sm' }: { objectId: string; vehicle: string; size?: 'sm' | 'default' }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const c = await api.get<VideoChannelsDto>(`/video/${objectId}/channels`);
      floatingVideo.open(objectId, vehicle, c.channels, c.channels);
    } catch (e) {
      toast.error(videoErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size={size} variant="outline" onClick={() => void open()} disabled={busy}>
      {busy ? <Spinner /> : <RadioIcon />} {t('Go live')}
    </Button>
  );
}
