SELECT visible.id FROM (SELECT id, tenant_id FROM projects) AS visible WHERE visible.tenant_id = 'tenant_2';
