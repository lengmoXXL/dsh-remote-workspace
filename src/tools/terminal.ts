/**
 * The one model-facing terminal tool.
 *
 * The tool drives the same shells the sidebar's terminal tabs hold.
 * Interrupting a foreground command is a keystroke (`ctrl+c`), which is how a
 * person does it too.
 *
 * One tool carries every operation, dispatched by `action`. A part of the
 * contract is which parameters belong to which action: sending `text` with
 * `action: "read"` is a caller mistake the tool reports instead of quietly
 * ignoring, because a silently dropped parameter is how a model learns the
 * wrong tool.
 *
 * Authorization is the calling Session, read from the tool run context and
 * never from an argument. A model cannot name a Session, so it cannot reach
 * another Session's terminal even by guessing an id; the registry's ownership
 * check sees the guessed id as unknown.
 *
 * @module dsh-remote-workspace/tools/terminal
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TerminalRegistryError, type TerminalRead, type TerminalRegistry, type TerminalView, type TerminalWait } from '../terminal/host/registry.ts'

/** The one tool's actions, in the order the description lists them. */
const ACTIONS = ['list', 'read', 'send', 'keys', 'wait'] as const

/** One of the tool's actions. */
type Action = (typeof ACTIONS)[number]

/**
 * Which actions each optional parameter belongs to.
 *
 * This table is the whole per-action contract: a parameter present in a call
 * whose action is not in its list is refused, and no action handler has to
 * re-state the rule.
 */
const PARAM_ACTIONS: Readonly<Record<string, readonly Action[]>> = {
  terminal: ['read', 'send', 'keys', 'wait'],
  text: ['send'],
  enter: ['send'],
  keys: ['keys'],
  lines: ['read'],
  offset: ['read', 'wait'],
  match: ['wait'],
  regex: ['wait'],
  timeoutMs: ['wait'],
}

/** One terminal's canonical value, the shape `list` returns. */
interface TerminalListValue {
  readonly terminals: TerminalView[]
}

/** One write's canonical value, the shape `send` and `keys` return. */
interface TerminalWriteValue {
  readonly id: string
  readonly wrote: { readonly bytes: number; readonly keys: number }
}

type TerminalValue = TerminalListValue | TerminalRead | TerminalWriteValue | TerminalWait

/** The canonical schemas, one branch per distinct return shape. */
const TERMINAL_VALUE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminals: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              label: { type: 'string', required: true },
              cwd: { type: 'string', required: true },
              machine: { type: 'string', required: true },
              pid: { type: 'number', required: true },
              state: { type: 'string', required: true, enum: ['running', 'detached', 'exited'] },
              cols: { type: 'number', required: true },
              rows: { type: 'number', required: true },
            },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        offset: { type: 'number', required: true },
        text: { type: 'string', required: true },
        truncated: { type: 'boolean', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        wrote: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            bytes: { type: 'number', required: true },
            keys: { type: 'number', required: true },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        offset: { type: 'number', required: true },
        text: { type: 'string', required: true },
        matched: { type: 'boolean', required: true },
        reason: { type: 'string', required: true, enum: ['match', 'exit', 'timeout'] },
      },
    },
  ],
} as const

/**
 * Render one page of a terminal's output with the offset that resumes after it.
 *
 * The model sees only this text, so the resumable offset is part of it: that is
 * what lets a caller chain a wait after a read without guessing.
 * @param id - the terminal.
 * @param offset - the absolute byte offset just past `text`.
 * @param text - the page's text, possibly empty.
 * @param label - what the page is: a wait reason, `truncated`, `no output`, or nothing.
 * @returns the model-facing text.
 */
function renderPage(id: string, offset: number, text: string, label = ''): string {
  const marker = `[${id}${label === '' ? '' : ` ${label}`} offset ${String(offset)}]`
  return text === '' ? marker : `${marker}\n${text}`
}

/**
 * Render one canonical value for the model.
 *
 * A read and a wait answer with the terminal's own text under a marker that
 * carries what the page is and the offset that resumes after it; the other
 * actions say what they did in one line.
 * @param value - the canonical value the body returned.
 * @returns the model-facing text.
 */
function renderValue(value: TerminalValue): string {
  if ('terminals' in value) {
    if (value.terminals.length === 0) return 'No terminal is open in this session.'
    return value.terminals
      .map(terminal => `${terminal.id} (${terminal.label}) ${terminal.state} · ${terminal.cwd} · ${terminal.machine}`)
      .join('\n')
  }
  if ('wrote' in value) {
    return value.wrote.keys === 0
      ? `Wrote ${String(value.wrote.bytes)} byte(s) to ${value.id}.`
      : `Sent ${String(value.wrote.keys)} key(s) to ${value.id}.`
  }
  if ('matched' in value) return renderPage(value.id, value.offset, value.text, value.reason)
  return renderPage(
    value.id,
    value.offset,
    value.text,
    value.text === '' ? 'no output' : value.truncated ? 'truncated' : '',
  )
}

