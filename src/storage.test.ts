import { beforeEach, describe, expect, it } from 'vitest'
import { deleteSession, loadStore } from './storage'

const mem = new Map<string, string>()

beforeEach(() => {
  mem.clear()
  // A localStorage stand-in; jsdom is not needed for what these cover.
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage
})

const seed = (sessions: unknown[], solves: unknown[]) => {
  mem.set('cube-timer.sessions.v1', JSON.stringify(sessions))
  mem.set('cube-timer.solves.v2', JSON.stringify(solves))
}

describe('loadStore', () => {
  it('creates one session on a fresh install', () => {
    const store = loadStore()
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0].event).toBe('333')
    expect(store.activeId).toBe(store.sessions[0].id)
  })

  it('migrates pre-session data into one session per event', () => {
    mem.set(
      'cube-timer.solves.v1',
      JSON.stringify([
        { id: 'a', event: '444', scramble: 'R', timeMs: 50000, penalty: 'none', createdAt: 3 },
        { id: 'b', event: '333', scramble: 'F', timeMs: 12000, penalty: 'plus2', createdAt: 2 },
        { id: 'c', event: '333', scramble: 'L', timeMs: 11000, penalty: 'none', createdAt: 1 },
      ]),
    )
    const store = loadStore()
    expect(store.sessions.map((s) => s.event)).toEqual(['333', '444'])
    expect(store.solves.every((s) => s.sessionId)).toBe(true)
    expect(store.solves.every((s) => s.scramble.length > 0)).toBe(true)
  })

  it('stamps rows stored before sync fields existed', () => {
    seed(
      [{ id: 's1', name: '3x3', event: '333', createdAt: 500 }],
      [{ id: 'y', sessionId: 's1', scramble: '', timeMs: 9000, penalty: 'none', createdAt: 700 }],
    )
    const store = loadStore()
    // createdAt is truthful as updatedAt: creation was the last change.
    expect(store.sessions[0].updatedAt).toBe(500)
    expect(store.solves[0].updatedAt).toBe(700)
  })

  it('recovers from an active id pointing at a session that is gone', () => {
    seed([{ id: 's1', name: 'a', event: '333', createdAt: 1, updatedAt: 1 }], [])
    mem.set('cube-timer.active-session.v1', 'missing')
    expect(loadStore().activeId).toBe('s1')
  })
})

describe('deleteSession', () => {
  const two = () => {
    seed(
      [
        { id: 's1', name: 'a', event: '333', createdAt: 1, updatedAt: 1 },
        { id: 's2', name: 'b', event: '222', createdAt: 2, updatedAt: 2 },
      ],
      [
        { id: 'p', sessionId: 's1', scramble: '', timeMs: 1000, penalty: 'none', createdAt: 3, updatedAt: 3 },
        { id: 'q', sessionId: 's2', scramble: '', timeMs: 2000, penalty: 'none', createdAt: 4, updatedAt: 4 },
      ],
    )
    return loadStore()
  }

  it('tombstones the session and its solves rather than removing them', () => {
    const after = deleteSession(two(), 's1')
    expect(after.sessions).toHaveLength(2)
    expect(after.sessions.find((s) => s.id === 's1')!.deleted).toBe(true)
    expect(after.solves.find((s) => s.id === 'p')!.deleted).toBe(true)
    expect(after.solves.find((s) => s.id === 'q')!.deleted).toBeUndefined()
  })

  it('bumps updatedAt so the delete wins reconciliation', () => {
    const after = deleteSession(two(), 's1')
    expect(after.sessions.find((s) => s.id === 's1')!.updatedAt).toBeGreaterThan(1)
  })

  it('moves the active session off the deleted one', () => {
    expect(deleteSession(two(), 's1').activeId).toBe('s2')
  })

  it('refuses to delete the last live session', () => {
    const after = deleteSession(deleteSession(two(), 's1'), 's2')
    expect(after.sessions.filter((s) => !s.deleted)).toHaveLength(1)
  })
})
