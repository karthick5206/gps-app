import { FactoryIcon, HistoryIcon, LayoutDashboardIcon, MapPinnedIcon, ReceiptTextIcon, WarehouseIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { storage } from '@/lib/storage';
import { LocationsTab, MovementsTab, ReceiptsTab, SuppliersTab } from './CatalogTabs';
import { DashboardTab } from './DashboardTab';
import { StockTab } from './StockTab';

const TABS = [
  { value: 'dashboard', label: 'Dashboard', icon: LayoutDashboardIcon },
  { value: 'stock', label: 'Stock', icon: WarehouseIcon },
  { value: 'movements', label: 'Movements', icon: HistoryIcon },
  { value: 'receipts', label: 'Receipts', icon: ReceiptTextIcon },
  { value: 'locations', label: 'Locations', icon: MapPinnedIcon },
  { value: 'suppliers', label: 'Suppliers', icon: FactoryIcon },
] as const;
type Tab = (typeof TABS)[number]['value'];
const TAB_KEY = 'veetrax.inventory.tab';

function initialTab(): Tab {
  const fromUrl = new URLSearchParams(window.location.search).get('tab');
  const saved = fromUrl ?? storage.getJson<string>(TAB_KEY, 'stock');
  return (TABS.some((t) => t.value === saved) ? saved : 'stock') as Tab;
}

/** Platform → Stock & Movements (Super Admin): dashboard, stock with actions, ledger, receipts, locations, suppliers. */
export function InventoryPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        setTab(v as Tab);
        storage.setJson(TAB_KEY, v);
      }}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="overflow-x-auto px-4 pt-4 sm:px-6">
        <TabsList>
          {TABS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value}>
              <Icon className="size-4" />
              {t(label)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="dashboard" className="min-h-0 flex-1 overflow-y-auto">
        <DashboardTab />
      </TabsContent>
      <TabsContent value="stock" className="min-h-0 flex-1">
        <StockTab />
      </TabsContent>
      <TabsContent value="movements" className="min-h-0 flex-1">
        <MovementsTab />
      </TabsContent>
      <TabsContent value="receipts" className="min-h-0 flex-1">
        <ReceiptsTab />
      </TabsContent>
      <TabsContent value="locations" className="min-h-0 flex-1">
        <LocationsTab />
      </TabsContent>
      <TabsContent value="suppliers" className="min-h-0 flex-1">
        <SuppliersTab />
      </TabsContent>
    </Tabs>
  );
}
