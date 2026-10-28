import { useQuery } from "@tanstack/react-query";
import {
  ALL_COMPANIES,
  type CompanyDto,
  type Paginated,
} from "@veetracer/shared";
import { useMemo } from "react";
import { useAuth } from "@/features/auth/auth-context";
import type { MasterColumn } from "@/features/masters/types";
import { api } from "@/lib/api";

/** Super Admin viewing all companies (company switcher → All companies). */
export function useAllCompaniesView(): boolean {
  return useAuth().companyId === ALL_COMPANIES;
}

/** Company id → name, for the company column while viewing all companies. */
export function useCompanyNames(enabled: boolean): Map<string, string> {
  const q = useQuery({
    queryKey: ["company-names"],
    queryFn: ({ signal }) =>
      api.get<Paginated<CompanyDto>>(
        "/admin/companies",
        { pageSize: 200, sort: "name", order: "asc" },
        signal,
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
  return useMemo(
    () => new Map((q.data?.items ?? []).map((c) => [c.id, c.name])),
    [q.data],
  );
}

/** Adds a leading Company column to a list while the Super Admin views all companies. */
export function useWithCompanyColumn<T extends { companyId: string | null }>(
  columns: MasterColumn<T>[],
): MasterColumn<T>[] {
  const all = useAllCompaniesView();
  const names = useCompanyNames(all);
  return useMemo(
    () =>
      all
        ? [
            {
              id: "company",
              header: "Company",
              cell: (r: T) =>
                r.companyId ? (names.get(r.companyId) ?? "…") : "—",
              sortable: false,
              hideable: false,
            },
            ...columns,
          ]
        : columns,
    [all, names, columns],
  );
}
