import { wrap, type Remote } from 'comlink'
import type { GitService } from './service'

let service: Remote<GitService> | null = null

export function gitService(): Remote<GitService> {
  service ??= wrap<GitService>(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'git' }))
  return service
}
