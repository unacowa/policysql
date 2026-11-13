SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.metadata, CASE WHEN p.secret = 'x' THEN '$' ELSE '$.label' END) AS j WHERE p.id = 'project_1';
