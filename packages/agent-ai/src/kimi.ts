import {
  postChatCompletion,
  postChatCompletionStream,
  type ChatCallOptions,
  type ChatRequestBase,
  type ChatStreamHandlers,
  type ModelChatResponse,
} from './modelApi'
import { encodeKimiMessages, type KimiWireItem } from './kimiMessages'
import {
  kimiBaseUrl,
  resolveKimiRegion,
  type KimiRegion,
} from './kimiRegion'

export type KimiReasoningEffort = 'low' | 'high' | 'max'

export interface KimiChatRequest extends ChatRequestBase {
  region?: KimiRegion
  reasoning_effort?: KimiReasoningEffort
  top_p?: number
  presence_penalty?: number
  frequency_penalty?: number
}

interface KimiWireChatRequest extends Omit<ChatRequestBase<KimiWireItem>, 'thinking'> {
  reasoning_effort?: KimiReasoningEffort
}

function prepareKimiRequest(body: KimiChatRequest): KimiWireChatRequest {
  const {
    messages,
    region,
    thinking: _thinking,
    reasoning_effort: rawReasoningEffort,
    temperature: _temperature,
    top_p: _topP,
    presence_penalty: _presencePenalty,
    frequency_penalty: _frequencyPenalty,
    ...request
  } = body
  return {
    ...request,
    ...(rawReasoningEffort === 'low'
      || rawReasoningEffort === 'high'
      || rawReasoningEffort === 'max'
      ? { reasoning_effort: rawReasoningEffort }
      : {}),
    messages: encodeKimiMessages(messages, resolveKimiRegion(region), body.model),
  }
}

function requestBaseUrl(body: KimiChatRequest, options: ChatCallOptions): string {
  return options.baseUrl ?? kimiBaseUrl(resolveKimiRegion(body.region))
}

export function callKimi(
  body: KimiChatRequest,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  return postChatCompletion(requestBaseUrl(body, options), prepareKimiRequest(body), options)
}

export function streamKimi(
  body: KimiChatRequest,
  options: ChatCallOptions,
  handlers?: ChatStreamHandlers,
): Promise<ModelChatResponse> {
  const request = prepareKimiRequest(body)
  return postChatCompletionStream(
    requestBaseUrl(body, options),
    {
      ...request,
      stream_options: {
        ...request.stream_options,
        include_usage: request.stream_options?.include_usage ?? true,
      },
    },
    options,
    handlers,
  )
}
