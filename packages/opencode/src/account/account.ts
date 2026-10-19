import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cache, Clock, Duration, Effect, Layer, Option, Schema, SchemaGetter, Context } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

import { withTransientReadRetry } from "@/util/effect-http-client"
import { AccountRepo, type AccountRow } from "./repo"
import { normalizeServerUrl } from "./url"
import { apiPath, Models, provider } from "@opencode-ai/core/plugin/provider/vega"
import {
  type AccountError,
  AccessToken,
  AccountID,
  DeviceCode,
  Info,
  RefreshToken,
  AccountServiceError,
  AccountTransportError,
  Login,
  Org,
  OrgID,
  PollDenied,
  PollError,
  PollExpired,
  PollPending,
  type PollResult,
  PollSlow,
  PollSuccess,
  UserCode,
} from "./schema"

export {
  AccountID,
  type AccountError,
  AccountRepoError,
  AccountServiceError,
  AccountTransportError,
  AccessToken,
  RefreshToken,
  DeviceCode,
  UserCode,
  Info,
  Org,
  OrgID,
  Login,
  PollSuccess,
  PollPending,
  PollSlow,
  PollExpired,
  PollDenied,
  PollError,
  PollResult,
} from "./schema"

export type AccountOrgs = {
  account: Info
  orgs: readonly Org[]
}

export type ActiveOrg = {
  account: Info
  org: Org
}

const DurationFromSeconds = Schema.Number.pipe(
  Schema.decodeTo(Schema.Duration, {
    decode: SchemaGetter.transform((n) => Duration.seconds(n)),
    encode: SchemaGetter.transform((d) => Duration.toSeconds(d)),
  }),
)

class TokenRefresh extends Schema.Class<TokenRefresh>("TokenRefresh")({
  access_token: AccessToken,
  refresh_token: Schema.optional(RefreshToken),
  expires_in: Schema.optional(DurationFromSeconds),
}) {}

class DeviceAuth extends Schema.Class<DeviceAuth>("DeviceAuth")({
  device_code: DeviceCode,
  user_code: UserCode,
  verification_uri_complete: Schema.String,
  expires_in: DurationFromSeconds,
  interval: DurationFromSeconds,
}) {}

class DeviceTokenSuccess extends Schema.Class<DeviceTokenSuccess>("DeviceTokenSuccess")({
  access_token: AccessToken,
  refresh_token: Schema.optional(RefreshToken),
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(DurationFromSeconds),
}) {}

class DeviceTokenError extends Schema.Class<DeviceTokenError>("DeviceTokenError")({
  error: Schema.String,
  error_description: Schema.String,
}) {
  toPollResult(): PollResult {
    if (this.error === "authorization_pending") return new PollPending()
    if (this.error === "slow_down") return new PollSlow()
    if (this.error === "expired_token") return new PollExpired()
    if (this.error === "access_denied") return new PollDenied()
    return new PollError({ cause: this.error })
  }
}

const DeviceToken = Schema.Union([DeviceTokenSuccess, DeviceTokenError])

class KeyMint extends Schema.Class<KeyMint>("KeyMint")({
  id: Schema.String,
  key: AccessToken,
}) {}

class ClientId extends Schema.Class<ClientId>("ClientId")({
  client_id: Schema.String,
  scope: Schema.String,
}) {}

class DeviceTokenRequest extends Schema.Class<DeviceTokenRequest>("DeviceTokenRequest")({
  grant_type: Schema.String,
  device_code: DeviceCode,
  client_id: Schema.String,
}) {}

class TokenRefreshRequest extends Schema.Class<TokenRefreshRequest>("TokenRefreshRequest")({
  grant_type: Schema.String,
  refresh_token: RefreshToken,
  client_id: Schema.String,
}) {}

const clientId = "vegacode"
const keyExpiry = Duration.days(3650)
const eagerRefreshThreshold = Duration.minutes(5)
const eagerRefreshThresholdMs = Duration.toMillis(eagerRefreshThreshold)

