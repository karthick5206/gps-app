import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StockDocDto, StockDocKind, StockItemDto, StockStoreDto, StockSupplierDto } from '@veetracer/shared';
import { useMe } from '@/features/auth/auth-context';
import { api } from '@/lib/api';

/** Stock screens: shared queries, money formatting and the "who am I" (platform or reseller) switch. */

export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const toPaise = (rupeesText: string) => {
  const n = Number(String(rupeesText).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const toRupeesText = (paise: number) => (paise ? String(paise / 100) : '');
export const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** The platform (Super Admin) manages everything; a reseller only its own store and documents. */
export function useStockSide(): { platform: boolean; reseller: { id: string; name: string } | null } {
  const me = useMe();
  return { platform: me.user.isSuperAdmin, reseller: me.partner ?? null };
}

export const useStockItems = () => useQuery({ queryKey: ['stock', 'items'], queryFn: ({ signal }) => api.get<StockItemDto[]>('/stock/items', undefined, signal), staleTime: 30_000 });
export const useSuppliers = (enabled = true) => useQuery({ queryKey: ['stock', 'suppliers'], queryFn: ({ signal }) => api.get<StockSupplierDto[]>('/stock/suppliers', undefined, signal), staleTime: 30_000, enabled });
export const useStockLocations = () => useQuery({ queryKey: ['stock', 'locations'], queryFn: ({ signal }) => api.get<StockStoreDto[]>('/stock/locations', undefined, signal), staleTime: 60_000 });
export const usePartners = (enabled: boolean) =>
  useQuery({ queryKey: ['stock', 'partners'], queryFn: ({ signal }) => api.get<{ id: string; name: string }[]>('/licences/admin/partners', undefined, signal), staleTime: 60_000, enabled });
export const useStockDocs = (params: { kinds: StockDocKind[]; search?: string; inbox?: boolean }) =>
  useQuery({
    queryKey: ['stock', 'docs', params],
    queryFn: async ({ signal }) => {
      if (params.inbox) return api.get<StockDocDto[]>('/stock/docs', { inbox: 'true', search: params.search || undefined }, signal);
      const lists = await Promise.all(params.kinds.map((kind) => api.get<StockDocDto[]>('/stock/docs', { kind, search: params.search || undefined }, signal)));
      return lists.flat().sort((a, b) => b.docDate.localeCompare(a.docDate) || b.createdAt.localeCompare(a.createdAt));
    },
  });

/** After any change: every stock list, the dashboard and stock on hand refresh. */
export function useStockRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['stock'] });
}

/** Status badge tone. */
export const STATUS_TONE: Record<string, 'muted' | 'warning' | 'success' | 'destructive' | 'default'> = { DRAFT: 'muted', OPEN: 'default', PARTIAL: 'warning', DONE: 'success', CANCELLED: 'destructive' };
export const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', OPEN: 'Open', PARTIAL: 'Part done', DONE: 'Done', CANCELLED: 'Cancelled' };
