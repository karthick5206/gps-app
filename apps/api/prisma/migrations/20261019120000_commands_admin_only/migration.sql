-- Device commands (engine stop / restore, restart…) are for Admin roles only: remove the "command" action
-- from the built-in non-Admin roles. Custom roles keep whatever their company configured.
UPDATE "RolePermission" rp
SET "actions" = array_remove(rp."actions", 'command')
FROM "Role" r
WHERE rp."roleId" = r."id"
  AND r."isSystem" = true
  AND r."name" <> 'Admin'
  AND rp."menu" = 'live_map'
  AND 'command' = ANY (rp."actions");
