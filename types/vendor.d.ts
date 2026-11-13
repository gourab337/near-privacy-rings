// Minimal declarations for dependencies that ship no types: only what this repo uses.
declare module 'snarkjs' {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export const groth16: {
    /** `wasm` and `zkey` are file paths (Node) or their bytes. */
    fullProve(
      input: Record<string, unknown>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };
}

declare module 'circomlibjs' {
  /** A Poseidon hasher: returns a field element in circomlibjs's internal form; `F.toObject` reads it as a bigint. */
  export interface Poseidon {
    (inputs: bigint[]): Uint8Array;
    F: { toObject(x: Uint8Array): bigint };
  }
  export function buildPoseidon(): Promise<Poseidon>;
}

/** The bn128 curve snarkjs caches on globalThis; it keeps worker threads alive until terminated. */
declare var curve_bn128: { terminate(): Promise<void> } | undefined;
