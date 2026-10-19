import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Duration, Effect, Layer, Option } from "effect"
import { sql } from "drizzle-orm"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"

import { AccountRepo } from "../../src/account/repo"
import { Account } from "../../src/account/account"
import {
  AccessToken,
  AccountID,
  AccountServiceError,
  AccountTransportError,
  DeviceCode,
  Login,
  RefreshToken,
  UserCode,
} from "../../src/account/schema"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`DELETE FROM account_state`)
    yield* db.run(sql`DELETE FROM account`)
  }),
)
const truncateNode = LayerNode.make({ name: "truncate-account", layer: truncate, deps: [Database.node] })

const it = testEffect(LayerNode.compile(LayerNode.group([AccountRepo.node, truncateNode])))

const insideEagerRefreshWindow = Duration.toMillis(Duration.minutes(1))
const outsideEagerRefreshWindow = Duration.toMillis(Duration.minutes(10))

const live = (client: HttpClient.HttpClient) =>
  LayerNode.compile(Account.node, [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]])

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const login = () =>
  new Login({
    code: DeviceCode.make("device-code"),
    user: UserCode.make("user-code"),
    url: "https://one.example.com/verify",
    server: "https://one.example.com",
    expiry: Duration.seconds(600),
    interval: Duration.seconds(5),
  })

const vegaModel = {
  id: "vega/test-model",
  name: "Vega Test Model",
  context_length: 128000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002" },
  top_provider: { context_length: 128000, max_completion_tokens: 4096 },
  supported_parameters: ["tools"],
}

const deviceTokenClient = (body: unknown, status = 400) =>
  HttpClient.make((req) =>
    Effect.succeed(
      req.url === "https://one.example.com/api/auth/device/token" ? json(req, body, status) : json(req, {}, 404),
    ),
  )

const poll = (body: unknown, status = 400) =>
  Account.Service.use((s) => s.poll(login())).pipe(Effect.provide(live(deviceTokenClient(body, status))))

it.live("login resolves origin-rooted verification URLs from servers with base paths", () =>
  Effect.gen(function* () {
    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)

        if (req.url === "https://one.example.com/console/api/auth/device/code") {
          return json(req, {
            device_code: "device-code",
            user_code: "user-code",
            verification_uri_complete: "/console/device?user_code=user-code",
            expires_in: 600,
            interval: 5,
          })
        }

        return json(req, {}, 404)
      }),
    )

    const result = yield* Account.use.login("https://one.example.com/console/").pipe(Effect.provide(live(client)))

    expect(seen).toEqual(["POST https://one.example.com/console/api/auth/device/code"])
    expect(result.server).toBe("https://one.example.com/console")
    expect(result.url).toBe("https://one.example.com/console/device?user_code=user-code")
  }),
)

it.live("login requests a device code for the vegacode application", () =>
  Effect.gen(function* () {
    let body: unknown
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        if (req.url === "https://api.vega.chat/api/auth/device/code") {
          body = req.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(req.body.body)) : undefined
          return json(req, {
            device_code: "device-code",
            user_code: "user-code",
            verification_uri_complete: "https://api.vega.chat/device?user_code=user-code",
            expires_in: 600,
            interval: 5,
          })
        }

        return json(req, {}, 404)
      }),
    )

    yield* Account.use.login("https://api.vega.chat").pipe(Effect.provide(live(client)))

    expect(body).toEqual({ client_id: "vegacode", scope: "api" })
  }),
)

it.live("login rejects malformed device verification URLs", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.succeed(
        json(req, {
          device_code: "device-code",
          user_code: "user-code",
          verification_uri_complete: "http://[::1",
          expires_in: 600,
          interval: 5,
        }),
      ),
    )

    const error = yield* Effect.flip(Account.use.login("https://one.example.com").pipe(Effect.provide(live(client))))
    expect(error).toBeInstanceOf(AccountServiceError)
    if (error instanceof AccountServiceError) expect(error.message).toBe("Invalid device verification URL")
  }),
)

