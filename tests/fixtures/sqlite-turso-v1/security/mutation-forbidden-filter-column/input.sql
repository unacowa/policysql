UPDATE projects SET name = :name WHERE secret = :guess RETURNING id;
