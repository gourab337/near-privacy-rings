// Declarations for the deep imports the scripts make into sdk/node_modules (no types shipped).
// snarkjs's entry point: the same API as 'snarkjs' (types/vendor.d.ts)
declare module '*/snarkjs/main.js' {
  export * from 'snarkjs';
}
declare module '*/circomlibjs/src/poseidon_constants.js' {
  /** Round constants C[t-2] and MDS matrices M[t-2], as hex strings. */
  const constants: { C: string[][]; M: string[][][] };
  export default constants;
}

// JSON.parse converts its argument with ToString, and the Node scripts pass it the Buffer
// from fs.readFileSync directly.
interface JSON {
  parse(text: Buffer): unknown;
}
