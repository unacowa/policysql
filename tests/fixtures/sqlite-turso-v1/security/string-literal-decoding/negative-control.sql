UPDATE projects SET status = 'archived' WHERE id = 'p1' RETURNING id;