const isTokenFresh = (tokenExpiry: number | null, now: number) =>
  tokenExpiry != null && tokenExpiry > now + eagerRefreshThresholdMs

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const mapAccountServiceError =
  (message = "Account service operation failed") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AccountError, R> =>
    effect.pipe(Effect.mapError((cause) => accountErrorFromCause(cause, message)))

const accountErrorFromCause = (cause: unknown, message: string): AccountError => {
  if (cause instanceof AccountServiceError || cause instanceof AccountTransportError) {
    return cause
  }

  if (HttpClientError.isHttpClientError(cause)) {
    switch (cause.reason._tag) {
      case "TransportError": {
        return AccountTransportError.fromHttpClientError(cause.reason)
      }
      default: {
        return new AccountServiceError({ message, cause })
      }
    }
  }

  return new AccountServiceError({ message, cause })
}

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountError>
  readonly activeOrg: () => Effect.Effect<Option.Option<ActiveOrg>, AccountError>
  readonly list: () => Effect.Effect<Info[], AccountError>
  readonly orgsByAccount: () => Effect.Effect<readonly AccountOrgs[], AccountError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountError>
  readonly orgs: (accountID: AccountID) => Effect.Effect<readonly Org[], AccountError>
  readonly config: (
    accountID: AccountID,
    orgID: Option.Option<OrgID>,
  ) => Effect.Effect<Option.Option<Record<string, unknown>>, AccountError>
  readonly token: (accountID: AccountID) => Effect.Effect<Option.Option<AccessToken>, AccountError>
  readonly login: (url: string) => Effect.Effect<Login, AccountError>
  readonly poll: (input: Login) => Effect.Effect<PollResult, AccountError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Account") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, AccountRepo.Service | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* AccountRepo.Service
    const http = yield* HttpClient.HttpClient
    const httpRead = withTransientReadRetry(http)
    const httpOk = HttpClient.filterStatusOk(http)
    const httpReadOk = HttpClient.filterStatusOk(httpRead)

    const executeRead = (request: HttpClientRequest.HttpClientRequest) =>
      httpRead.execute(request).pipe(mapAccountServiceError("HTTP request failed"))

    const executeReadOk = (request: HttpClientRequest.HttpClientRequest) =>
      httpReadOk.execute(request).pipe(mapAccountServiceError("HTTP request failed"))

    const executeEffectOk = <E>(request: Effect.Effect<HttpClientRequest.HttpClientRequest, E>) =>
      request.pipe(
        Effect.flatMap((req) => httpOk.execute(req)),
        mapAccountServiceError("HTTP request failed"),
      )

    const executeEffect = <E>(request: Effect.Effect<HttpClientRequest.HttpClientRequest, E>) =>
      request.pipe(
        Effect.flatMap((req) => http.execute(req)),
        mapAccountServiceError("HTTP request failed"),
      )

    const mintKey = Effect.fnUntraced(function* (url: string, sessionToken: string) {
      const response = yield* executeEffectOk(
        HttpClientRequest.post(`${url}${apiPath}/keys/vegacode`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(sessionToken),
          HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.String))({}),
        ),
      )

      return yield* HttpClientResponse.schemaBodyJson(KeyMint)(response).pipe(
        mapAccountServiceError("Failed to decode response"),
      )
    })

    const refreshToken = Effect.fnUntraced(function* (row: AccountRow) {
      const now = yield* Clock.currentTimeMillis

      const response = yield* executeEffectOk(
        HttpClientRequest.post(`${row.url}/api/auth/device/token`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.schemaBodyJson(TokenRefreshRequest)(
            new TokenRefreshRequest({
              grant_type: "refresh_token",
              refresh_token: row.refresh_token,
              client_id: clientId,
            }),
          ),
        ),
      )

      const parsed = yield* HttpClientResponse.schemaBodyJson(TokenRefresh)(response).pipe(
        mapAccountServiceError("Failed to decode response"),
      )

      const minted = yield* mintKey(row.url, parsed.access_token)
      const expiry = Option.some(now + Duration.toMillis(keyExpiry))

      yield* repo.persistToken({
        accountID: row.id,
        accessToken: minted.key,
        refreshToken: parsed.refresh_token ?? RefreshToken.make(parsed.access_token),
        expiry,
      })

      return minted.key
    })

    const refreshTokenCache = yield* Cache.make<AccountID, AccessToken, AccountError>({
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: Duration.zero,
      lookup: Effect.fnUntraced(function* (accountID) {
        const maybeAccount = yield* repo.getRow(accountID)
        if (Option.isNone(maybeAccount)) {
          return yield* Effect.fail(new AccountServiceError({ message: "Account not found during token refresh" }))
        }

        const account = maybeAccount.value
        const now = yield* Clock.currentTimeMillis
        if (isTokenFresh(account.token_expiry, now)) {
          return account.access_token
        }

        return yield* refreshToken(account)
      }),
    })

    const resolveToken = Effect.fnUntraced(function* (row: AccountRow) {
      const now = yield* Clock.currentTimeMillis
      if (isTokenFresh(row.token_expiry, now)) {
        return row.access_token
      }

      return yield* Cache.get(refreshTokenCache, row.id)
    })

    const resolveAccess = Effect.fnUntraced(function* (accountID: AccountID) {
      const maybeAccount = yield* repo.getRow(accountID)
      if (Option.isNone(maybeAccount)) return Option.none()

      const account = maybeAccount.value
      const accessToken = yield* resolveToken(account)
      return Option.some({ account, accessToken })
    })

    const fetchEmail = Effect.fnUntraced(function* (url: string, accessToken: AccessToken) {
      const response = yield* executeReadOk(
        HttpClientRequest.get(`${url}${apiPath}/account`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(accessToken),
        ),
      )

      const body = yield* HttpClientResponse.schemaBodyJson(Schema.Record(Schema.String, Schema.Unknown))(
        response,
      ).pipe(mapAccountServiceError("Failed to decode response"))
      return [body, body.user, body.data]
        .map((item) => (isRecord(item) && typeof item.email === "string" ? item.email : undefined))
        .find((item) => item !== undefined)
    })

    const token = Effect.fn("Account.token")((accountID: AccountID) =>
      resolveAccess(accountID).pipe(Effect.map(Option.map((r) => r.accessToken))),
    )

    const activeOrg = Effect.fn("Account.activeOrg")(function* () {
      const activeAccount = yield* repo.active()
      if (Option.isNone(activeAccount)) return Option.none<ActiveOrg>()

      const account = activeAccount.value
      if (!account.active_org_id) return Option.none<ActiveOrg>()

      const accountOrgs = yield* orgs(account.id)
      const org = accountOrgs.find((item) => item.id === account.active_org_id)
      if (!org) return Option.none<ActiveOrg>()

      return Option.some({ account, org })
    })

    const orgsByAccount = Effect.fn("Account.orgsByAccount")(function* () {
      const accounts = yield* repo.list()
      return yield* Effect.forEach(
        accounts,
        (account) =>
          orgs(account.id).pipe(
            Effect.catch(() => Effect.succeed([] as readonly Org[])),
            Effect.map((orgs) => ({ account, orgs })),
          ),
        { concurrency: 3 },
      )
    })

    const orgs = Effect.fn("Account.orgs")(function* (_accountID: AccountID) {
      return [] as readonly Org[]
    })

    const remove = Effect.fn("Account.remove")(function* (accountID: AccountID) {
      const row = yield* repo.getRow(accountID)
      if (Option.isSome(row)) {
        yield* http
          .execute(
            HttpClientRequest.post(`${row.value.url}${apiPath}/keys/vegacode/revoke`).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bearerToken(row.value.access_token),
            ),
          )
          .pipe(Effect.ignore)
      }

      const active = yield* repo.active()
      yield* repo.remove(accountID)
      if (Option.isNone(active) || active.value.id !== accountID) return

      const next = (yield* repo.list())[0]
      if (!next) return
      yield* repo.use(next.id, Option.none())
    })

    const config = Effect.fn("Account.config")(function* (accountID: AccountID, _orgID: Option.Option<OrgID>) {
      const resolved = yield* resolveAccess(accountID)
      if (Option.isNone(resolved)) return Option.none()

      const { account, accessToken } = resolved.value

      const response = yield* executeReadOk(
        HttpClientRequest.get(`${account.url}${apiPath}/models`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(accessToken),
        ),
      )

      const list = yield* HttpClientResponse.schemaBodyJson(Models)(response).pipe(
        mapAccountServiceError("Failed to decode response"),
      )
      const providers = provider(account.url, list) ?? {}
      return Option.some({
        provider: Object.fromEntries(
          Object.entries(providers).map(([id, item]) => [
            id,
            { ...item, options: { ...item.options, apiKey: "{env:OPENCODE_CONSOLE_TOKEN}" } },
          ]),
        ),
      })
    })

    const login = Effect.fn("Account.login")(function* (server: string) {
      const normalizedServer = normalizeServerUrl(server)
      const response = yield* executeEffectOk(
        HttpClientRequest.post(`${normalizedServer}/api/auth/device/code`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.schemaBodyJson(ClientId)(new ClientId({ client_id: clientId, scope: "api" })),
        ),
      )

      const parsed = yield* HttpClientResponse.schemaBodyJson(DeviceAuth)(response).pipe(
        mapAccountServiceError("Failed to decode response"),
      )
      const verification = yield* Effect.try({
        try: () => {
          const url = new URL(parsed.verification_uri_complete, `${normalizedServer}/`)
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("expected HTTP(S)")
          return url.href
        },
        catch: (cause) => new AccountServiceError({ message: "Invalid device verification URL", cause }),
      })
      return new Login({
        code: parsed.device_code,
        user: parsed.user_code,
        url: verification,
        server: normalizedServer,
        expiry: parsed.expires_in,
        interval: parsed.interval,
      })
    })

    const poll = Effect.fn("Account.poll")(function* (input: Login) {
      const response = yield* executeEffect(
        HttpClientRequest.post(`${input.server}/api/auth/device/token`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.schemaBodyJson(DeviceTokenRequest)(
            new DeviceTokenRequest({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: input.code,
              client_id: clientId,
            }),
          ),
        ),
      )

      const parsed = yield* HttpClientResponse.schemaBodyJson(DeviceToken)(response).pipe(
        mapAccountServiceError("Failed to decode response"),
      )

      if (parsed instanceof DeviceTokenError) return parsed.toPollResult()
      const sessionToken = parsed.access_token

      const minted = yield* mintKey(input.server, sessionToken)
      const email = yield* fetchEmail(input.server, minted.key).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )

      const now = yield* Clock.currentTimeMillis
      const expiry = now + Duration.toMillis(keyExpiry)
      const refreshToken = parsed.refresh_token ?? RefreshToken.make(sessionToken)
      const account = email ?? minted.id

      yield* repo.persistAccount({
        id: AccountID.make(account),
        email: account,
        url: input.server,
        accessToken: minted.key,
        refreshToken,
        expiry,
        orgID: Option.none(),
      })

      return new PollSuccess({ email: account })
    })

    return Service.of({
      active: repo.active,
      activeOrg,
      list: repo.list,
      orgsByAccount,
      remove,
      use: repo.use,
      orgs,
      config,
      token,
      login,
      poll,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [AccountRepo.node, httpClient] })

export * as Account from "./account"
