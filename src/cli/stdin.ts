/** Read piped standard input completely (for --key-stdin and `secret set`). */
import type { ReadableLike } from './output'

/** Collect all of stdin as UTF-8 text. Resolves to '' when stdin is a terminal. */
export function readAllStdin(stdin: ReadableLike, maxBytes = 1024 * 1024): Promise<string> {
  if (stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buf.length
      if (size > maxBytes) {
        cleanup()
        reject(new Error('The input is too large.'))
        return
      }
      chunks.push(buf)
    }
    const onEnd = (): void => {
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const cleanup = (): void => {
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      stdin.removeListener('error', onError)
    }
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.once('error', onError)
    stdin.resume()
  })
}
