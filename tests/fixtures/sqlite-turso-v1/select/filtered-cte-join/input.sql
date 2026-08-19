WITH visible AS (SELECT id, name FROM projects WHERE name LIKE :prefix) SELECT p.id, t.title FROM visible AS p JOIN tasks AS t ON t.project_id = p.id ORDER BY p.id;
