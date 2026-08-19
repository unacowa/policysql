SELECT p.id FROM projects p WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id);
