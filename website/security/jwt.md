---
title: JWT認証
description: PolicySQLのJWT claim、role、trusted sessionの仕様です。
---

# JWT認証

PolicySQLのpublic APIはJWT access tokenによる認証を前提とします。認証serviceが発行したtokenを、`Authorization` headerへBearer tokenとして指定します。

```http
POST /v1/transactions:execute HTTP/1.1
Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjYtMDEifQ...
Content-Type: application/json
```

JWTがない、検証できない、期限切れ、必要なclaimがないrequestは、SQLをparseする前に`401 Unauthorized`で拒否されます。

## 認証の流れ

1. 認証serviceが利用者を認証する
2. 認証serviceがPolicySQL claimsを含むJWTを発行する
3. clientがJWTを`Authorization: Bearer <JWT>`でPolicySQLへ送る
4. PolicySQLが署名、algorithm、issuer、audience、有効期間を検証する
5. 標準`sub`と`policysql` claimからtrusted sessionを構築する
6. 選択されたroleのpolicyをSQLへ適用する

JWTのpayloadをdecodeしただけでは認証になりません。すべてのclaimは署名と標準claimの検証が成功した後にだけ使用されます。

## JWT payload

標準構成では、PolicySQL固有の値を`policysql` objectに格納します。

```json
{
  "sub": "author_01",
  "iss": "https://auth.example.com/",
  "aud": "policysql-api",
  "iat": 1785686400,
  "exp": 1785690000,
  "policysql": {
    "roles": ["author", "reader"],
    "default_role": "author",
    "access": ["catalog", "explain", "execute"],
    "session": {
      "organization_id": "org_01"
    }
  }
}
```

### 必須claim

| Claim | 意味 |
| --- | --- |
| `iss` | JWTを発行した認証service |
| `aud` | tokenの利用先。PolicySQL用audienceを含む必要がある |
| `sub` | 認証された主体の安定したID |
| `iat` | tokenの発行時刻 |
| `exp` | tokenの有効期限 |
| `policysql.roles` | 利用者が選択できるroleの配列 |
| `policysql.default_role` | role指定がない場合に使うrole |
| `policysql.access` | 呼び出せるAPI種別の配列 |

`default_role`は`roles`に含まれていなければなりません。roleはcase-sensitiveなlowercase snake_caseで、`^[a-z][a-z0-9_]*$`に一致し、配列内で重複できません。この形式はpolicy fileのrole keyとCatalogの`role`にも共通です。

## API access

`policysql.access`はroleとは独立したendpoint permissionです。

| Value | 許可するAPI |
| --- | --- |
| `catalog` | CatalogとCapabilitiesの取得 |
| `explain` | SQLのcompile、parameter/result型推論 |
| `execute` | Atomic Executeと対話型transaction |

通常のapplication tokenは必要なaccessだけを持ちます。未知の値、空配列、重複値はJWT検証時に拒否します。

型生成用tokenはdata executionを許可しません。

```json
{
  "sub": "build_ci",
  "iss": "https://auth.example.com/",
  "aud": "policysql-api",
  "iat": 1785686400,
  "exp": 1785690000,
  "policysql": {
    "roles": ["author"],
    "default_role": "author",
    "access": ["catalog", "explain"]
  }
}
```

このtokenで`POST /v1/transactions:execute`または対話型transactionを呼ぶと`403`です。`explain`はSQLを実行せず、選択roleで公開可能なcompile contractだけを返します。

## Trusted session

PolicySQLは標準`sub`を予約済みsession keyの`subject_id`へ変換します。policyでは、利用者IDに相当する値を次のように参照できます。

```yaml
filter:
  author_id:
    eq:
      session: subject_id
```

application固有の値は`policysql.session` objectに格納します。

```json
{
  "policysql": {
    "roles": ["member"],
    "default_role": "member",
    "access": ["catalog", "explain", "execute"],
    "session": {
      "tenant_id": "tenant_01",
      "organization_id": "org_01"
    }
  }
}
```

session keyにはlowercase snake_caseを使用します。名前はcase-sensitiveで、`^[a-z][a-z0-9_]*$`に一致する必要があります。値はstringです。object、array、`null`、同じ名前の重複は拒否されます。

session stringをSQLite affinityに任せてnumber、boolean、JSON、日時へ暗黙変換しません。session参照は、target columnのwire representationがstringとして互換な場合だけpolicy activation時に許可されます。UUID、RFC 3339、string表現の`int64`は、それぞれのformat parserでも検証されます。

