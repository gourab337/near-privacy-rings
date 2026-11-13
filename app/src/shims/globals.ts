// Some dependencies (circomlibjs, ffjavascript) expect Node globals. Imported first by main.js.
import { Buffer } from 'buffer';
globalThis.Buffer ??= Buffer;
globalThis.process ??= { env: {}, browser: true, nextTick: (fn: (...args: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => fn(...a)) } as unknown as NodeJS.Process;
