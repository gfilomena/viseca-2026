import { EventEmitter } from 'node:events';

export type BusMessage =
  | { type: 'decision'; authorization_id: string; run_id: string }
  | { type: 'run'; run_id: string }
  | { type: 'mandate'; mandate_id: string }
  | { type: 'worker'; status: string; detail?: string };

export const bus = new EventEmitter();
bus.setMaxListeners(100);
export const publish = (m: BusMessage) => bus.emit('message', m);
