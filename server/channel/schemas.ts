import { z } from 'zod'
import {
  MAX_NOTE_EXCERPT,
  MAX_TASK_MESSAGE,
  MAX_TASK_NOTES,
  PERMISSION_REQUEST_ID,
  REPORTED_STATES,
  TASK_KINDS,
} from '../../shared/channel'

/** Control characters other than tab and newline: kept out of anything shown in the PWA or put in a prompt. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

const text = (max: number) => z.string().max(max).refine((value) => !CONTROL.test(value), 'control characters')
const line = (max: number) => text(max).refine((value) => !/[\r\n]/.test(value), 'line breaks')
/** Untrusted display text from Claude Code; longer values are cut rather than refused. */
const display = (max: number) => z.string().transform((value) => value.replace(new RegExp(CONTROL, 'g'), '').slice(0, max))

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const repo = z.string().max(201).regex(REPO)
const branch = line(255).min(1)

export const registrationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  label: line(100).min(1),
  cwd: line(1024),
  repo: repo.nullable(),
  branch: branch.nullable(),
  hostname: line(255),
  pluginVersion: line(32),
})

export const pluginEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delivered'), taskId: z.uuid() }),
  z.object({ type: z.literal('status'), taskId: z.uuid(), state: z.enum(REPORTED_STATES), message: text(2000).optional() }),
  z.object({
    type: z.literal('permission_request'),
    requestId: z.string().regex(PERMISSION_REQUEST_ID),
    toolName: line(200).min(1),
    description: display(4000),
    inputPreview: display(20_000),
  }),
  z.object({ type: z.literal('update'), branch: branch.nullable().optional(), label: line(100).min(1).optional() }),
])

const note = z.object({
  id: line(100).min(1),
  path: line(1024).min(1),
  line: z.number().int().min(0),
  severity: z.enum(['nit', 'suggestion', 'issue', 'blocker']),
  title: line(200).optional(),
  body: z.string().transform((value) => value.slice(0, MAX_NOTE_EXCERPT * 2)),
})

export const taskRequestSchema = z
  .object({
    kind: z.enum(TASK_KINDS),
    target: z.object({
      repo,
      branch: branch.optional(),
      pr: z.number().int().min(1).optional(),
      sessionId: line(100).min(1).optional(),
    }),
    message: text(MAX_TASK_MESSAGE).optional(),
    notes: z.array(note).max(MAX_TASK_NOTES).optional(),
  })
  .refine((task) => task.target.branch !== undefined || task.target.pr !== undefined, 'a branch or a pull request')
  .refine((task) => task.kind !== 'custom' || !!task.message?.trim(), 'a custom task needs a message')

export const verdictSchema = z.object({ behavior: z.enum(['allow', 'deny']) })

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> | null {
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}
