DELETE FROM projects WHERE secret = :guess RETURNING id, secret;
