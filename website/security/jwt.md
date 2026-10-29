---
title: JWT認証
description: wrapperによる認証、trusted session、JWT identity adapterの仕様です。
---

# JWT認証

PolicySQLはcredentialを検証しません。deploymentのwrapperが利用者を認証し、その結果をtrusted sessionとしてPolicySQLへ値で渡します（[ADR 0020](https://github.com/unacowa/policysql/blob/main/docs/adr/0020-trusted-session-input-and-jwt-identity-adapter.md)）。参考wrapperとdatabase-routing exampleは、PolicySQLが任意部品として提供するJWT identity adapterでJWTを検証します。このpageはtrusted sessionの契約と、そのadapterのJWT profileを説明します。

参考wrapperでは、clientは認証serviceが発行したtokenを`Authorization` headerへBearer tokenとして指定します。

```http
POST /v1/transactions:execute HTTP/1.1
Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjYtMDEifQ...
Content-Type: application/json
```

JWTがない、検証できない、期限切れのrequestは、wrapperがPolicySQLを呼ぶ前に`401 Unauthorized`（`POLICYSQL_UNAUTHENTICATED`）で拒否します。PolicySQL自身は401を返しません。

## 認証の流れ

1. 認証serviceが利用者を認証し、PolicySQL claimsを含むJWTを発行する
2. clientがJWTを`Authorization: Bearer <JWT>`でdeploymentへ送る
3. wrapperがrate limitの後、JWT identity adapterで署名、algorithm、issuer、audience、有効期間を検証する
4. adapterが標準`sub`と`policysql` claimからtrusted sessionを作る
5. wrapperが`app.fetch(request, env, ctx, { database, session })`でPolicySQLを呼ぶ
6. PolicySQLのcore（Rust）がsessionを検証し、roleを選択し、endpointのaccessを確認する
7. 選択されたroleのpolicyをSQLへ適用する

JWTのpayloadをdecodeしただけでは認証になりません。すべてのclaimは署名と標準claimの検証が成功した後にだけ使用されます。

## Trusted session

wrapperがrequestごとに渡す値です。JWT以外の方式（mTLS、session cookie、上流gateway）で認証するdeploymentも、同じ形を渡します。

```ts
type TrustedSession = {
  principal: string;      // wrapperが名前空間を付けた、曖昧さのない安定した識別子
  subject: string;        // 予約済みsession key `subject_id`になる
  roles: string[];
  defaultRole: string;
  access: ("catalog" | "explain" | "execute" | "debug")[];
  session: Record<string, string>;
};
```

参考adapterは`principal`を`JSON.stringify([iss, sub])`で作ります。issuerは通常`:`を含むため、`iss:sub`のような単純な連結は曖昧です（issuer `https://a.test`とsub `x:y`、issuer `https://a.test:x`とsub `y`が同じ値になる）。独自のwrapperも、区切りを一意に復元できる形で`principal`を作ってください。

`principal`は冪等性keyの識別子と対話型transactionのfingerprintに使われます。別のprincipalは、subject、role、sessionが同じでも、他のprincipalのidempotency keyを再生したり、transactionを継続したりできません。

PolicySQLはbody読み取り、transaction ownerの参照、database接続より前に、次をRustの1か所で検証します。

| 条件 | 結果 |
| --- | --- |
| sessionがない、型違い、未知または欠落したfield、予約key、不正なidentifier、`defaultRole`が`roles`にない、未知または重複したaccess | `500 POLICYSQL_INTERNAL`（wrapperの不具合）。log eventは`trusted_session_rejected`で、session値は含まない |
| `PolicySQL-Role`が`roles`にない、endpointに必要なaccessがない | `403 POLICYSQL_FORBIDDEN_ACCESS` |
| `PolicySQL-Role` headerが複数ある | `400 POLICYSQL_INVALID_REQUEST` |

## JWT payload

adapterのprofileでは、PolicySQL固有の値を`policysql` objectに格納します。

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
| `sub` | 認証された主体の安定したID。`subject`になり、`principal`は`JSON.stringify([iss, sub])` |
| `iat` | tokenの発行時刻 |
| `exp` | tokenの有効期限 |
| `policysql.roles` | 利用者が選択できるroleの配列（`roles`） |
| `policysql.default_role` | role指定がない場合に使うrole（`defaultRole`） |
| `policysql.access` | 呼び出せるAPI種別の配列（`access`） |

`default_role`は`roles`に含まれていなければなりません。roleはcase-sensitiveなlowercase snake_caseで、`^[a-z][a-z0-9_]*$`に一致し、配列内で重複できません。この形式はpolicy fileのrole keyとCatalogの`role`にも共通です。

adapterはclaimを変換するだけです。署名が正しくてもclaimがtrusted sessionの規則に違反するtokenは、認証serviceまたはdeployment設定の不具合として`500`になります。

## API access

`access`はroleとは独立したendpoint permissionです。

| Value | 許可するAPI |
| --- | --- |
| `catalog` | CatalogとCapabilitiesの取得 |
| `explain` | SQLのcompile、parameter/result型推論 |
| `execute` | Atomic Executeと対話型transaction |

通常のapplication tokenは必要なaccessだけを持ちます。未知の値、空配列、重複値はtrusted session検証で拒否します。

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

## Session値

PolicySQLは`subject`を予約済みsession keyの`subject_id`へ変換します。policyでは、利用者IDに相当する値を次のように参照できます。

```yaml
filter:
  author_id:
    eq:
      session: subject_id
```

application固有の値は`session`（JWTでは`policysql.session`）に格納します。

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

session keyにはlowercase snake_caseを使用します。名前はcase-sensitiveで、`^[a-z][a-z0-9_]*$`に一致する必要があります。値はstringです。object、array、`null`は拒否されます。

session stringをSQLite affinityに任せてnumber、boolean、JSON、日時へ暗黙変換しません。session参照は、target columnのwire representationがstringとして互換な場合だけpolicy activation時に許可されます。UUID、RFC 3339、string表現の`int64`は、それぞれのformat parserでも検証されます。

`subject_id`と`role`は予約済みです。`session` objectから上書きできません。clientのSQL parameterとtrusted session parameterも別namespaceで管理されます。

## Roleの選択

通常は`defaultRole`がrequestのroleになります。別のroleを使う場合は、`PolicySQL-Role` headerを指定できます。

```http
PolicySQL-Role: reader
```

指定したroleがsessionの`roles`に含まれていなければ`403`で拒否します。role値はcase-sensitiveです。複数の`PolicySQL-Role` headerは曖昧なため`400`で拒否します。参考wrapperは複数の`Authorization` headerも`401`で拒否します。

clientがheaderで指定できるsession情報はroleだけです。`PolicySQL-Subject-Id`や`PolicySQL-Tenant-Id`などのheaderを送ってもtrusted sessionを追加または上書きできません。

## JWT identity adapter

`@unacowa/policysql/cloudflare`は任意部品として`createJwtSessionVerifier`を提供します。wrapperだけが呼び、PolicySQLのengineは使いません。

```ts
import {
  createErrorResponse, createJwtSessionVerifier, JwtAuthenticationError,
} from "@unacowa/policysql/cloudflare";

const verify = createJwtSessionVerifier({
  jwksUrl: "https://auth.example.com/.well-known/jwks.json", // または jwks: { keys: [...] }
  issuer: "https://auth.example.com/",
  audience: "policysql-api",
});

let session;
try {
  session = await verify(request);
} catch (error) {
  if (error instanceof JwtAuthenticationError) {
    return createErrorResponse(401, error.code, error.message);
  }
  throw error;
}
return app.fetch(request, env, ctx, { database, session });
```

adapterはRS256とES256だけを受け付け、shared secretを使うHMAC algorithmと`none`を拒否します。clock toleranceは5秒です。`jwks`と`jwksUrl`はどちらか一方だけを指定します。設定が不正な場合は構築時に`TypeError`になります。remote JWKSは1.5秒のtimeout、30秒のcooldown、5分のcacheで取得します（鍵をJWKSから外した失効は最大5分遅れます）。

`jwksUrl`は`https:`でなければならず、それ以外のschemeは構築時に`TypeError`です。平文で取得した公開鍵は途中で差し替えられ、任意のtokenが検証を通るためです。JWKS URLは管理者設定からだけ読み込み、JWT claimやrequest parameterから構築しません。redirect先とresponse sizeを制限し、private address、redirect、DNS再解決の許可方針をdeploymentで固定して、JWKS fetchをSSRF経路にしないでください（JWKSの取得と鍵の選択は`jose`の`createRemoteJWKSet`が行います）。

参考wrapper（`deploy/cloudflare/wrapper/`）とdatabase-routing exampleは、`POLICYSQL_JWKS_JSON`または`POLICYSQL_JWKS_URL`、`POLICYSQL_JWT_ISSUER`、`POLICYSQL_JWT_AUDIENCE`を読みます。これらはwrapperの設定で、PolicySQL本体は読みません。設定がない場合、wrapperは`500`を返します。`/healthz`は公開endpointで、identity設定の有無を報告しません。

認証providerが`policysql` objectを発行できない場合は、wrapperが自分でclaimを読み、trusted sessionを組み立てます。複数のclaims objectをmergeしないでください。

## Wrapperの義務

- 対話型transactionのcommandとcommitを含め、すべてのclient requestを認証する。PolicySQLはcredentialを保持しないため、token失効や期限切れでtransactionを止めるのはwrapperの責務
- `principal`を曖昧さのない形（例: 構成要素のJSON配列）で作り、名前空間を付けてidentity providerやtenant間で衝突させない
- `trusted_session_rejected`のlogを伴う`500`は、wrapperまたは認証設定の不具合として扱う

## Security requirements

- JWTのprivate keyをdeploymentへ配置しない。検証にはJWKSのpublic keyだけを使う
- issuerとaudienceを必ず検証する
- token lifetimeを短く保ち、`exp`を必須にする
- clock skewは必要最小限にする
- JWTとdecoded claimsをapplication logへ出力しない
- public APIにadmin secretやpolicy bypass headerを設けない
- build tokenに`execute` accessを付与しない
