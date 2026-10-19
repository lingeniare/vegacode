import { Duration, Effect, Schema, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/v2/effect/integration"
import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import type { CredentialValue } from "@opencode-ai/sdk/v2/types"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EventV2 } from "../../event"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { ConfigProviderV1 } from "../../v1/config/provider"
import { ConfigProviderOptionsV1 } from "../../v1/config/provider-options"
import { ConfigV1 } from "../../v1/config/config"
import { apiPath, clientID, defaultServer, Models, provider } from "./vega"

const methodID = Integration.MethodID.make("device")
const Device = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
})
const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})
const TokenPending = Schema.Struct({ error: Schema.String })
const DeviceToken = Schema.Union([Token, TokenPending])
const KeyMint = Schema.Struct({ id: Schema.String, key: Schema.String })

function oauth(http: HttpClient.HttpClient) {
  return {
    integrationID: Integration.ID.make("opencode"),
    method: {
      id: methodID,
      type: "oauth",
      label: "Vega Code account",
    },
    authorize: () =>
      Effect.gen(function* () {
        const device = yield* post(
          http,
          `${defaultServer}/api/auth/device/code`,
          { client_id: clientID, scope: "api" },
          Device,
        )
        const verification = yield* Effect.try({
          try: () => {
            const url = new URL(device.verification_uri_complete, `${defaultServer}/`)
            if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("expected HTTP(S)")
            return url
          },
          catch: (cause) =>
            new Error(`Invalid device verification URL: ${cause instanceof Error ? cause.message : String(cause)}`),
        })
        return {
          mode: "auto" as const,
          url: verification.href,
          instructions: `Enter code: ${device.user_code}`,
          callback: poll(http, defaultServer, device.device_code, Duration.seconds(device.interval)),
        }
      }),
    label: (credential) => {
      return typeof credential.metadata?.email === "string" ? credential.metadata.email : undefined
    },
  } satisfies IntegrationOAuthMethodRegistration
}

export const OpencodePlugin = define<HttpClient.HttpClient | EventV2.Service | Scope.Scope>({
  id: "opencode",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const http = yield* HttpClient.HttpClient
    const loading = Semaphore.makeUnsafe(1)
    let connected = false
    let providers: typeof ConfigV1.Info.Type.provider | undefined

    const load = Effect.fn("OpencodePlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active("opencode")
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      connected = connection !== undefined
      providers = credential
        ? yield* fetchProviders(http, credential).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to load Vega Code provider config", { cause }).pipe(Effect.as(undefined)),
            ),
          )
        : undefined
    })

    yield* ctx.integration.transform((draft) => {
      draft.update("opencode", (integration) => {
        integration.name = "Vega Code"
      })
      draft.method.update(oauth(http))
      draft.method.update({ integrationID: "opencode", method: { type: "key", label: "API key" } })
      draft.method.update({
        integrationID: "opencode",
        method: { type: "env", names: ["VEGA_API_KEY", "VEGACODE_API_KEY", "OPENCODE_API_KEY"] },
      })
      draft.remove(Integration.ID.make("opencode-go"))
    })

    connected = (yield* ctx.integration.connection.active("opencode")) !== undefined
    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.remove(ProviderV2.ID.make("opencode-go"))
      catalog.provider.update(ProviderV2.ID.opencode, (provider) => {
        provider.name = "Vega Code"
        provider.integrationID = Integration.ID.make("opencode")
        provider.api = {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: `${defaultServer}${apiPath}`,
        }
      })

      for (const [providerID, item] of Object.entries(providers ?? {})) {
        catalog.provider.update(providerID, (provider) => {
          provider.integrationID = Integration.ID.make("opencode")
          if (item.name !== undefined) provider.name = item.name
          provider.api = item.npm
            ? { type: "aisdk", package: item.npm, url: item.api }
            : { type: "native", url: item.api, settings: {} }
          Object.assign(provider.request.headers, item.options?.headers)
          Object.assign(provider.request.body, withoutCredentials(item.options))
        })

        for (const [modelID, config] of Object.entries(item.models ?? {})) {
          catalog.model.update(providerID, modelID, (model) => {
            if (config.family !== undefined) model.family = config.family
            if (config.name !== undefined) model.name = config.name
            if (config.id !== undefined) model.api.id = config.id
            if (config.provider !== undefined) {
              model.api = config.provider.npm
                ? {
                    id: model.api.id,
                    type: "aisdk",
                    package: config.provider.npm,
                    url: config.provider.api,
                  }
                : { id: model.api.id, type: "native", url: config.provider.api, settings: {} }
            }
            if (config.tool_call !== undefined) model.capabilities.tools = config.tool_call
            if (config.modalities?.input !== undefined) model.capabilities.input = [...config.modalities.input]
            if (config.modalities?.output !== undefined) model.capabilities.output = [...config.modalities.output]
            const packageName = config.provider?.npm ?? item.npm
            const lowerer = ConfigProviderOptionsV1.get(packageName)
            Object.assign(model.request.headers, config.headers)
            Object.assign(model.request.body, lowerer.request(withoutCredentials(config.options)))
            if (config.variants !== undefined) {
              model.variants = Object.entries(config.variants).map(([id, options]) => ({
                id: ModelV2.VariantID.make(id),
                headers: { ...(options.headers ?? {}) },
                body: lowerer.request(withoutCredentials(options)),
              }))
            }
            if (config.release_date !== undefined) {
              const released = Date.parse(config.release_date)
              model.time.released = Number.isFinite(released) ? released : 0
            }
            if (config.cost !== undefined) {
              model.cost = remoteCost(config.cost)
            }
            model.status = config.status ?? "active"
            model.enabled = config.status !== "deprecated"
            if (config.limit !== undefined) model.limit = { ...config.limit }
          })
        }
      }

      const item = catalog.provider.get(ProviderV2.ID.opencode)
      if (!item) return
      const remote = providers?.[ProviderV2.ID.opencode]?.models ?? {}
      const hasKey = connected || typeof item.provider.request.body.apiKey === "string"
      for (const modelID of [...item.models.keys()]) {
        if (modelID in remote) continue
        if (!hasKey || connected) catalog.model.remove(item.provider.id, modelID)
      }
    })

    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === Integration.ID.make("opencode")),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh().pipe(Effect.forkScoped)
  }),
})

