// Which frame a tick shows, and whether the clip is over.
//
// 'ticks'  one frame per timer tick: smooth, but late ticks stretch the clip
// 'wall'   the frame the clock says is due: exact, skips frames when ticks lag
// 'hybrid' one frame per tick, jumping to the due frame once it falls more
//          than maxLagMs behind, so a busy turn can't stretch a clip

export const TIMINGS = ['hybrid', 'ticks', 'wall']
export const MAX_LAG_MS = 250

export function step({ timing, shown, elapsedMs, fps, frames, durationMs, maxLagMs = MAX_LAG_MS }) {
  // A still image (or a clip with one frame) just runs for its duration
  if (frames <= 1) return { frame: 0, isOver: elapsedMs >= durationMs, skipped: 0 }

  const due = Math.floor((elapsedMs * fps) / 1000)
  let next
  if (timing === 'wall') {
    next = due
  } else {
    next = shown + 1
    if (timing === 'hybrid' && ((due - next) * 1000) / fps > maxLagMs) next = due
  }
  const isOver = timing === 'wall' ? elapsedMs >= durationMs : next >= frames
  const frame = Math.min(Math.max(next, 0), frames - 1)
  return { frame, isOver, skipped: Math.max(0, frame - shown - 1) }
}