/**
 * Refuse a parameter that belongs to another action.
 * @param args - the validated, frozen model arguments.
 * @param action - the action being executed.
 * @throws TerminalRegistryError naming the parameter and the action that owns it.
 */
function rejectForeign(args: Record<string, unknown>, action: Action): void {
  for (const [name, allowed] of Object.entries(PARAM_ACTIONS)) {
    if (args[name] === undefined || allowed.includes(action)) continue
    throw new TerminalRegistryError(
      `"${name}" is valid only with action ${allowed.join(' or ')}, not "${action}"`,
    )
  }
}

/**
 * Register the terminal tool on the host plane.
 *
 * A profile with no tool runtime is not a failure: the terminal socket and the
 * sidebar still work, and the model simply has no way to drive a shell.
 * @param ctx - the host context.
 * @param registry - the terminals a person's tabs have open.
 */
export function registerTerminalTool(ctx: Context, registry: TerminalRegistry): void {
  const tools = ctx.get('tools')
  if (tools === undefined) return

  tools.register(defineTool({
    name: 'terminal',
    description: 'Work with the terminals a person has open in the sidebar: read their output, type into them, send named keys, and wait for output. This is one terminal tool with an "action"; the other parameters apply only to the actions named in their descriptions. It never opens a terminal — a person opening a sidebar tab does that — and it never closes one: a shell is ended from the list a person picks one in, not from a tool call. A terminal whose tab lost its connection without closing is "detached": it stays addressable until it is closed, its process exits, or its session ends. Use "list" to see what is open, "read" for recent output, "send" to run a command ("enter" defaults to true), "keys" for named keys such as ctrl+c, and "wait" to search the recent output and settle when it matches or the command exits.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ACTIONS,
        description: 'list | read | send | keys | wait',
      },
      terminal: {
        type: 'string',
        description: 'Terminal id from list. Required when more than one terminal is open in this session; omit it when exactly one is.',
      },
      text: {
        type: 'string',
        description: 'Literal text to type; valid only with action send.',
      },
      enter: {
        type: 'boolean',
        description: 'Append a carriage return after text; defaults to true. Valid only with action send.',
      },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Logical key names (enter, esc, tab, backspace, up, down, left, right, ctrl+a…ctrl+z); valid only with action keys. Every name is checked before anything is written.',
      },
      lines: {
        type: 'number',
        description: 'Tail line count to read, default 200, max 2000; valid only with action read.',
      },
      offset: {
        type: 'number',
        description: 'Absolute byte offset to read or wait from. Omitted reads the tail, and starts a wait at the beginning of that same retained tail, so output that already arrived can match. Valid with read and wait; the render carries the offset that resumes after it.',
      },
      match: {
        type: 'string',
        description: 'Plain text to wait for; pass exactly one of match and regex. Valid only with action wait.',
      },
      regex: {
        type: 'string',
        description: 'Regular expression source to wait for; pass exactly one of match and regex. Valid only with action wait.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Wait budget in milliseconds, default 30000, max 300000. A timeout returns reason "timeout" instead of failing. Valid only with action wait.',
      },
    },
    output: {
      schema: TERMINAL_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderValue(value as TerminalValue) }],
    },
    async execute(args, exec): Promise<TerminalValue> {
      // The calling Session is the authorization: the run context's Agent
      // carries it, and the model has no parameter that could name another.
      if (exec.agent === undefined) {
        throw new TerminalRegistryError('the terminal tool requires an Agent Session')
      }
      const sessionId = String(exec.agent.id)
      const action = args.action
      const raw = args as unknown as Record<string, unknown>
      rejectForeign(raw, action)

      if (action === 'list') return { terminals: registry.listFor(sessionId) }

      const entry = registry.requireOwned(sessionId, args.terminal)

      if (action === 'read') return registry.read(entry.id, args.offset, args.lines)

      if (action === 'send') {
        if (args.text === undefined) {
          throw new TerminalRegistryError('send requires "text"')
        }
        // Text and its carriage return are one write, so a line cannot arrive
        // interleaved with another caller's bytes.
        const payload = args.enter === false ? args.text : `${args.text}\r`
        const bytes = await registry.write(entry.id, payload)
        return { id: entry.id, wrote: { bytes, keys: 0 } }
      }

      if (action === 'keys') {
        if (args.keys === undefined || args.keys.length === 0) {
          throw new TerminalRegistryError('keys requires a non-empty "keys" array')
        }
        return { id: entry.id, wrote: await registry.keys(entry.id, args.keys) }
      }

      if ((args.match === undefined) === (args.regex === undefined)) {
        throw new TerminalRegistryError(args.match === undefined
          ? 'wait requires exactly one of "match" and "regex"'
          : 'wait accepts only one of "match" and "regex"')
      }
      const request = {
        ...args.offset === undefined ? {} : { offset: args.offset },
        ...args.match === undefined ? {} : { match: args.match },
        ...args.regex === undefined ? {} : { regex: args.regex },
        ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
      }
      return await registry.wait(entry.id, request, exec.signal)
    },
  }))
}
