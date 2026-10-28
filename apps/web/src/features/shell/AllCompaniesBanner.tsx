import { LayersIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAllCompaniesView } from "@/features/platform/all-companies";

/** Super Admin viewing all companies: what that view covers, and that changes need a company. */
export function AllCompaniesBanner() {
  const { t } = useTranslation();
  if (!useAllCompaniesView()) return null;
  return (
    <div
      className="flex items-center gap-2 border-b bg-primary/8 px-4 py-1.5 text-xs text-foreground"
      role="status"
    >
      <LayersIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span>
        {t(
          "All companies: the live map and the Vehicles, Devices and Drivers lists show every company. Other pages show your own company. To add or edit, choose a company.",
        )}
      </span>
    </div>
  );
}
