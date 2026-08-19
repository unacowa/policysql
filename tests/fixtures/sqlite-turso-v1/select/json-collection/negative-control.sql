SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.metadata, '$') AS j WHERE p.tenant_id = 'tenant_2';
