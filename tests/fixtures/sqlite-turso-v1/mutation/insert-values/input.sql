INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name;
