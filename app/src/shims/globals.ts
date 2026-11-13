// Some dependencies (circomlibjs, ffjavascript) expect Node globals. Imported first by main.js.
import { Buffer } from 'buffer';
globalThis.Buffer ??= Buffer;
globalThis.process ??= { env: {}, browser: true, nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)) };
