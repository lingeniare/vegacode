import { Schema } from "effect"
import { ConfigProviderV1 } from "../../v1/config/provider"
import { ConfigV1 } from "../../v1/config/config"

export const defaultServer = "https://api.vega.chat"
export const clientID = "vegacode"
export const apiPath = "/api/v1"

const Modality = Schema.Literals(["text", "audio", "image", "video", "pdf"])

export const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      canonical_slug: Schema.optional(Schema.String),
      created: Schema.optional(Schema.Number),
      context_length: Schema.optional(Schema.NullOr(Schema.Number)),
      architecture: Schema.optional(
        Schema.Struct({
          input_modalities: Schema.optional(Schema.Array(Schema.String)),
          output_modalities: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      pricing: Schema.optional(
        Schema.Struct({
          prompt: Schema.optional(Schema.String),
          completion: Schema.optional(Schema.String),
          input_cache_read: Schema.optional(Schema.String),
          input_cache_write: Schema.optional(Schema.String),
        }),
      ),
      top_provider: Schema.optional(
        Schema.Struct({
          context_length: Schema.optional(Schema.NullOr(Schema.Number)),
          max_completion_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
        }),
      ),
      supported_parameters: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

const modalities = (list: readonly string[] | undefined) =>
  (list ?? []).flatMap((item) => (item === "file" ? ["pdf" as const] : Schema.is(Modality)(item) ? [item] : []))

const defined = (input: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))

const model = (input: (typeof Models.Type)["data"][number]): typeof ConfigProviderV1.Model.Type => {
  const parameters = input.supported_parameters ?? []
  const inputModalities = modalities(input.architecture?.input_modalities)
  const outputModalities = modalities(input.architecture?.output_modalities)
  return defined({
    id: input.id,
    name: input.name ?? input.id,
    family: input.canonical_slug?.split("/").pop(),
    release_date: input.created ? new Date(input.created * 1000).toISOString().slice(0, 10) : undefined,
    attachment: inputModalities.includes("image") || inputModalities.includes("pdf"),
    reasoning: parameters.includes("reasoning") || parameters.includes("include_reasoning"),
    temperature: parameters.includes("temperature"),
    tool_call: parameters.includes("tools"),
    cost: {
      input: Number(input.pricing?.prompt ?? 0) * 1e6,
      output: Number(input.pricing?.completion ?? 0) * 1e6,
      cache_read: Number(input.pricing?.input_cache_read ?? 0) * 1e6,
      cache_write: Number(input.pricing?.input_cache_write ?? 0) * 1e6,
    },
    limit: {
      context: input.top_provider?.context_length ?? input.context_length ?? 0,
      output: input.top_provider?.max_completion_tokens ?? input.context_length ?? 0,
    },
    modalities: { input: inputModalities, output: outputModalities },
    status: "active",
  }) as typeof ConfigProviderV1.Model.Type
}

export const provider = (server: string, list: typeof Models.Type): typeof ConfigV1.Info.Type.provider => ({
  opencode: {
    name: "Vega Code",
    api: `${server}${apiPath}`,
    npm: "@ai-sdk/openai-compatible",
    models: Object.fromEntries(list.data.map((item) => [item.id, model(item)])),
  },
})
