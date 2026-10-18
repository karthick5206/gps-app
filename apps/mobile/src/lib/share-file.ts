import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { requestRaw } from './api';

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return m ? decodeURIComponent(m[1]) : fallback;
}

/**
 * Downloads a file from the API (authorised POST/GET), saves it in the app cache and opens the share sheet
 * (save to Files / Drive, WhatsApp, email…). Returns the file name.
 */
export async function downloadAndShare(path: string, { method = 'GET', body, fallbackName }: { method?: 'GET' | 'POST'; body?: unknown; fallbackName: string }): Promise<string> {
  const res = await requestRaw(path, { method, body });
  const name = filenameFrom(res, fallbackName).replace(/[\\/:*?"<>|]+/g, '_');
  const type = res.headers.get('Content-Type') ?? 'application/octet-stream';
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  await file.write(await res.arrayBuffer());
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: type, dialogTitle: name });
  return name;
}
