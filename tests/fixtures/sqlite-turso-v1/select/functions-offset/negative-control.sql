SELECT LOWER(private_note) AS leaked FROM projects WHERE name GLOB :pattern LIMIT :limit OFFSET :offset;
