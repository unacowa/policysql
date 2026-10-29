UPDATE projects SET name = 'it''s' WHERE id <> 'p2' RETURNING id, name, status;
