---
title: データ正常性
description: 型、フォーマット、制約、mutation check、commit checkによるデータ保証の全体像です。
---

# データ正常性

PolicySQLのデータ正常性機能は、clientから受け取る値、databaseへ保存されるrow、transaction完了後の複数resourceが、applicationの定義した規則を満たすことを保証します。

認証・認可は「誰がどのデータを操作できるか」を決めます。データ正常性は「許可された操作の結果が、どのような値と状態でなければならないか」を決めます。この二つは独立して検証され、認可の成功によって正常性検証が省略されることはありません。

ここでいう正常性は、値の型、形式、値域、row条件、resource間の不変条件を指します。backup、replication、durability、障害復旧は含みません。

## 保証する層

| 層 | 主な機能 | 例 |
| --- | --- | --- |
| 値 | logical type、representation、format、constraints | RFC 3339の時刻、日付、UUID、文字数、数値範囲 |
| row | database constraint、preset、operation check | tenant IDの固定、状態遷移後のrow条件 |
| transaction | Transaction API、commit check | 注文合計と明細合計、在庫と予約数 |
| client contract | Catalog、result metadata、generated type | TypeScript型、decoder、policy nullable |

単一の機能ですべての不変条件を表現しません。最も狭く、databaseに近い層で保証できる規則を優先します。

## 処理順序

```text
認証とrole選択
  -> SQL parseとcatalog bind
  -> client値のtype・format・constraint検証
  -> column permissionとrow filter
  -> preset適用
  -> preset後の値を再検証
  -> database mutationとdatabase constraint
  -> operation check
  -> transaction内の全statement終了
  -> commit checks
  -> commit
  -> resultのtype・format検証
  -> response
```

途中の検証が失敗した場合、変更を成功として返しません。mutation開始後の失敗は同じtransactionをrollbackします。SELECTでも、Catalogが約束する型やformatに適合しない値をdriverへ返さず、schema mismatchとして失敗させます。

## 機能の選択

| 条件 | 使用する機能 |
| --- | --- |
| SQLiteで厳密に保証できる | `NOT NULL`、`UNIQUE`、`FOREIGN KEY`、`CHECK` |
| 一つの値の意味や形式 | [型・フォーマット・制約](./types-and-formats) |
| clientに決めさせない値 | [Preset](../sql/write-integrity#preset) |
| 変更後の一つのrowで判定できる | [Operation check](../sql/write-integrity#operation-check) |
| 複数resourceまたはapplication codeが必要 | [Commit check](../sql/commit-checks) |

database自身が保証できる不変条件はdatabase constraintにも定義します。PolicySQLを経由しないmigration、運用tool、障害対応時の書き込みにはPolicySQL policyが適用されないためです。

## Catalogの役割

SQLiteは値を`NULL`、`INTEGER`、`REAL`、`TEXT`、`BLOB`として保存しますが、`TEXT`が通常文字列、日時、UUID、JSONのどれであるかは判断できません。PolicySQLは、database schemaのintrospection結果と、管理者がversion管理するCatalog manifestを統合してlogical catalogを生成します。

```text
SQLite schema introspection
          +
Catalog manifest
          +
type・format・function registry
          ↓
compiled logical catalog
          ↓
policy validation / SQL type inference / client code generation
```

compiled catalogはimmutableな`schemaVersion`を持ちます。物理schemaだけでなく、logical type、format、constraint、resource mappingが変わった場合もversionが変わります。

## 次に読む

- 値と式の型付けは[型・フォーマット・制約](./types-and-formats)
- mutationのpresetとcheckは[書き込みの整合性](../sql/write-integrity)
- transaction全体の外部検証は[Commit check](../sql/commit-checks)
- driverでの型変換は[Client開発ガイド](../clients/driver-development)
