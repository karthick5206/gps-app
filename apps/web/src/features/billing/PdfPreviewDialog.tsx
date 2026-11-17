import { useQuery } from '@tanstack/react-query';
import { DownloadIcon } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadFile, errorMessage, fetchBlob } from '@/lib/api';

/** Shows a PDF (fetched with the session) on screen, with a Download button. */
export function PdfPreviewDialog({ path, title, description, fileName, onClose }: { path: string; title: string; description?: string; fileName: string; onClose: () => void }) {
  const { t } = useTranslation();
  const pdf = useQuery({ queryKey: ['pdf-preview', path], queryFn: () => fetchBlob(path), staleTime: 60_000, retry: false });
  const url = useMemo(() => (pdf.data ? URL.createObjectURL(pdf.data) : null), [pdf.data]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogBody>
          {pdf.isError && <FormError message={errorMessage(pdf.error)} />}
          {url ? <iframe title={title} src={url} className="h-[70vh] w-full rounded-md border" /> : !pdf.isError && <Skeleton className="h-[70vh] w-full" />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Close')}
          </Button>
          <Button onClick={() => downloadFile(path, fileName).catch((e) => toast.error(errorMessage(e)))}>
            <DownloadIcon />
            {t('Download PDF')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
