import { describe, expect, it } from 'vitest'
import { DELEGATABLE_DANGEROUS_TOOLS } from '../runtime/dangerousTools'
import { SUBAGENT_TOOL_PROFILES } from './toolProfile'
import { SUBAGENT_MODEL_TIERS } from './types'
import {
  CHILD_ARCHIVE_EVENT_PAYLOAD_VERSION,
  createChildFinishedArchivePayload,
  createChildStartedArchivePayload,
  decodeChildFinishedArchivePayload,
  decodeChildStartedArchivePayload,
} from './archiveEventPayload'

describe('child archive event payload codec', () => {
  it.each(SUBAGENT_MODEL_TIERS)('round-trips canonical model tier %s', (modelTier) => {
    const started = createChildStartedArchivePayload({ objective: 'verify archive', modelTier })
    const finished = createChildFinishedArchivePayload({
      status: 'done',
      objective: 'verify archive',
      summary: 'verified',
      skillFiles: [],
      skillIds: [],
      changeSets: [],
      modelTier,
    })

    expect(decodeChildStartedArchivePayload(started)?.modelTier).toBe(modelTier)
    expect(decodeChildFinishedArchivePayload(finished)?.modelTier).toBe(modelTier)
  })

  it.each(SUBAGENT_TOOL_PROFILES)('round-trips canonical tool profile %s', (toolProfile) => {
    const payload = createChildStartedArchivePayload({ objective: 'verify archive', toolProfile })

    expect(decodeChildStartedArchivePayload(payload)?.toolProfile).toBe(toolProfile)
  })

  it.each(DELEGATABLE_DANGEROUS_TOOLS)('round-trips canonical confirmed tool %s', (confirmedTool) => {
    const payload = createChildStartedArchivePayload({
      objective: 'verify archive',
      confirmedTools: [confirmedTool],
    })

    expect(decodeChildStartedArchivePayload(payload)?.confirmedTools).toEqual([confirmedTool])
  })

  it.each([
    ['modelTier', 'unknown_tier'],
    ['toolProfile', 'unknown_profile'],
    ['confirmedTools', ['read_file']],
  ])('fails closed for unknown versioned %s capability values', (field, value) => {
    const payload = {
      child_payload_version: CHILD_ARCHIVE_EVENT_PAYLOAD_VERSION,
      objective: 'verify archive',
      [field as string]: value,
    }

    expect(decodeChildStartedArchivePayload(payload)).toBeUndefined()
  })

  it('rejects unknown versions and unknown versioned finished tiers', () => {
    expect(decodeChildStartedArchivePayload({
      child_payload_version: 2,
      objective: 'future archive',
    })).toBeUndefined()
    expect(decodeChildFinishedArchivePayload({
      child_payload_version: 2,
      status: 'done',
    })).toBeUndefined()
    expect(decodeChildFinishedArchivePayload({
      child_payload_version: CHILD_ARCHIVE_EVENT_PAYLOAD_VERSION,
      status: 'done',
      objective: 'verify archive',
      summary: 'verified',
      skillFiles: [],
      skillIds: [],
      changeSets: [],
      modelTier: 'unknown_tier',
    })).toBeUndefined()
  })

  it('preserves permissive legacy started and finished decoding', () => {
    expect(decodeChildStartedArchivePayload({
      objective: 'legacy archive',
      modelTier: 'unknown_tier',
      toolProfile: 'unknown_profile',
      confirmedTools: ['read_file'],
    })).toEqual({ objective: 'legacy archive' })
    expect(decodeChildFinishedArchivePayload({
      status: 'failed',
      objective: 'legacy archive',
      summary: 'legacy failure',
      modelTier: 'unknown_tier',
      error: 'failed',
    })).toEqual({
      status: 'failed',
      objective: 'legacy archive',
      summary: 'legacy failure',
      error: 'failed',
    })
  })
})
