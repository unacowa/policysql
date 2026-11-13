UPDATE projects SET name = secret_level WHERE id = :id RETURNING id;
