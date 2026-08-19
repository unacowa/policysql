SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.metadata, :path) AS j WHERE p.id = :id;
