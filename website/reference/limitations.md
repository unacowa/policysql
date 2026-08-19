---
title: SQLの対応範囲
description: PolicySQLで利用できるSQLと、public endpointで拒否される操作です。
---

# SQLの対応範囲

PolicySQLはSQLiteの全grammarを無条件に受け付けません。resourceとcolumnの出所を完全に解決し、すべてのaccessへpolicyを適用できる構文だけを実行します。

## 利用できる機能

<table class="spec-table">
  <thead>
    <tr><th>機能</th><th>対応</th><th>条件</th></tr>
  </thead>
  <tbody>
    <tr><td>SELECT</td><td>yes</td><td>明示的なprojection</td></tr>
    <tr><td>table alias</td><td>yes</td><td>一意に解決できるもの</td></tr>
    <tr><td>WHERE</td><td>yes</td><td>許可columnとoperator</td></tr>
    <tr><td>JOIN</td><td>yes</td><td>各resourceにpolicyが必要</td></tr>
    <tr><td>subquery</td><td>yes</td><td>完全なprovenanceを追跡できるもの</td></tr>
    <tr><td>非recursive CTE</td><td>yes</td><td>shadowingと曖昧な参照を拒否</td></tr>
    <tr><td>ORDER BY</td><td>yes</td><td>参照columnにpermissionが必要</td></tr>
    <tr><td>GROUP BY / aggregate</td><td>yes</td><td><code>allow_aggregations: true</code>とcolumn permissionが必要</td></tr>
    <tr><td>window function</td><td>yes</td><td>policyとCapabilitiesで許可</td></tr>
    <tr><td>function / JSON</td><td>yes</td><td>deployment allowlist内</td></tr>
    <tr><td>LIMIT / OFFSET</td><td>yes</td><td>非負integer</td></tr>
    <tr><td>INSERT VALUES</td><td>yes</td><td>明示的なtarget column</td></tr>
    <tr><td>UPDATE</td><td>yes</td><td>許可assignmentとrow filter</td></tr>
    <tr><td>DELETE</td><td>yes</td><td>row filterを適用</td></tr>
    <tr><td>RETURNING</td><td>yes</td><td>独立したcolumn permission</td></tr>
    <tr><td>policy nullable</td><td>yes</td><td>条件付き出力列の直接projectionのみ</td></tr>
    <tr><td>atomic transaction</td><td>yes</td><td>Atomic Executeで一つ以上のstatementを実行</td></tr>
    <tr><td>対話型transaction</td><td>yes</td><td>短い有効期限と直列実行</td></tr>
  </tbody>
</table>

engineやdeploymentごとの差は[Capabilities](./catalog-and-capabilities)に機械可読な形で公開されます。

## Public endpointで拒否する操作

次の操作は完成したPolicySQLでも受け付けません。

- 一つの`sql` fieldに含まれる複数statement
- DDL
- SQLとして送信されるtransaction control
- `PRAGMA`
- `ATTACH` / `DETACH`
- `VACUUM`
- temp object
- triggerの作成・変更
- view・virtual tableの作成
- extension loading
- `sqlite_schema`への直接アクセス
- recursive CTE
- `INSERT ... SELECT`
- user-defined functionまたは非allowlist function
- triggerやside effectに結果を依存するmutation
- resource・column provenanceを完全に解決できないstatement
- 条件付き出力列をprojection以外で参照するstatement
- alias適用後のresult column名が重複するstatement

## Parameter

named parameterを使用します。positional parameterは受け付けません。server-owned namespaceと衝突する名前、未使用parameter、不足parameter、型が不正な値は拒否されます。

## SQLite / Turso互換性

reference SQLiteと対象のTurso/libSQL engineで同じ意味を持つことがconformance testで確認された機能だけをCapabilitiesへ掲載します。対象engineが提供しない機能を別の意味へ読み替えて実行することはありません。

## Resource limit

deploymentはSQL text、parameter数、AST depth、JOIN数、expression complexity、実行時間、row数、result byte数へ上限を設定します。具体値はCapabilitiesから取得できます。
