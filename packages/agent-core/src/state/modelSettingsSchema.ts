// ModelSettings 的字段、静态类型与持久化边界校验 schema。

import type { ChatRequestBase } from '@einfach-agent/ai'

export type ModelVendor = string

interface ModelSettingsField<Value, Required extends boolean> {
  required: Required
  accepts(value: unknown): value is Value
}

function requiredField<Value>(
  accepts: (value: unknown) => value is Value,
): ModelSettingsField<Value, true> {
  return { required: true, accepts }
}

function optionalField<Value>(
  accepts: (value: unknown) => value is Value,
): ModelSettingsField<Value, false> {
  return { required: false, accepts }
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isFiniteJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

function isSettingsBag(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const MODEL_SETTINGS_FIELD_SCHEMA = {
  vendor: requiredField<ModelVendor>(isText),
  model: requiredField<string>(isText),
  thinking: optionalField<boolean>(isBoolean),
  temperature: optionalField<ChatRequestBase['temperature']>(isFiniteJsonNumber),
  max_tokens: optionalField<ChatRequestBase['max_tokens']>(isFiniteJsonNumber),
  vendorSettings: optionalField<Readonly<Record<string, unknown>>>(isSettingsBag),
} as const

type FieldValue<Field> = Field extends ModelSettingsField<infer Value, boolean> ? Value : never
type RequiredFieldNames = {
  [Name in keyof typeof MODEL_SETTINGS_FIELD_SCHEMA]:
    (typeof MODEL_SETTINGS_FIELD_SCHEMA)[Name]['required'] extends true ? Name : never
}[keyof typeof MODEL_SETTINGS_FIELD_SCHEMA]
type OptionalFieldNames = Exclude<keyof typeof MODEL_SETTINGS_FIELD_SCHEMA, RequiredFieldNames>

export type ModelSettings = {
  [Name in RequiredFieldNames]: FieldValue<(typeof MODEL_SETTINGS_FIELD_SCHEMA)[Name]>
} & {
  [Name in OptionalFieldNames]?: FieldValue<(typeof MODEL_SETTINGS_FIELD_SCHEMA)[Name]>
}

export type ModelSettingsFieldName = keyof typeof MODEL_SETTINGS_FIELD_SCHEMA

/** migration 只把不在此集合内的旧顶层字段搬入 vendorSettings。 */
export const MODEL_SETTINGS_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(MODEL_SETTINGS_FIELD_SCHEMA),
)

/** recovery 边界按同一 schema 拒绝未知、缺失或类型不符的字段。 */
export function isModelSettings(value: unknown): value is ModelSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !MODEL_SETTINGS_FIELDS.has(key))) return false
  return Object.entries(MODEL_SETTINGS_FIELD_SCHEMA).every(([name, field]) => (
    name in record ? field.accepts(record[name]) : !field.required
  ))
}
