// Builds circuit inputs for a 2-in/2-out shielded transaction and proves it.
import * as snarkjs from 'snarkjs';
import { FIELD_SIZE, Keypair, Note, extDataHash, toBytes32LE } from './crypto.js';

export const N_INS = 2;
export const N_OUTS = 2;

/**
 * @param {object} p
 * @param {MerkleTree} p.tree      current local copy of the on-chain tree
 * @param {Note[]} p.inputs         owned notes to spend (padded with zero dummies)
 * @param {Note[]} p.outputs        new notes (padded with zero dummies to our own key)
 * @param {bigint} p.asset          asset id of every note
 * @param {object} p.ext            ext data (see encodeExtData); extAmount/fee as bigint
 * @param {bigint} p.publicAsset    0 for a hidden-asset transfer
 * @param {object} p.artifacts      { wasm, zkey } paths/buffers
 */
export async function buildProof({ tree, inputs, outputs, asset, ext, publicAsset, artifacts, changeKeypair }) {
  inputs = [...inputs];
  outputs = [...outputs];
  if (inputs.length > N_INS || outputs.length > N_OUTS) throw new Error('too many notes');
  const dummyKp = changeKeypair ?? new Keypair();
  while (inputs.length < N_INS) inputs.push(new Note({ amount: 0n, keypair: new Keypair(), asset }));
  while (outputs.length < N_OUTS) outputs.push(new Note({ amount: 0n, keypair: dummyKp, asset }));

  const publicAmount = (BigInt(ext.extAmount) - BigInt(ext.fee) + FIELD_SIZE) % FIELD_SIZE;
  const paths = inputs.map((n) => (n.amount > 0n ? tree.path(n.index) : { pathElements: Array(tree.depth).fill(0n), pathIndices: 0 }));

  const input = {
    root: tree.root(),
    publicAmount,
    extDataHash: extDataHash(ext),
    publicAsset,
    inputNullifier: inputs.map((n) => n.nullifier()),
    outputCommitment: outputs.map((n) => n.commitment()),
    asset,
    inAmount: inputs.map((n) => n.amount),
    inPrivateKey: inputs.map((n) => n.keypair.privKey),
    inBlinding: inputs.map((n) => n.blinding),
    inPathIndices: paths.map((p) => p.pathIndices),
    inPathElements: paths.map((p) => p.pathElements),
    outAmount: outputs.map((n) => n.amount),
    outPubkey: outputs.map((n) => n.pubKey),
    outBlinding: outputs.map((n) => n.blinding),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
  return {
    proof,
    publicSignals,
    args: {
      proof: encodeProofNear(proof),
      root: hex32(input.root),
      input_nullifiers: input.inputNullifier.map(hex32),
      output_commitments: input.outputCommitment.map(hex32),
      public_amount: hex32(publicAmount),
      ext_data_hash: hex32(input.extDataHash),
      public_asset: hex32(publicAsset),
    },
    inputs,
    outputs,
  };
}

export const hex32 = (x) => BigInt(x).toString(16).padStart(64, '0');

/**
 * NEAR alt_bn128 encoding (little-endian limbs):
 *   G1 = x || y            (64 B)
 *   G2 = x.c0 || x.c1 || y.c0 || y.c1   (128 B)
 * Proof = A || B || C = 256 B, base64.
 */
export function encodeProofNear(proof) {
  const g1 = (p) => Buffer.concat([toBytes32LE(p[0]), toBytes32LE(p[1])]);
  const g2 = (p) => Buffer.concat([toBytes32LE(p[0][0]), toBytes32LE(p[0][1]), toBytes32LE(p[1][0]), toBytes32LE(p[1][1])]);
  return Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]).toString('base64');
}