function fetchProviders(http: HttpClient.HttpClient, value: CredentialValue) {
  const metadata = value.metadata
  const server = typeof metadata?.server === "string" ? metadata.server : defaultServer
  const token = value.type === "oauth" ? value.access : value.key
  return http
    .execute(
      HttpClientRequest.get(`${server}${apiPath}/models`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Models)),
      Effect.map((list) => provider(server, list)),
    )
}

function withoutCredentials(body: Readonly<Record<string, unknown>> | undefined) {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key !== "apiKey" && key !== "headers"))
}

function remoteCost(input: NonNullable<(typeof ConfigProviderV1.Model.Type)["cost"]>) {
  const base = {
    input: input.input,
    output: input.output,
    cache: { read: input.cache_read ?? 0, write: input.cache_write ?? 0 },
  }
  if (!input.context_over_200k) return [base]
  return [
    base,
    {
      tier: { type: "context" as const, size: 200_000 },
      input: input.context_over_200k.input,
      output: input.context_over_200k.output,
      cache: {
        read: input.context_over_200k.cache_read ?? 0,
        write: input.context_over_200k.cache_write ?? 0,
      },
    },
  ]
}

function poll(http: HttpClient.HttpClient, server: string, deviceCode: string, interval: Duration.Duration) {
  const loop = (wait: Duration.Duration): Effect.Effect<Credential.OAuth, unknown> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* post(
        http,
        `${server}/api/auth/device/token`,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: clientID,
        },
        DeviceToken,
        false,
      )
      if ("access_token" in result) return yield* credential(http, server, result)
      if (result.error === "authorization_pending") return yield* loop(wait)
      if (result.error === "slow_down") {
        return yield* loop(Duration.sum(wait, Duration.seconds(5)))
      }
      return yield* Effect.fail(new Error(`Device authorization failed: ${result.error}`))
    })
  return loop(interval)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function credential(http: HttpClient.HttpClient, server: string, token: typeof Token.Type) {
  return Effect.gen(function* () {
    const minted = yield* post(http, `${server}${apiPath}/keys/vegacode`, {}, KeyMint, true, token.access_token)
    const account = yield* get(
      http,
      `${server}${apiPath}/account`,
      minted.key,
      Schema.Record(Schema.String, Schema.Unknown),
    ).pipe(Effect.catch(() => Effect.succeed({} as Record<string, unknown>)))
    const email = [account, account.user, account.data]
      .map((item) => (isRecord(item) && typeof item.email === "string" ? item.email : undefined))
      .find((item) => item !== undefined)
    return Credential.OAuth.make({
      type: "oauth" as const,
      methodID,
      access: minted.key,
      refresh: token.refresh_token ?? token.access_token,
      expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
      metadata: {
        server,
        accountID: email ?? minted.id,
        email,
        keyID: minted.id,
      },
    })
  })
}

function get<S extends Schema.Top>(http: HttpClient.HttpClient, url: string, token: string, schema: S) {
  return HttpClient.filterStatusOk(http)
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(token)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
}

function post<S extends Schema.Top>(
  http: HttpClient.HttpClient,
  url: string,
  body: Record<string, string>,
  schema: S,
  statusOk = true,
  token?: string,
) {
  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.String))(body),
    Effect.map((request) => (token ? request.pipe(HttpClientRequest.bearerToken(token)) : request)),
    Effect.flatMap((request) => http.execute(request)),
    Effect.flatMap((response) => (statusOk ? HttpClientResponse.filterStatusOk(response) : Effect.succeed(response))),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  )
}
