SELECT p.id, t.title FROM projects p LEFT JOIN tasks t ON t.project_id = p.id ORDER BY p.id;
