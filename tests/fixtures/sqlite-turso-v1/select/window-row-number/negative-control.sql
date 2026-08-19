SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY rowid) AS row_number FROM projects;
