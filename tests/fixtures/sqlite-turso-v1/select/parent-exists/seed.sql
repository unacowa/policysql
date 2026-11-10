INSERT INTO posts VALUES ('p1','tenant_1'), ('p2','tenant_2'), ('p3','tenant_1');
INSERT INTO comments VALUES ('c1','p1','own'), ('c2','p2','other tenant'), ('c3','p3','own too'), ('c4',NULL,'no parent'), ('c5','missing','orphan');
