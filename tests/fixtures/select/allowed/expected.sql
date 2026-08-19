SELECT id, name
FROM projects
WHERE (status = :status)
  AND (tenant_id = :__policysql_session_tenant_id)
LIMIT 100;