it.live("login maps transport failures to account transport errors", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req }),
        }),
      ),
    )

    const error = yield* Effect.flip(Account.use.login("https://one.example.com").pipe(Effect.provide(live(client))))

    expect(error).toBeInstanceOf(AccountTransportError)
    if (error instanceof AccountTransportError) {
      expect(error.method).toBe("POST")
      expect(error.url).toBe("https://one.example.com/api/auth/device/code")
    }
  }),
)

it.live("orgsByAccount returns accounts without orgs", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-1"),
        email: "one@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-2"),
        email: "two@example.com",
        url: "https://two.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)
        return json(req, {}, 404)
      }),
    )

    const rows = yield* Account.use.orgsByAccount().pipe(Effect.provide(live(client)))

    expect(rows.map((row) => [row.account.id, row.orgs.length])).toEqual([
      [AccountID.make("user-1"), 0],
      [AccountID.make("user-2"), 0],
    ])
    expect(seen).toEqual([])
  }),
)

it.live("remove revokes the VEGA app key and keeps the active account", () =>
  Effect.gen(function* () {
    const first = AccountID.make("user-1")
    const second = AccountID.make("user-2")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: first,
        email: "one@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: second,
        email: "two@example.com",
        url: "https://two.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)
        if (req.url === "https://two.example.com/api/v1/keys/vegacode/revoke") {
          expect(req.headers.authorization).toBe("Bearer at_2")
          return json(req, { revoked: true })
        }
        return json(req, {}, 404)
      }),
    )

    yield* Account.use.remove(second).pipe(Effect.provide(live(client)))

    expect(seen).toEqual(["POST https://two.example.com/api/v1/keys/vegacode/revoke"])
    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active).id).toBe(first)
    expect(Option.getOrThrow(active).active_org_id).toBeNull()
  }),
)

it.live("token refresh mints a new VEGA app key", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("sk-apivega-old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() - 1_000,
        orgID: Option.none(),
      }),
    )

    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://one.example.com/api/auth/device/token"
          ? json(req, {
              access_token: "session_new",
              refresh_token: "rt_new",
            })
          : req.url === "https://one.example.com/api/v1/keys/vegacode"
            ? json(req, { id: "key_new", key: "sk-apivega-new" })
            : json(req, {}, 404),
      ),
    )

    const token = yield* Account.use.token(id).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(token)).toBeDefined()
    expect(String(Option.getOrThrow(token))).toBe("sk-apivega-new")

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("sk-apivega-new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
    expect(value.token_expiry).toBeGreaterThan(Date.now())
  }),
)

it.live("token refreshes before expiry when inside the eager refresh window", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("sk-apivega-old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() + insideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    let refreshCalls = 0
    const client = HttpClient.make((req) =>
      Effect.promise(async () => {
        if (req.url === "https://one.example.com/api/auth/device/token") {
          refreshCalls += 1
          return json(req, {
            access_token: "session_new",
            refresh_token: "rt_new",
          })
        }

        if (req.url === "https://one.example.com/api/v1/keys/vegacode") {
          return json(req, { id: "key_new", key: "sk-apivega-new" })
        }

        return json(req, {}, 404)
      }),
    )

    const token = yield* Account.use.token(id).pipe(Effect.provide(live(client)))

    expect(String(Option.getOrThrow(token))).toBe("sk-apivega-new")
    expect(refreshCalls).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("sk-apivega-new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
  }),
)

