// Minimal `assert` for circomlibjs in the browser.
export default function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
