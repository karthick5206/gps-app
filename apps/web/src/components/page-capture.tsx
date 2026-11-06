import { DownloadIcon, FileImageIcon, FileTextIcon } from 'lucide-react';
import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { savedAt, saveBlob, withHeader, type PictureCaption } from '@/lib/picture-header';

/** Elements marked with this attribute (buttons, menus) are left out of the picture. */
const CAPTURE_SKIP = 'data-capture-skip';

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

/**
 * "Download" for a page area (the dashboard): a PNG or a one-page PDF of what is on screen, with the same header band
 * as saved map pictures (VeeTrax, company, details, when and where). The capture libraries load on first use.
 */
export function PageCapture({ target, caption, fileName }: { target: RefObject<HTMLElement | null>; caption: () => PictureCaption; fileName: () => string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const shoot = async (kind: 'png' | 'pdf') => {
    const node = target.current;
    if (!node || busy) return;
    setBusy(true);
    try {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const { toBlob } = await import('html-to-image');
      const raw = await toBlob(node, {
        pixelRatio: ratio,
        backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
        filter: (n) => !(n instanceof HTMLElement && n.hasAttribute(CAPTURE_SKIP)),
        cacheBust: true,
      });
      if (!raw) throw new Error('empty');
      const blob = await withHeader(raw, caption(), t('Saved {{time}}', { time: savedAt() }));
      if (kind === 'png') {
        saveBlob(blob, `${fileName()}.png`);
      } else {
        const { jsPDF } = await import('jspdf');
        const bmp = await createImageBitmap(blob);
        // One page the size of the picture (points at 96 dpi), so nothing is cut or squeezed.
        const w = (bmp.width / ratio) * 0.75;
        const h = (bmp.height / ratio) * 0.75;
        bmp.close();
        const pdf = new jsPDF({ orientation: w > h ? 'landscape' : 'portrait', unit: 'pt', format: [w, h], compress: true });
        pdf.addImage(await blobToDataUrl(blob), 'PNG', 0, 0, w, h);
        pdf.save(`${fileName()}.pdf`);
      }
      toast.success(kind === 'png' ? t('Picture saved to your downloads') : t('PDF saved to your downloads'));
    } catch {
      toast.error(t('Could not save the page'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={busy} data-capture-skip="">
          <DownloadIcon /> {busy ? t('Saving…') : t('Download')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void shoot('png')}>
          <FileImageIcon /> {t('Picture (PNG)')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void shoot('pdf')}>
          <FileTextIcon /> {t('PDF')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
