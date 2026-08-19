import { connect } from "@tursodatabase/database";

const database = await connect(":memory:");

try {
  await database.exec(`
    CREATE TABLE authors (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      author_id TEXT,
      title TEXT NOT NULL
    );
    INSERT INTO authors VALUES
      ('a-visible', 'tenant-1', 'Visible Author'),
      ('a-hidden', 'tenant-2', 'Hidden Author');
    INSERT INTO posts VALUES
      ('p-visible', 'tenant-1', 'a-visible', 'Visible author'),
      ('p-hidden-author', 'tenant-1', 'a-hidden', 'Hidden author'),
      ('p-missing-author', 'tenant-1', NULL, 'Missing author'),
      ('p-other-tenant', 'tenant-2', 'a-hidden', 'Other tenant');
  `);

  const args = { tenant: "tenant-1" };
  const correctSql = `
    SELECT p.id, a.name
    FROM posts AS p
    LEFT JOIN authors AS a
      ON a.id = p.author_id
     AND a.tenant_id = :tenant
    WHERE p.tenant_id = :tenant
    ORDER BY p.id
  `;
  const incorrectSql = `
    SELECT p.id, a.name
    FROM posts AS p
    LEFT JOIN authors AS a ON a.id = p.author_id
    WHERE p.tenant_id = :tenant
      AND a.tenant_id = :tenant
    ORDER BY p.id
  `;

  const correct = await database.all(correctSql, args);
  const incorrect = await database.all(incorrectSql, args);
  const rows = (result) => result.map((row) => [row.id, row.name ?? null]);
  const report = {
    correctPlacement: {
      protectedSidePolicyLocation: "ON",
      rows: rows(correct),
    },
    incorrectPlacement: {
      protectedSidePolicyLocation: "WHERE",
      rows: rows(incorrect),
    },
  };

  const expected = [
    ["p-hidden-author", null],
    ["p-missing-author", null],
    ["p-visible", "Visible Author"],
  ];
  if (JSON.stringify(report.correctPlacement.rows) !== JSON.stringify(expected)) {
    throw new Error("LEFT JOIN ON-policy placement did not preserve left rows");
  }
  if (report.incorrectPlacement.rows.length !== 1) {
    throw new Error("negative control no longer demonstrates outer-join collapse");
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await database.close();
}
