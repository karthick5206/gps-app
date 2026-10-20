import type { CompanyDto, DeviceDto, DeviceModelDto } from "@veetracer/shared";
import { HardDriveIcon, PackageIcon, TruckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  ASSIGNED_OPTIONS,
  DeviceForm,
  INVENTORY_ENDPOINT,
  deviceColumns,
  deviceRowLabel,
  modelOption,
} from "@/features/masters/device-shared";
import { MasterPage } from "@/features/masters/MasterPage";
import type { MasterFilter, MasterFormProps } from "@/features/masters/types";
import { named, useEntityOptions } from "@/features/masters/use-options";
import { ShipDialog, ShipmentsSheet } from "./Shipments";

const columns = deviceColumns(true);

function InventoryDeviceForm(props: MasterFormProps<DeviceDto>) {
  return <DeviceForm endpoint={INVENTORY_ENDPOINT} withCompany {...props} />;
}

export function DeviceInventoryPage() {
  const { t } = useTranslation();
  const [shipping, setShipping] = useState<DeviceDto | null>(null);
  const [shipments, setShipments] = useState(false);
  const models = useEntityOptions<DeviceModelDto>(
    "/device-models",
    modelOption,
  );
  const companies = useEntityOptions<CompanyDto>("/admin/companies", named);
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: "companyId", label: "Companies", options: companies.options },
      { key: "modelId", label: "Models", options: models.options },
      { key: "assigned", label: "Assignment", options: ASSIGNED_OPTIONS },
    ],
    [companies.options, models.options],
  );
  return (
    <>
      <MasterPage
        menu="sa_device_inventory"
        title="Device Inventory"
        description="Every device on the platform. Assign stock devices to a company."
        endpoint={INVENTORY_ENDPOINT}
        columns={columns}
        rowLabel={deviceRowLabel}
        filters={filters}
        defaultSort={{ id: "uniqueId", desc: false }}
        Form={InventoryDeviceForm}
        emptyIcon={HardDriveIcon}
        headerActions={
          <Button variant="outline" onClick={() => setShipments(true)}>
            <PackageIcon /> {t("Shipments")}
          </Button>
        }
        rowActions={(r) =>
          r.companyId ? null : (
            <DropdownMenuItem onSelect={() => setShipping(r)}>
              <TruckIcon /> {t("Ship to customer")}
            </DropdownMenuItem>
          )
        }
      />
      <ShipDialog
        device={shipping}
        onOpenChange={(o) => !o && setShipping(null)}
      />
      <ShipmentsSheet open={shipments} onOpenChange={setShipments} />
    </>
  );
}
