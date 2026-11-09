import { Company } from '@prisma/client';
import { CompanySummary } from '@veetracer/shared';
import { companyThresholds } from '../tracking/thresholds';
import { companyFeatures } from './company-features';

export function toCompanySummary(company: Company): CompanySummary {
  return {
    id: company.id,
    name: company.name,
    accountType: company.accountType,
    status: company.status,
    timezone: company.timezone,
    thresholds: companyThresholds(company.settings),
    features: companyFeatures(company),
  };
}
