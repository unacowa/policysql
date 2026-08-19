SELECT id
FROM projects
WHERE tenant_id IN (:active, :pending);