it.live("concurrent config and token requests coalesce token refresh", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("sk-apivega-old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() - 1_000,
        orgID: Option.none(),
      }),
    )

    let refreshCalls = 0
    const client = HttpClient.make((req) =>
      Effect.promise(async () => {
        if (req.url === "https://one.example.com/api/auth/device/token") {
          refreshCalls += 1

          if (refreshCalls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            return json(req, {
              access_token: "session_new",
              refresh_token: "rt_new",
            })
          }

          return json(
            req,
            {
              error: "invalid_grant",
              error_description: "refresh token already used",
            },
            400,
          )
        }

        if (req.url === "https://one.example.com/api/v1/keys/vegacode") {
          return json(req, { id: "key_new", key: "sk-apivega-new" })
        }

        if (req.url === "https://one.example.com/api/v1/models") {
          expect(req.headers.authorization).toBe("Bearer sk-apivega-new")
          return json(req, { data: [vegaModel] })
        }

        return json(req, {}, 404)
      }),
    )

    const [cfg, token] = yield* Account.Service.use((s) =>
      Effect.all([s.config(id, Option.none()), s.token(id)], { concurrency: 2 }),
    ).pipe(Effect.provide(live(client)))

    const config = Option.getOrThrow(cfg)
    expect(config.provider).toMatchObject({
      opencode: {
        name: "Vega Code",
        api: "https://one.example.com/api/v1",
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "{env:OPENCODE_CONSOLE_TOKEN}" },
      },
    })
    expect(String(Option.getOrThrow(token))).toBe("sk-apivega-new")
    expect(refreshCalls).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("sk-apivega-new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
  }),
)

it.live("config synthesizes the VEGA provider from the model list", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("sk-apivega-1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    const seen: { auth?: string } = {}
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.auth = req.headers.authorization

        if (req.url === "https://one.example.com/api/v1/models") {
          return json(req, { data: [vegaModel] })
        }

        return json(req, {}, 404)
      }),
    )

    const cfg = yield* Account.Service.use((s) => s.config(id, Option.none())).pipe(Effect.provide(live(client)))

    const config = Option.getOrThrow(cfg)
    expect(config.provider).toMatchObject({
      opencode: {
        name: "Vega Code",
        api: "https://one.example.com/api/v1",
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "{env:OPENCODE_CONSOLE_TOKEN}" },
        models: {
          "vega/test-model": {
            name: "Vega Test Model",
            tool_call: true,
            limit: { context: 128000, output: 4096 },
          },
        },
      },
    })
    expect(seen).toEqual({ auth: "Bearer sk-apivega-1" })
  }),
)

it.live("poll mints and stores the VEGA app key on success", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://one.example.com/api/auth/device/token"
          ? json(req, {
              access_token: "session_1",
              token_type: "Bearer",
            })
          : req.url === "https://one.example.com/api/v1/keys/vegacode"
            ? json(req, { id: "key_1", key: "sk-apivega-1" })
            : req.url === "https://one.example.com/api/v1/account"
              ? json(req, { email: "user@example.com" })
              : json(req, {}, 404),
      ),
    )

    const res = yield* Account.Service.use((s) => s.poll(login())).pipe(Effect.provide(live(client)))

    expect(res._tag).toBe("PollSuccess")
    if (res._tag === "PollSuccess") {
      expect(res.email).toBe("user@example.com")
    }

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active)).toEqual(
      expect.objectContaining({
        id: "user@example.com",
        email: "user@example.com",
        active_org_id: null,
      }),
    )
    const row = yield* AccountRepo.use.getRow(AccountID.make("user@example.com"))
    expect(Option.getOrThrow(row).access_token).toBe(AccessToken.make("sk-apivega-1"))
  }),
)

for (const [name, body, expectedTag] of [
  [
    "pending",
    {
      error: "authorization_pending",
      error_description: "The authorization request is still pending",
    },
    "PollPending",
  ],
  [
    "slow",
    {
      error: "slow_down",
      error_description: "Polling too frequently, please slow down",
    },
    "PollSlow",
  ],
  [
    "denied",
    {
      error: "access_denied",
      error_description: "The authorization request was denied",
    },
    "PollDenied",
  ],
  [
    "expired",
    {
      error: "expired_token",
      error_description: "The device code has expired",
    },
    "PollExpired",
  ],
] as const) {
  it.live(`poll returns ${name} for ${body.error}`, () =>
    Effect.gen(function* () {
      const result = yield* poll(body)
      expect(result._tag).toBe(expectedTag)
    }),
  )
}

it.live("poll returns poll error for other OAuth errors", () =>
  Effect.gen(function* () {
    const result = yield* poll({
      error: "server_error",
      error_description: "An unexpected error occurred",
    })

    expect(result._tag).toBe("PollError")
    if (result._tag === "PollError") {
      expect(String(result.cause)).toContain("server_error")
    }
  }),
)
