-- Brand spelling Veetrax → VeeTrax for stored names and the built-in (company-less) message templates.
UPDATE "Partner" SET "name" = 'VeeTrax' WHERE "slug" = 'veetracer' AND "name" = 'Veetrax';
UPDATE "Company" SET "name" = 'VeeTrax Platform' WHERE "isPlatform" = true AND "name" = 'Veetrax Platform';
UPDATE "MessageTemplate"
SET "name" = replace("name", 'Veetrax', 'VeeTrax'),
    "subject" = replace("subject", 'Veetrax', 'VeeTrax'),
    "body" = replace("body", 'Veetrax', 'VeeTrax')
WHERE "companyId" IS NULL
  AND ("name" LIKE '%Veetrax%' OR "subject" LIKE '%Veetrax%' OR "body" LIKE '%Veetrax%');
