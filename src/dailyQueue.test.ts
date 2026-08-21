import { describe, expect, it } from 'vitest'
import { dropSettled, enqueue, type PendingSubmission } from './dailyQueue'

const item = (over: Partial<PendingSubmission> = {}): PendingSubmission => ({
  event: '333', day: '2026-08-20', timeMs: 12000, penalty: 'none', ...over,
})

describe('enqueue', () => {
  it('adds a submission', () => {
    expect(enqueue([], item())).toHaveLength(1)
  })

  it('never queues two submissions for the same event and day', () => {
    // One attempt means one result: a second entry could only ever be
    // rejected by the server, and would retry forever.
    const queue = enqueue([item({ timeMs: 12000 })], item({ timeMs: 9000 }))
    expect(queue).toHaveLength(1)
    expect(queue[0].timeMs).toBe(12000)
  })

  it('keeps submissions for different events and different days apart', () => {
    let queue = enqueue([], item({ event: '333' }))
    queue = enqueue(queue, item({ event: '444' }))
    queue = enqueue(queue, item({ event: '333', day: '2026-08-21' }))
    expect(queue).toHaveLength(3)
  })
})

describe('dropSettled', () => {
  it('removes the entry once the server has it', () => {
    const queue = enqueue([], item())
    expect(dropSettled(queue, '333', '2026-08-20')).toHaveLength(0)
  })

  it('leaves other entries alone', () => {
    let queue = enqueue([], item({ event: '333' }))
    queue = enqueue(queue, item({ event: '444' }))
    expect(dropSettled(queue, '333', '2026-08-20').map((q) => q.event)).toEqual(['444'])
  })

  it('is safe to call for something not queued', () => {
    expect(dropSettled([], '333', '2026-08-20')).toEqual([])
  })
})
