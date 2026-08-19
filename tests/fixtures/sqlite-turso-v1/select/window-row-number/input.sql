SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY id) AS row_number FROM projects ORDER BY id;
