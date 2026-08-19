INSERT INTO projects (id, tenant_id, name) VALUES (:id, 'tenant_2', :name) RETURNING id;
