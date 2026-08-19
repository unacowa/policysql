---
title: 用語集
description: PolicySQLドキュメントで使用する用語の定義です。
---

# 用語集

## Base table

view、CTE、subqueryではない、catalogで解決されたtableです。

## Bound statement

table、alias、column、parameterの参照先がcatalogに対して解決された内部表現です。構文をparseしただけのstatementとは区別されます。

## Catalog

利用可能なlogical resource、column、型などを定義するschema情報です。raw database schemaと同一である必要はありません。

## Constraint

logical typeとformatに加えて、値の範囲、長さ、列挙値、patternなどを制限する規則です。複数rowやresourceにまたがる不変条件とは区別されます。

## Data validity

値の型・format・constraint、rowのoperation check、transactionのcommit checkを通じて、データがapplicationの規則を満たすことです。backupやdurabilityは含みません。

## Client parameter

利用者がSQLと一緒に送信するparameterです。server-owned parameterとは別の名前空間で管理されます。

## Default deny

明示的に対応・許可されていない操作を拒否する原則です。

## Effective limit

clientのLIMIT、policy limit、deployment limitを考慮した実際の取得上限です。

## Explain

SQLをdatabaseへ送らず、parse、bind、policy適用、parameter型、result型、検証結果を確認する機能です。

## API access

JWTの`policysql.access`に含まれる`catalog`、`explain`、`execute`です。roleによるデータpermissionとは独立して、呼び出せるendpoint種別を制限します。

## Logical resource

policyが対象とする論理的なデータ集合です。通常はcatalogに登録されたbase tableへ対応します。

## Logical type

SQLite storage classとは別に、値の意味と許可される演算を表す型です。`string`、`date`、`datetime`、`instant`などがあります。

## Policy

resource、role、operationごとに、許可column、row filter、limitなどを定義するruleです。

## Protected statement

client SQLへpolicyの制約を適用した内部statementです。databaseへ送信する前に再検証されます。

## Representation

logical valueをHTTP APIで送受信するときのJSON上の基本表現です。`string`、`number`、`boolean`、`object`、`array`などがあります。

## Format

representationをlogical valueへencode・decodeする規則です。`rfc3339`、`iso-date`、`sqlite-datetime`、`uuid`など、安定したidentifierで表します。

## Role

JWTの`policysql.default_role`、または`policysql.roles`内の`PolicySQL-Role`から選択され、適用policyの決定に使われる権限区分です。

## Row filter

resourceから対象rowを制限するpolicy条件です。clientのWHERE条件とは別に常に適用されます。

## Server-owned parameter

sessionやpolicyからPolicySQLが生成するparameterです。clientは名前も値も指定できません。

## Session

検証済みJWTからgatewayが構築するrequest contextです。選択されたrole、標準`sub`由来の`subject_id`、`policysql.session`の値を含みます。

## JWT

認証serviceが署名して発行するaccess tokenです。PolicySQLは署名、issuer、audience、有効期間を検証してからclaimsを使用します。
