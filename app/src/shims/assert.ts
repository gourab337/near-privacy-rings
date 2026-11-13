// Minimal `assert` for circomlibjs in the browser.
export default function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg || 'assertion failed');
}
