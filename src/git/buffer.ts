import { Buffer } from 'buffer'

const scope = globalThis as { Buffer?: unknown }
scope.Buffer ??= Buffer
