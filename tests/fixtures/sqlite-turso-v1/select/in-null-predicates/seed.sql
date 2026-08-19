INSERT INTO projects (id, tenant_id, name, status) VALUES
  ('project_1', 'tenant_1', 'Visible', 'active'),
  ('project_2', 'tenant_2', 'Hidden tenant', 'active'),
  ('project_3', 'tenant_1', NULL, 'active'),
  ('project_4', 'tenant_1', 'Pending', 'pending'),
  ('project_5', 'tenant_1', 'Archived', 'archived');
