import { createHash } from 'crypto'
import { isDocumentsRelpath } from '../paths'
import { capLength, MAX_METADATA_TEXT } from '../textLimits'
import type { PlannedKindleCollection } from './plan'

/**
 * The files the app and the on-device component exchange under
 * `<Kindle>/kindle-organizer/` (see docs/superpowers/specs/2026-11-01-kindle-collections-sync-design.md).
 *
 *   desired.json   app → device: the collections the Kindle should hold
 *   desired.ready  app → device: sha256 of desired.json, written last, so a
 *                  half-written desired.json is never applied
 *   export.json    device → app: the Kindle's collections after each run
 *   status.json    device → app: how the last run went
 *
 * What the device writes is untrusted input: anything that does not match the
 * schema below is rejected whole (`null`), never half-used.
 */

export const SYNC_SCHEMA_VERSION = 1

/** `hold` until the first-sync question is answered; `mirror` applies the collections. */
export type SyncMode = 'hold' | 'mirror'

/** More collections than this is not a real Kindle; the file is refused. */
export const MAX_SYNC_COLLECTIONS = 5000
/** Most member relpaths a device file may list in total. */
export const MAX_SYNC_MEMBERS = 100_000
const MAX_ERROR_TEXT = 1000

export interface DeviceExportCollection {
  name: string
  /** Members that are files under `documents/`, as relpaths. */
  members: string[]
  /** Members with no file under `documents/` (Amazon/cloud items). */
  otherMembers: number
}

export interface DeviceExport {
  schema: typeof SYNC_SCHEMA_VERSION
  collections: DeviceExportCollection[]
}

export type DeviceRunResult = 'installed' | 'ok' | 'partial' | 'error'

export interface DeviceStatus {
  schema: typeof SYNC_SCHEMA_VERSION
  deviceId: string
  componentVersion: string
  /** ISO-8601. */
  finishedAt: string
  result: DeviceRunResult
  created: number
  updated: number
  deleted: number
  /** Desired books the firmware had not indexed yet (retried next unplug). */
  pendingBooks: string[]
  error?: string
}

// ─── App → device ───────────────────────────────────────────────────────────

export function serializeDesired(plan: readonly PlannedKindleCollection[], mode: SyncMode): string {
  const body = {
    schema: SYNC_SCHEMA_VERSION,
    mode,
    collections: plan.map((collection) => ({ name: collection.name, members: collection.relpaths }))
  }
  return `${JSON.stringify(body)}\n`
}

export function desiredReadyMarker(desiredText: string): string {
  return `${createHash('sha256').update(desiredText, 'utf8').digest('hex')}\n`
}

// ─── Device → app ───────────────────────────────────────────────────────────

const RUN_RESULTS: readonly DeviceRunResult[] = ['installed', 'ok', 'partial', 'error']
const DEVICE_ID = /^[A-Za-z0-9-]{1,64}$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isRelpathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_SYNC_MEMBERS && value.every((v) => typeof v === 'string' && isDocumentsRelpath(v))
}

function parseExportCollection(value: unknown): DeviceExportCollection | null {
  const rec = asRecord(value)
  if (!rec || typeof rec.name !== 'string' || !isRelpathList(rec.members) || !isCount(rec.otherMembers)) return null
  const name = capLength(rec.name.trim(), MAX_METADATA_TEXT)
  if (!name) return null
  return { name, members: [...rec.members], otherMembers: rec.otherMembers }
}

export function parseDeviceExport(raw: unknown): DeviceExport | null {
  const rec = asRecord(raw)
  if (!rec || rec.schema !== SYNC_SCHEMA_VERSION || !Array.isArray(rec.collections)) return null
  if (rec.collections.length > MAX_SYNC_COLLECTIONS) return null

  const collections = rec.collections.map(parseExportCollection)
  if (collections.some((collection) => collection === null)) return null
  const valid = collections as DeviceExportCollection[]
  if (valid.reduce((sum, collection) => sum + collection.members.length, 0) > MAX_SYNC_MEMBERS) return null
  return { schema: SYNC_SCHEMA_VERSION, collections: valid }
}

function hasValidIdentity(rec: Record<string, unknown>): boolean {
  return (
    typeof rec.deviceId === 'string' &&
    DEVICE_ID.test(rec.deviceId) &&
    typeof rec.componentVersion === 'string' &&
    VERSION.test(rec.componentVersion) &&
    typeof rec.finishedAt === 'string' &&
    !Number.isNaN(Date.parse(rec.finishedAt))
  )
}

function hasValidOutcome(rec: Record<string, unknown>): boolean {
  return (
    RUN_RESULTS.includes(rec.result as DeviceRunResult) &&
    isCount(rec.created) &&
    isCount(rec.updated) &&
    isCount(rec.deleted) &&
    isRelpathList(rec.pendingBooks) &&
    (rec.error === undefined || typeof rec.error === 'string')
  )
}

export function parseDeviceStatus(raw: unknown): DeviceStatus | null {
  const rec = asRecord(raw)
  if (!rec || rec.schema !== SYNC_SCHEMA_VERSION || !hasValidIdentity(rec) || !hasValidOutcome(rec)) return null

  const status: DeviceStatus = {
    schema: SYNC_SCHEMA_VERSION,
    deviceId: rec.deviceId as string,
    componentVersion: rec.componentVersion as string,
    finishedAt: rec.finishedAt as string,
    result: rec.result as DeviceRunResult,
    created: rec.created as number,
    updated: rec.updated as number,
    deleted: rec.deleted as number,
    pendingBooks: [...(rec.pendingBooks as string[])]
  }
  return typeof rec.error === 'string' ? { ...status, error: capLength(rec.error, MAX_ERROR_TEXT) } : status
}
