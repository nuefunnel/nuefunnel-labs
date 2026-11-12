import { expect, test } from 'claude-code/testing'
import { step } from '../hooks/player.js'

const base = { fps: 12, frames: 144, durationMs: 12000 }

test('ticks: one frame per tick, however late', () => {
  const r = step({ ...base, timing: 'ticks', shown: 10, elapsedMs: 5000 })
  expect(r).toEqual({ frame: 11, isOver: false, skipped: 0 })
})

test('hybrid: one frame per tick while within 250 ms of the clock', () => {
  // Frame 11 is due at 917 ms; 1100 ms is 2 frames (167 ms) ahead of it
  expect(step({ ...base, timing: 'hybrid', shown: 10, elapsedMs: 1100 }).frame).toBe(11)
})

test('hybrid: jumps to the due frame once more than 250 ms behind', () => {
  const r = step({ ...base, timing: 'hybrid', shown: 10, elapsedMs: 5000 })
  expect(r.frame).toBe(60)
  expect(r.skipped).toBe(49)
})

test('hybrid and ticks end after the last frame', () => {
  expect(step({ ...base, timing: 'hybrid', shown: 143, elapsedMs: 12000 }).isOver).toBe(true)
  expect(step({ ...base, timing: 'ticks', shown: 142, elapsedMs: 11900 }).isOver).toBe(false)
})

test('wall: shows the due frame and ends at the duration', () => {
  expect(step({ ...base, timing: 'wall', shown: 0, elapsedMs: 6000 }).frame).toBe(72)
  expect(step({ ...base, timing: 'wall', shown: 143, elapsedMs: 12000 }).isOver).toBe(true)
})

test('a still image runs for its duration on frame 0', () => {
  const r = step({ timing: 'hybrid', shown: 0, elapsedMs: 9000, fps: 12, frames: 1, durationMs: 10000 })
  expect(r).toEqual({ frame: 0, isOver: false, skipped: 0 })
  expect(step({ timing: 'hybrid', shown: 0, elapsedMs: 10000, fps: 12, frames: 1, durationMs: 10000 }).isOver).toBe(true)
})
