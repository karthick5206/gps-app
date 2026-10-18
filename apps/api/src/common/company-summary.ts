import { Company } from '@prisma/client';
import { CompanySummary } from '@veetracer/shared';
import { companyThresholds } from '../tracking/thresholds';

export function toCompanySummary(company: Company): CompanySummary {
  return {
    id: company.id,
    name: company.name,
    accountType: company.accountType,
    status: company.status,
    timezone: company.timezone,
    thresholds: companyThresholds(company.settings),
  };
}
