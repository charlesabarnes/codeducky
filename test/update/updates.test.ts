import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_HEADER, isBuildId } from '../../shared/clientVersion'
import { apiRequest, HttpError } from '../../src/sync/api'
import { CLIENT_BUILD, reportIfOutdated } from '../../src/update/handshake'
import { UpdateController, updates, type WorkerControl } from '../../src/update/updates'

function controller({ waiting = false, lastForcedReload = null as number | null, now = 1_000_000 } = {}) {
  const reload = vi.fn()
  const markForcedReload = vi.fn()
  const worker: WorkerControl = { check: vi.fn(async () => waiting), activate: vi.fn(async () => undefined) }
  const updater = new UpdateController({ reload, lastForcedReload: () => lastForcedReload, markForcedReload, now: () => now })
  updater.attach(worker)
  return { updater, worker, reload, markForcedReload }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('UpdateController', () => {
  it('offers a waiting version and activates it on reload', async () => {
    const { updater, worker, reload } = controller()
    updater.needRefresh()
    expect(updater.getSnapshot()).toEqual({ available: true, required: null, updating: false })
    await updater.apply()
    expect(worker.activate).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
    expect(updater.getSnapshot().updating).toBe(true)
  })

  it('on 426 activates a new version the server has', async () => {
    const { updater, worker, reload } = controller({ waiting: true })
    updater.clientOutdated('20261004120000')
    await settle()
    expect(updater.getSnapshot().required).toBe('20261004120000')
    expect(worker.check).toHaveBeenCalledOnce()
    expect(worker.activate).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
    updater.needRefresh()
    await settle()
    expect(worker.activate).toHaveBeenCalledOnce()
  })

  it('on 426 uses an already waiting version without checking', async () => {
    const { updater, worker } = controller()
    updater.needRefresh()
    updater.clientOutdated('m')
    await settle()
    expect(worker.check).not.toHaveBeenCalled()
    expect(worker.activate).toHaveBeenCalledOnce()
  })

  it('on 426 without a new worker reloads once, then waits for the user', async () => {
    const first = controller()
    first.updater.clientOutdated('m')
    await settle()
    expect(first.markForcedReload).toHaveBeenCalledWith(1_000_000)
    expect(first.reload).toHaveBeenCalledOnce()

    const looping = controller({ lastForcedReload: 1_000_000 - 60_000 })
    looping.updater.clientOutdated('m')
    await settle()
    expect(looping.reload).not.toHaveBeenCalled()
    expect(looping.updater.getSnapshot()).toMatchObject({ required: 'm', updating: false })
    await looping.updater.apply()
    expect(looping.reload).toHaveBeenCalledOnce()
  })

  it('ignores repeated 426s', async () => {
    const { updater, worker } = controller({ waiting: true })
    updater.clientOutdated('m')
    updater.clientOutdated('m')
    await settle()
    expect(worker.check).toHaveBeenCalledOnce()
  })

  it('lets the user retry when activation fails', async () => {
    const { updater, worker } = controller()
    vi.mocked(worker.activate).mockRejectedValueOnce(new Error('gone'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    updater.needRefresh()
    await updater.apply()
    expect(updater.getSnapshot().updating).toBe(false)
    await updater.apply()
    expect(worker.activate).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })
})

describe('client build handshake', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends the build id on API requests', async () => {
    expect(isBuildId(CLIENT_BUILD)).toBe(true)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }))
    await apiRequest({ baseUrl: '', fetch: fetch as typeof globalThis.fetch }, 'GET', '/api/auth/tokens', { token: 't' })
    const headers = fetch.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers[CLIENT_HEADER]).toBe(CLIENT_BUILD)
    expect(headers.Authorization).toBe('Bearer t')
  })

  it('turns a 426 into an update required state', async () => {
    const outdated = vi.spyOn(updates, 'clientOutdated').mockImplementation(() => undefined)
    const fetch = (async () => Response.json({ error: 'client_outdated', minimum: '20300101000000' }, { status: 426 })) as typeof globalThis.fetch
    const failure = await apiRequest({ baseUrl: '', fetch }, 'POST', '/api/sync', { body: {} }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HttpError)
    expect(failure).toMatchObject({ status: 426, code: 'client_outdated' })
    expect(outdated).toHaveBeenCalledWith('20300101000000')
  })

  it('leaves other errors alone', async () => {
    const outdated = vi.spyOn(updates, 'clientOutdated').mockImplementation(() => undefined)
    const fetch = (async () => Response.json({ error: 'nope' }, { status: 400 })) as typeof globalThis.fetch
    await expect(apiRequest({ baseUrl: '', fetch }, 'GET', '/api/x')).rejects.toBeInstanceOf(HttpError)
    expect(outdated).not.toHaveBeenCalled()
  })

  it('reports a 426 even without the expected body', () => {
    const report = { clientOutdated: vi.fn() } as unknown as UpdateController
    expect(reportIfOutdated(426, null, report)).toBe(true)
    expect(report.clientOutdated).toHaveBeenCalledWith('')
    expect(reportIfOutdated(500, { error: 'client_outdated' }, report)).toBe(false)
  })
})
