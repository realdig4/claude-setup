/** Reject when a promise takes longer than `ms` (the underlying work is not cancelled). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what = 'The check'): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.max(1, Math.round(ms / 1000))} s`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
