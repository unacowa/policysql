SELECT p.id FROM posts p JOIN readers r ON r.id = 'r1' AND EXISTS (SELECT 1 FROM comments c WHERE c.body = 'y') WHERE EXISTS (SELECT 1 FROM comments c WHERE c.id = 'c1');
