SELECT p.id FROM projects p WHERE EXISTS (SELECT q.id FROM projects q WHERE q.id = p.id);
