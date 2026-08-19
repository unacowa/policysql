SELECT tenant_id, COUNT(*) AS item_count FROM projects GROUP BY tenant_id HAVING id = 'p1';
