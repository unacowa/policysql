SELECT CASE WHEN name = :chosen THEN CAST(name AS TEXT) ELSE name || :suffix END AS label FROM projects ORDER BY name LIMIT 2;
