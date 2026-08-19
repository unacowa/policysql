DELETE FROM "projects" WHERE (("id" = :id) AND ("tenant_id" = :__policysql_session_tenant_id)) RETURNING "id" AS "id"
