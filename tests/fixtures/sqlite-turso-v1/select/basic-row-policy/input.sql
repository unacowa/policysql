SELECT id, name
FROM projects
WHERE status = :status
LIMIT :limit;
