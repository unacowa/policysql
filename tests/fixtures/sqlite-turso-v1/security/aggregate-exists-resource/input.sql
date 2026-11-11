SELECT COUNT(*) AS n FROM readers r WHERE EXISTS (SELECT 1 FROM posts p WHERE p.id = r.id);
