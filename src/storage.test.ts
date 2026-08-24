import { beforeEach, describe, expect, it } from 'vitest'
import { activeSessionOf, commitDraft, deleteSession, loadStore } from './storage'
import type { Session, Solve } from './types'

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
  it('starts a fresh install with no session, on 3x3', () => {
    // No session is written until the first solve commits a draft: creating
    // one up front would sync an empty log to every other device.
    const store = loadStore()
    expect(store.sessions).toHaveLength(0)
    expect(store.activeDiscipline).toBe('333')
    expect(store.activeByDiscipline).toEqual({})
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
    expect(store.sessions.map((s) => s.discipline)).toEqual(['333', '444'])
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

  it('moves a pre-discipline session onto its event as a discipline key', () => {
    // The old `event` value is already a valid single-event key, so the
    // migration only moves the field -- nothing is rewritten.
    seed([{ id: 's1', name: 'a', event: '444', createdAt: 1, updatedAt: 1 }], [])
    expect(loadStore().sessions[0].discipline).toBe('444')
  })

  it('migrates the single old active id into a per-discipline pointer', () => {
    seed(
      [
        { id: 's1', name: 'a', event: '333', createdAt: 1, updatedAt: 1 },
        { id: 's2', name: 'b', event: '444', createdAt: 2, updatedAt: 2 },
      ],
      [],
    )
    mem.set('cube-timer.active-session.v1', 's2')
    const store = loadStore()
    expect(store.activeDiscipline).toBe('444')
    expect(store.activeByDiscipline).toEqual({ '444': 's2' })
  })

  it('recovers from an old active id pointing at a session that is gone', () => {
    seed([{ id: 's1', name: 'a', event: '333', createdAt: 1, updatedAt: 1 }], [])
    mem.set('cube-timer.active-session.v1', 'missing')
    const store = loadStore()
    expect(store.activeDiscipline).toBe('333')
    expect(activeSessionOf(store, '333')!.id).toBe('s1')
  })

  it('prefers stored discipline pointers over the legacy one', () => {
    seed(
      [
        { id: 's1', name: 'a', discipline: '333', createdAt: 1, updatedAt: 1 },
        { id: 's2', name: 'b', discipline: '222', createdAt: 2, updatedAt: 2 },
      ],
      [],
    )
    mem.set('cube-timer.active-session.v1', 's1')
    mem.set('cube-timer.active-discipline.v1', '222')
    mem.set('cube-timer.active-by-discipline.v1', JSON.stringify({ '222': 's2' }))
    expect(loadStore().activeDiscipline).toBe('222')
  })
})

describe('activeSessionOf', () => {
  const store = () => {
    seed(
      [
        { id: 's1', name: 'a', discipline: '333', createdAt: 1, updatedAt: 1 },
        { id: 's2', name: 'b', discipline: '333', createdAt: 2, updatedAt: 2 },
        { id: 's3', name: 'c', discipline: '444', createdAt: 3, updatedAt: 3 },
      ],
      [],
    )
    return loadStore()
  }

  it('restores the remembered session for that discipline', () => {
    const s = { ...store(), activeByDiscipline: { '333': 's2' } }
    expect(activeSessionOf(s, '333')!.id).toBe('s2')
  })

  it('falls back when the remembered id is not a live session of it', () => {
    // 's3' is a real session -- of a DIFFERENT discipline. Returning it would
    // time 4x4 solves into a 3x3 log.
    const s = { ...store(), activeByDiscipline: { '333': 's3' } }
    expect(activeSessionOf(s, '333')!.id).toBe('s1')
  })

  it('is undefined for a discipline with no sessions, so a draft takes over', () => {
    expect(activeSessionOf(store(), '555')).toBeUndefined()
  })
})

describe('commitDraft', () => {
  const draft: Session = {
    id: 'd1', name: '5x5 - Aug 24', discipline: '555', createdAt: 9, updatedAt: 9,
  }
  const solve: Solve = {
    id: 'v1', sessionId: 'd1', scramble: 'R', timeMs: 90000,
    penalty: 'none', createdAt: 9, updatedAt: 9,
  }

  it('writes the session and its first solve together', () => {
    seed([], [])
    const after = commitDraft(loadStore(), draft, solve)
    expect(after.sessions.map((s) => s.id)).toEqual(['d1'])
    expect(after.solves.map((s) => s.id)).toEqual(['v1'])
    expect(after.solves[0].sessionId).toBe(after.sessions[0].id)
  })

  it('makes the committed session the active one for its discipline', () => {
    seed([], [])
    const after = commitDraft(loadStore(), draft, solve)
    expect(after.activeDiscipline).toBe('555')
    expect(activeSessionOf(after, '555')!.id).toBe('d1')
  })
})

describe('deleteSession', () => {
  const two = () => {
    seed(
      [
        { id: 's1', name: 'a', discipline: '333', createdAt: 1, updatedAt: 1 },
        { id: 's2', name: 'b', discipline: '333', createdAt: 2, updatedAt: 2 },
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

  it('moves the pointer to another session of the same discipline', () => {
    const start = { ...two(), activeByDiscipline: { '333': 's1' } }
    expect(deleteSession(start, 's1').activeByDiscipline).toEqual({ '333': 's2' })
  })

  it('drops the pointer when the discipline has no session left', () => {
    // No longer refused: a draft takes over, so there is always somewhere to
    // time into and no "last session" rule to explain.
    const after = deleteSession(deleteSession(two(), 's1'), 's2')
    expect(after.sessions.filter((s) => !s.deleted)).toHaveLength(0)
    expect(after.activeByDiscipline).toEqual({})
  })
})
