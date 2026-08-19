-- Incorrect and forbidden transformation: moving the tasks policy to WHERE collapses LEFT JOIN semantics.
SELECT p.id, t.title FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
WHERE p.tenant_id = :__policysql_session_tenant_id AND t.tenant_id = :__policysql_session_tenant_id;
