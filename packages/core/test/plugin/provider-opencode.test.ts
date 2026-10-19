import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { OpencodePlugin } from "@opencode-ai/core/plugin/provider/opencode"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (http?: HttpClient.HttpClient) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  const events = yield* EventV2.Service
  const integration = yield* Integration.Service
  const client = yield* HttpClient.HttpClient
  yield* OpencodePlugin.effect(host).pipe(
    Effect.provideService(EventV2.Service, events),
    Effect.provideService(Integration.Service, integration),
    Effect.provideService(HttpClient.HttpClient, http ?? client),
  )
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function eventually<A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  remaining = 1000,
): Effect.Effect<A, Error> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

const cost = (input: number, output = 0) => [{ input, output, cache: { read: 0, write: 0 } }]

const vegaModel = {
  id: "vega/test-model",
  name: "Vega Test Model",
  canonical_slug: "vega/test-model-20261017",
  created: 1792225624,
  context_length: 128000,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
  top_provider: { context_length: 128000, max_completion_tokens: 4096 },
  supported_parameters: ["tools", "temperature", "reasoning"],
}

const models = (list: unknown[] = [vegaModel]) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: list }))),
  )

const paidModel = (catalog: Catalog.Draft) => {
  const provider = ProviderV2.Info.make({
    ...ProviderV2.Info.empty(ProviderV2.ID.opencode),
    api: { type: "aisdk", package: "test-provider" },
  })
  const model = ModelV2.Info.make({
    ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("paid")),
    api: { id: ModelV2.ID.make("paid"), type: "aisdk", package: "test-provider" },
    cost: cost(1),
  })
  catalog.provider.update(provider.id, () => {})
  catalog.model.update(provider.id, model.id, (draft) => {
    draft.cost = [...model.cost]
  })
}

