SELECT p.id, ROW_NUMBER() OVER (ORDER BY p.id) AS position FROM posts p JOIN readers r ON r.id = 'r1';
