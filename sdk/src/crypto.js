// Core cryptography shared by the SDK, tests and fixture generation.
// Must stay byte-for-byte consistent with contract/src (see contract tests).
import { buildPoseidon } from 'circomlibjs';
import nacl from 'tweetnacl';
import { createHash, randomBytes } from 'node:crypto';

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const TREE_DEPTH = 20;

let _poseidon;
export async function initCrypto() {
  if (!_poseidon) _poseidon = await buildPoseidon();
}
export function poseidon(inputs) {
  if (!_poseidon) throw new Error('call initCrypto() first');
  return _poseidon.F.toObject(_poseidon(inputs.map(BigInt)));
}

export const randomField = () => BigInt('0x' + randomBytes(31).toString('hex'));

export function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

/** sha256 with the top byte zeroed, read big-endian: always < FIELD_SIZE. */
export function sha256Field(buf) {
  const d = sha256(buf);
  d[0] = 0;
  return BigInt('0x' + d.toString('hex'));
}

/** Asset id of a token. Native NEAR is the token id "near". Never 0. */
export const assetId = (tokenId) => sha256Field(Buffer.from(tokenId, 'utf8'));

// ---------- keys ----------

export class Keypair {
  constructor(privKey = randomField()) {
    this.privKey = BigInt(privKey);
    this.pubKey = poseidon([this.privKey]);
    // viewing (encryption) key, derived from the spending key
    const seed = sha256(Buffer.concat([Buffer.from('npr-view'), toBytes32BE(this.privKey)]));
    this.view = nacl.box.keyPair.fromSecretKey(new Uint8Array(seed));
  }
  /** Shareable shielded address: pubKey (32B) || viewPk (32B), hex with "npr" prefix. */
  address() {
    return 'npr' + toBytes32BE(this.pubKey).toString('hex') + Buffer.from(this.view.publicKey).toString('hex');
  }
  static parseAddress(addr) {
    if (!/^npr[0-9a-f]{128}$/.test(addr)) throw new Error('invalid shielded address');
    return {
      pubKey: BigInt('0x' + addr.slice(3, 67)),
      viewPk: new Uint8Array(Buffer.from(addr.slice(67), 'hex')),
    };
  }
}

// ---------- notes ----------

export class Note {
  constructor({ amount = 0n, pubKey, blinding = randomField(), asset, keypair = null, index = null }) {
    this.amount = BigInt(amount);
    this.pubKey = BigInt(keypair ? keypair.pubKey : pubKey);
    this.blinding = BigInt(blinding);
    this.asset = BigInt(asset);
    this.keypair = keypair; // only set when we own the note
    this.index = index; // leaf index once inserted
  }
  commitment() {
    return poseidon([this.amount, this.pubKey, this.blinding, this.asset]);
  }
  nullifier() {
    if (!this.keypair) throw new Error('cannot nullify a note without its private key');
    // dummy inputs (amount 0) are never inserted; any index gives a unique nullifier
    const idx = BigInt(this.index ?? 0);
    const cm = this.commitment();
    const sig = poseidon([this.keypair.privKey, cm, idx]);
    return poseidon([cm, idx, sig]);
  }
  /** amount(16 LE) || blinding(32 BE) || asset(32 BE), boxed to the recipient's view key. */
  encrypt(viewPk) {
    const pt = Buffer.concat([u128LE(this.amount), toBytes32BE(this.blinding), toBytes32BE(this.asset)]);
    const eph = nacl.box.keyPair();
    const nonce = randomBytes(24);
    const ct = nacl.box(new Uint8Array(pt), new Uint8Array(nonce), viewPk, eph.secretKey);
    return Buffer.concat([Buffer.from(eph.publicKey), nonce, Buffer.from(ct)]);
  }
  /** Returns a Note if `keypair` can decrypt `data`, else null. */
  static decrypt(keypair, data, index) {
    const buf = Buffer.from(data);
    if (buf.length !== 32 + 24 + 80 + 16) return null;
    const pt = nacl.box.open(
      new Uint8Array(buf.subarray(56)),
      new Uint8Array(buf.subarray(32, 56)),
      new Uint8Array(buf.subarray(0, 32)),
      keypair.view.secretKey,
    );
    if (!pt) return null;
    const p = Buffer.from(pt);
    return new Note({
      amount: readU128LE(p.subarray(0, 16)),
      blinding: BigInt('0x' + p.subarray(16, 48).toString('hex')),
      asset: BigInt('0x' + p.subarray(48, 80).toString('hex')),
      keypair,
      index,
    });
  }
}

// ---------- merkle tree (append-only, zero leaf = 0) ----------

export class MerkleTree {
  constructor(depth = TREE_DEPTH, leaves = []) {
    this.depth = depth;
    this.zeros = [0n];
    for (let i = 1; i <= depth; i++) this.zeros.push(poseidon([this.zeros[i - 1], this.zeros[i - 1]]));
    this.layers = Array.from({ length: depth + 1 }, () => []);
    for (const l of leaves) this.insert(l);
  }
  get size() {
    return this.layers[0].length;
  }
  insert(leaf) {
    let idx = this.layers[0].length;
    this.layers[0].push(BigInt(leaf));
    for (let lvl = 1; lvl <= this.depth; lvl++) {
      idx >>= 1;
      const l = this.layers[lvl - 1][2 * idx] ?? this.zeros[lvl - 1];
      const r = this.layers[lvl - 1][2 * idx + 1] ?? this.zeros[lvl - 1];
      this.layers[lvl][idx] = poseidon([l, r]);
    }
  }
  root() {
    return this.layers[this.depth][0] ?? this.zeros[this.depth];
  }
  path(index) {
    const pathElements = [];
    let idx = index;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      pathElements.push(this.layers[lvl][idx ^ 1] ?? this.zeros[lvl]);
      idx >>= 1;
    }
    return { pathElements, pathIndices: index };
  }
}

// ---------- ext data (must match contract ExtData borsh layout) ----------

/**
 * ExtData { recipient: String, ext_amount: i128, relayer: String, fee: u128,
 *           encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>, token: String, swap_leg: [u8;32] }
 */
export function encodeExtData(ext) {
  return Buffer.concat([
    borshString(ext.recipient),
    i128LE(BigInt(ext.extAmount)),
    borshString(ext.relayer),
    u128LE(BigInt(ext.fee)),
    borshBytes(ext.encryptedOutput1),
    borshBytes(ext.encryptedOutput2),
    borshString(ext.token),
    toBytes32BE(BigInt(ext.swapLeg ?? 0n)),
  ]);
}
export const extDataHash = (ext) => sha256Field(encodeExtData(ext));

// ---------- byte helpers ----------

export function toBytes32BE(x) {
  return Buffer.from(BigInt(x).toString(16).padStart(64, '0'), 'hex');
}
export function toBytes32LE(x) {
  return Buffer.from(toBytes32BE(x)).reverse();
}
export function u128LE(x) {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(x & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(x >> 64n, 8);
  return b;
}
function i128LE(x) {
  return u128LE(x < 0n ? (1n << 128n) + x : x);
}
function readU128LE(b) {
  return b.readBigUInt64LE(0) + (b.readBigUInt64LE(8) << 64n);
}
function borshString(s) {
  return borshBytes(Buffer.from(s, 'utf8'));
}
function borshBytes(b) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, Buffer.from(b)]);
}
