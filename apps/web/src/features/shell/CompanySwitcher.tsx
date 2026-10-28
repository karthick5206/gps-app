import { useQuery } from "@tanstack/react-query";
import {
  ALL_COMPANIES,
  type CompanyDto,
  type Paginated,
} from "@veetracer/shared";
import {
  Building2Icon,
  CheckIcon,
  ChevronsUpDownIcon,
  LayersIcon,
  SearchIcon,
} from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useAuth, useMe } from "@/features/auth/auth-context";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Super Admin only: choose the company to act in (sent as X-Company-Id and Socket.IO companyId). */
export function CompanySwitcher() {
  const { t } = useTranslation();
  const me = useMe();
  const { companyId, switchCompany } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);

  const companies = useQuery({
    queryKey: ["company-switcher", query],
    queryFn: ({ signal }) =>
      api.get<Paginated<CompanyDto>>(
        "/admin/companies",
        { q: query, pageSize: 50, sort: "name", order: "asc" },
        signal,
      ),
    enabled: open,
  });

  const choose = (id: string | null) => {
    switchCompany(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("Switch company")}
          className="flex h-9 max-w-[16rem] min-w-0 items-center gap-2 rounded-lg border bg-card px-2.5 text-sm shadow-xs transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          {companyId === ALL_COMPANIES ? (
            <LayersIcon className="size-4 shrink-0 text-primary" />
          ) : (
            <Building2Icon className="size-4 shrink-0 text-primary" />
          )}
          <span className="truncate font-medium">
            {companyId === ALL_COMPANIES ? t("All companies") : me.company.name}
          </span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("Search companies…")}
            aria-label={t("Search companies")}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {companies.isFetching && (
            <Spinner className="text-muted-foreground" />
          )}
        </div>
        <ul
          className="max-h-72 overflow-y-auto p-1"
          role="listbox"
          aria-label={t("Companies")}
        >
          <CompanyOption
            label={t("All companies")}
            hint={t("Live map, vehicles, devices and drivers of every company")}
            selected={companyId === ALL_COMPANIES}
            onSelect={() => choose(ALL_COMPANIES)}
          />
          <CompanyOption
            label={t("Platform (no company)")}
            hint={t("Super Admin home")}
            selected={!companyId}
            onSelect={() => choose(null)}
          />
          {companies.data?.items.map((c) => (
            <CompanyOption
              key={c.id}
              label={c.name}
              hint={
                c.status === "SUSPENDED"
                  ? t("{{count}} objects · suspended", { count: c.objectCount })
                  : t("{{count}} objects", { count: c.objectCount })
              }
              selected={companyId === c.id}
              onSelect={() => choose(c.id)}
            />
          ))}
          {companies.isSuccess && companies.data.items.length === 0 && (
            <li className="px-2 py-4 text-center text-sm text-muted-foreground">
              {t("No companies found")}
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function CompanyOption({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
          selected && "font-medium",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {hint}
          </span>
        </span>
        {selected && <CheckIcon className="size-4 text-primary" />}
      </button>
    </li>
  );
}