describe("OpencodePlugin", () => {
  it.effect("registers account, key and env methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      expect((yield* (yield* Integration.Service).get(Integration.ID.make("opencode")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          label: "Vega Code account",
        },
        { type: "key", label: "API key" },
        { type: "env", names: ["VEGA_API_KEY", "VEGACODE_API_KEY", "OPENCODE_API_KEY"] },
      ])
    }),
  )

  it.effect("resolves origin-rooted device verification URLs", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              device_code: "device",
              user_code: "user",
              verification_uri_complete: "/device?user_code=user",
              expires_in: 60,
              interval: 60,
            }),
          ),
        ),
      )
      yield* addPlugin(http)
      const integration = yield* Integration.Service
      const attempt = yield* integration.connection.oauth({
        integrationID: Integration.ID.make("opencode"),
        methodID: Integration.MethodID.make("device"),
        inputs: {},
      })
      expect(attempt.url).toBe("https://api.vega.chat/device?user_code=user")
    }),
  )

  it.effect("rejects malformed device verification URLs", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              device_code: "device",
              user_code: "user",
              verification_uri_complete: "http://[::1",
              expires_in: 60,
              interval: 60,
            }),
          ),
        ),
      )
      yield* addPlugin(http)
      const integration = yield* Integration.Service
      const error = yield* integration.connection
        .oauth({
          integrationID: Integration.ID.make("opencode"),
          methodID: Integration.MethodID.make("device"),
          inputs: {},
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Integration.AuthorizationError)
      expect(String(error.cause)).toContain("Invalid device verification URL")
    }),
  )

  it.live("loads Vega Code models from the VEGA model list", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const authorization: Array<string | null> = []
        const gate = Promise.withResolvers<void>()
        return {
          authorization,
          release: gate.resolve,
          server: Bun.serve({
            port: 0,
            fetch: async (request) => {
              await gate.promise
              authorization.push(request.headers.get("authorization"))
              expect(new URL(request.url).pathname).toBe("/api/v1/models")
              return Response.json({ data: [vegaModel] })
            },
          }),
        }
      }),
      ({ authorization, release, server }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          yield* catalog.transform((draft) => {
            draft.provider.update(ProviderV2.ID.make("remote"), () => {})
            draft.model.update(ProviderV2.ID.make("remote"), ModelV2.ID.make("stale"), () => {})
          })
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin },
            }),
          })

          yield* addPlugin()
          expect(authorization).toEqual([])
          release()

          yield* eventually(catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("vega/test-model")), Boolean)
          const provider = required(yield* catalog.provider.get(ProviderV2.ID.opencode))
          expect(provider).toMatchObject({
            name: "Vega Code",
            integrationID: "opencode",
            api: {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: `${server.url.origin}/api/v1`,
            },
          })
          expect(yield* (yield* Integration.Service).get(Integration.ID.make("remote"))).toBeUndefined()

          const model = required(
            yield* catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("vega/test-model")),
          )
          expect(model).toMatchObject({
            name: "Vega Test Model",
            family: "test-model-20261017",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            limit: { context: 128000, output: 4096 },
            enabled: true,
          })
          expect(model.cost[0].input).toBe(1)
          expect(model.cost[0].output).toBe(2)
          expect(model.cost[0].cache.read).toBeCloseTo(0.1)
          expect(model.cost[0].cache.write).toBe(0)
          expect(yield* catalog.model.get(ProviderV2.ID.make("remote"), ModelV2.ID.make("stale"))).toBeDefined()
          expect(authorization).toContain("Bearer secret")
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("removes catalog models without credentials", () =>
    withEnv({ VEGA_API_KEY: undefined, VEGACODE_API_KEY: undefined, OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform(paidModel)
        yield* addPlugin()
        yield* eventually(catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("paid")), (item) => !item)
        expect(yield* catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("paid"))).toBeUndefined()
      }),
    ),
  )

  it.effect("keeps catalog models when a credential is configured directly", () =>
    withEnv({ VEGA_API_KEY: undefined, VEGACODE_API_KEY: undefined, OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          paidModel(catalog)
          catalog.provider.update(ProviderV2.ID.opencode, (draft) => {
            draft.request.body.apiKey = "configured"
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.opencode)).request.body.apiKey).toBe("configured")
        expect(required(yield* catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses VEGA_API_KEY as credentials and replaces catalog models", () =>
    withEnv({ VEGA_API_KEY: "secret", VEGACODE_API_KEY: undefined, OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform(paidModel)
        yield* addPlugin(models())
        yield* eventually(catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("vega/test-model")), Boolean)
        expect(yield* catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("paid"))).toBeUndefined()
        expect(
          required(yield* catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("vega/test-model"))).enabled,
        ).toBe(true)
      }),
    ),
  )

  it.effect("ignores non-opencode providers and models", () =>
    withEnv({ VEGA_API_KEY: undefined, VEGACODE_API_KEY: undefined, OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          const provider = ProviderV2.Info.make({
            ...ProviderV2.Info.empty(ProviderV2.ID.openai),
            api: { type: "aisdk", package: "test-provider" },
          })
          const model = ModelV2.Info.make({
            ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("paid")),
            api: { id: ModelV2.ID.make("paid"), type: "aisdk", package: "test-provider" },
            cost: cost(1),
          })
          catalog.provider.update(provider.id, () => {})
          catalog.model.update(provider.id, model.id, (draft) => {
            draft.cost = [...model.cost]
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.openai)).request.body.apiKey).toBeUndefined()
        expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("prefers gpt-5-nano as the opencode small model", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.opencode

      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, ModelV2.ID.make("cheap-mini"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [...cost(1, 1)]
          model.time.released = Date.now()
        })
        catalog.model.update(providerID, ModelV2.ID.make("gpt-5-nano"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [...cost(10, 10)]
          model.time.released = Date.now()
        })
      })

      const selected = yield* catalog.model.small(providerID)

      expect(selected?.id).toBe(ModelV2.ID.make("gpt-5-nano"))
    }),
  )
})
