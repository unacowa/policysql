UPDATE projects SET updated_at = :updated_at WHERE id = :id RETURNING id;
