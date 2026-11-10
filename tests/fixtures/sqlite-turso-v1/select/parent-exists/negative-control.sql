SELECT c.id FROM comments c WHERE EXISTS (SELECT 1 FROM posts p WHERE p.id = c.post_id AND p.tenant_id = 'tenant_2');
