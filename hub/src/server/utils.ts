

import * as stream from 'stream'
import { DriverConstructor, DriverStatics } from './driverModel'
import S3Driver from './drivers/S3Driver'
import AzDriver from './drivers/AzDriver'
import GcDriver from './drivers/GcDriver'
import DiskDriver from './drivers/diskDriver'
import { promisify } from 'util'
import * as winston from 'winston'
import { DriverName } from './config'

import nanoid = require('nanoid/generate')

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Generates a random 10 char string using uppercase & lowercase alpha numeric alphabet.
 */
export function generateUniqueID() {
  const id = nanoid(alphabet, 10) //=> "mAB6Yps3V3"
  return id
}


export const pipelineAsync = promisify(stream.pipeline)

export const logger = winston.createLogger()

export function getDriverClass(driver: DriverName): DriverConstructor & DriverStatics {
  if (driver === 'aws') {
    return S3Driver
  } else if (driver === 'azure') {
    return AzDriver
  } else if (driver === 'disk') {
    return DiskDriver
  } else if (driver === 'google-cloud') {
    return GcDriver
  } else {
    throw new Error(`Failed to load driver: driver was set to ${driver}`)
  }
}

export function megabytesToBytes(megabytes: number) {
  return megabytes * 1024 * 1024
}

export function bytesToMegabytes(bytes: number, decimals = 2) {
  return Number.parseFloat((bytes / (1024 / 1024)).toFixed(decimals))
}

export function dateToUnixTimeSeconds(date: Date) {
  return Math.round(date.getTime() / 1000)
}

class MemoryStream extends stream.Writable {
  buffers: Buffer[]
  constructor(opts?: stream.WritableOptions) {
    super(opts)
    this.buffers = []
  }
  _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void {
    this.buffers.push(Buffer.from(chunk, encoding))
    callback(null)
  }
  getData() {
    if (this.buffers.length === 1) {
      return this.buffers[0]
    }
    return Buffer.concat(this.buffers)
  }
}

export async function readStream(stream: stream.Readable): Promise<Buffer> {
  const memStream = new MemoryStream()
  await pipelineAsync(stream, memStream)
  return memStream.getData()
}

export function timeout(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, milliseconds)
  })
}

export interface StreamProgressCallback {
  /**
   * A callback that is invoked each time a chunk passes through the stream. 
   * This callback can throw an Error and it will be propagated 
   * If this callback throws an error, it will be propagated through the stream
   * pipeline. 
   * @param totalBytes Total bytes read (includes the current chunk bytes). 
   * @param chunkBytes Bytes read in the current chunk. 
   */
  (totalBytes: number, chunkBytes: number): void;
}

export interface MonitorStreamResult {
  monitoredStream: stream.Readable;
  pipelinePromise: Promise<void>;
}

export function monitorStreamProgress(
  inputStream: stream.Readable, 
  progressCallback: StreamProgressCallback
): MonitorStreamResult {

  // Create a PassThrough stream to monitor streaming chunk sizes. 
  let monitoredContentSize = 0
  const monitorStream = new stream.PassThrough({
    transform: (chunk: Buffer, _encoding, callback) => {
      monitoredContentSize += chunk.length
      try {
        progressCallback(monitoredContentSize, chunk.length)
        // Pass the chunk Buffer through, untouched. This takes the fast 
        // path through the stream pipe lib. 
        callback(null, chunk)
      } catch (error) {
        callback(error)
      }
    }
  })

  // Use the stream pipe API to monitor a stream with correct back pressure
  // handling. This avoids buffering entire streams in memory and hooks up 
  // all the correct events for cleanup and error handling. 
  // See https://nodejs.org/api/stream.html#stream_three_states
  //     https://nodejs.org/ja/docs/guides/backpressuring-in-streams/
  const monitorPipeline = pipelineAsync(inputStream, monitorStream)

  const result: MonitorStreamResult = {
    monitoredStream: monitorStream,
    pipelinePromise: monitorPipeline
  }

  return result
}


export class AsyncMutexScope {

  private readonly _opened = new Set<string>()

  public get openedCount() {
    return this._opened.size
  }

  /**
   * If no mutex of the given `id` is already taken, then a mutex is created and the 
   * given promise is invoked. The mutex is released once the promise resolves -- either by 
   * success or error. 
   * @param id A unique mutex name used in a Map.
   * @param spawnOwner A function that creates a Promise if the mutex is acquired. 
   * @returns `true` if the mutex was acquired, otherwise returns `false`
   */
  public tryAcquire(id: string, spawnOwner: () => Promise<void>): boolean {
    if (this._opened.has(id)) {
      return false
    }

    // Lock before invoking the given func to prevent potential synchronous 
    // reentrant locking attempts. 
    this._opened.add(id)
    
    try {
      const owner = spawnOwner()
      // If spawnOwner does not throw an error then we can safely attach the
      // unlock to the returned Promise. Once the Promise has evaluated (with or 
      // without error), we unlock. 
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      owner.finally(() => {
        this._opened.delete(id)
      })
    } catch (error) {
      // If spawnOwner throws a synchronous error then unlock and re-throw the
      // error for the caller to handle. This is okay in js because re-throwing
      // an error preserves the original error call stack. 
      this._opened.delete(id)
      throw error
    }
    return true
  }

}
