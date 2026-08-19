SELECT id, name
FROM projects
WHERE status IN (:active, :pending)
  AND name IS NOT NULL
  AND status NOT IN (:archived);
