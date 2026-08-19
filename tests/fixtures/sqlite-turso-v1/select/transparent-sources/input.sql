SELECT visible.id, visible.name FROM (SELECT id, name FROM projects) AS visible ORDER BY visible.id;
