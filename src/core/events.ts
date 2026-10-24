import { EventEmitter } from 'node:events'
import type { CoreEvent, CoreEventName, CoreEvents } from '@shared/api'

/** Typed event bus for core → surfaces (GUI forwards every event to the renderer). */
export class CoreEmitter {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  emitEvent<K extends CoreEventName>(name: K, payload: CoreEvents[K]): void {
    this.emitter.emit(name, payload)
    this.emitter.emit('*', { name, payload } as CoreEvent)
  }

  on<K extends CoreEventName>(name: K, listener: (payload: CoreEvents[K]) => void): () => void {
    this.emitter.on(name, listener)
    return () => this.emitter.off(name, listener)
  }

  onAny(listener: (event: CoreEvent) => void): () => void {
    this.emitter.on('*', listener)
    return () => this.emitter.off('*', listener)
  }
}
