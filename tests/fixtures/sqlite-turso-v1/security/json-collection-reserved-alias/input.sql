SELECT json_group_array(j.value) AS __policysql_check FROM projects AS p, json_each(p.metadata, '$') AS j;