`subject_id`と`role`は予約済みです。`session` objectから上書きできません。clientのSQL parameterとtrusted session parameterも別namespaceで管理されます。

## Roleの選択

通常は`default_role`がrequestのroleになります。同じJWTで別のroleを使う場合は、`PolicySQL-Role` headerを指定できます。

```http
PolicySQL-Role: reader
```

指定したroleがJWTの`roles`に含まれていなければrequestを拒否します。role値はcase-sensitiveです。

`Authorization`または`PolicySQL-Role`が複数行、結合値、空値として届いたrequestは曖昧なため拒否します。

clientがheaderで指定できるsession情報はroleだけです。`PolicySQL-Subject-Id`や`PolicySQL-Tenant-Id`などのheaderを送ってもtrusted sessionを追加または上書きできません。

## JWT verifier設定

公開鍵をJWKS endpointから取得します。PolicySQLのpublic APIはasymmetric algorithmを使用し、shared secretを使うHMAC algorithmは受け付けません。

```yaml
auth:
  jwt:
    jwks_url: https://auth.example.com/.well-known/jwks.json
    issuer: https://auth.example.com/
    audience: policysql-api
    allowed_algorithms: [RS256]
    claims_pointer: /policysql
    allowed_skew_seconds: 30
```

`claims_pointer`はRFC 6901 JSON Pointerです。標準値は`/policysql`です。認証serviceがURI形式などの別namespaceを使う場合は、claimの正確な位置を指定できます。複数のclaims objectをmergeすることはありません。

PolicySQLはtokenの`alg`だけを信用せず、`allowed_algorithms`に設定されたalgorithmと一致する鍵だけを使用します。`none`、HMAC algorithm、設定外algorithm、用途の異なる鍵は拒否されます。

`kid`に対応するJWKがない場合は、JWKSを安全にrefreshして一度だけ再検証します。refreshに失敗し、有効なcached keyもない場合はfail closedです。JWKS URLはHTTPSを使用し、redirect先とresponse sizeを制限します。URLは管理者設定からだけ読み込み、JWT claimやrequest parameterから構築しません。private address、redirect、DNS再解決の許可方針をdeploymentで固定し、JWKS fetchをSSRF経路にしません。

## Claims mapping

認証providerがPolicySQL用objectを発行できない場合は、既存claimを明示的にmappingできます。

```yaml
auth:
  jwt:
    jwks_url: https://auth.example.com/.well-known/jwks.json
    issuer: https://auth.example.com/
    audience: policysql-api
    allowed_algorithms: [RS256]
    claims_map:
      roles:
        pointer: /roles
      default_role:
        pointer: /default_role
      access:
        pointer: /access
      session:
        tenant_id:
          pointer: /tenant_id
```

mappingの位置指定にもRFC 6901 JSON Pointerを使います。`sub`は常に標準claimから`subject_id`へ変換されるため、mapping対象にしません。

`claims_map`と`claims_pointer`は同時に設定できません。pathが存在しない、型が違う、必須claimを構築できない、複数pathが同じsession keyを生成する場合はrequestを拒否します。

## Security requirements

- JWTのprivate keyをPolicySQLへ配置しない。検証にはJWKSのpublic keyだけを使う
- issuerとaudienceを必ず検証する
- token lifetimeを短く保ち、`exp`を必須にする
- clock skewは必要最小限にする
- JWTとdecoded claimsをapplication logへ出力しない
- public APIにadmin secretやpolicy bypass headerを設けない
- build tokenに`execute` accessを付与しない
- 同じheaderやclaimが重複して曖昧になるrequestを拒否する
- transaction中はsubject、role、session、policy snapshotを変更しない

対話型transactionの後続requestも毎回JWTを検証します。issuer、subject、role、session、policy/schema snapshotのfingerprintが開始時と一致しないrequest、期限切れtokenによるoperationやcommitは拒否されます。

## 設計上の参考

role、session variable、row policyを組み合わせる考え方はHasura v2を参考にしています。ただし、PolicySQLのJWT claim名、namespace、role headerは独自contractであり、Hasura互換ではありません。

- [Hasura: Authentication Using JWTs](https://hasura.io/docs/2.0/auth/authentication/jwt/)
- [Hasura: Roles & Session Variables](https://hasura.io/docs/2.0/auth/authorization/roles-variables/)
