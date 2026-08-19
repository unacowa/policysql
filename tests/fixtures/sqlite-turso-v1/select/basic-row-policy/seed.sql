INSERT INTO projects (id, tenant_id, name, status, created_by) VALUES
  ('project_1', 'tenant_1', 'Visible', 'active', 'user_1'),
  ('project_2', 'tenant_2', 'Hidden tenant', 'active', 'user_2'),
  ('project_3', 'tenant_1', 'Wrong status', 'archived', 'user_1');
