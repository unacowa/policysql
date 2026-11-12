UPDATE projects SET name = :name WHERE id = :id RETURNING id, name, updated_at, updated_ms;
