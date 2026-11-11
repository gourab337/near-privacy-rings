//! BN254 scalar-field helpers. Field elements cross the API as 64-char big-endian hex
//! and are stored as canonical big-endian [u8; 32].
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use ark_ff::{BigInt, Field};
use near_sdk::require;

pub type F32 = [u8; 32];

pub fn to_fr(b: &F32) -> Fr {
    Fr::from_be_bytes_mod_order(b)
}

pub fn from_fr(f: Fr) -> F32 {
    let v = f.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - v.len()..].copy_from_slice(&v);
    out
}

/// Parses 64-char hex and rejects non-canonical encodings (>= field modulus), which
/// would otherwise let one nullifier be presented in two encodings.
pub fn parse(s: &str) -> F32 {
    require!(s.len() == 64, "field element must be 64 hex chars");
    let mut b = [0u8; 32];
    hex::decode_to_slice(s, &mut b).unwrap_or_else(|_| near_sdk::env::panic_str("invalid hex"));
    require!(from_fr(to_fr(&b)) == b, "non-canonical field element");
    b
}

pub fn to_hex(b: &F32) -> String {
    hex::encode(b)
}

/// publicAmount = extAmount - fee (mod p), as the circuit expects.
pub fn public_amount(ext_amount: i128, fee: u128) -> F32 {
    let ext = if ext_amount >= 0 {
        Fr::from(ext_amount as u128)
    } else {
        -Fr::from(ext_amount.unsigned_abs())
    };
    from_fr(ext - Fr::from(fee))
}

/// sha256 with the top byte zeroed: always a canonical field element.
pub fn sha256_field(data: &[u8]) -> F32 {
    let mut d: F32 = near_sdk::env::sha256_array(data);
    d[0] = 0;
    d
}

/// circomlib-compatible Poseidon for 2 inputs (t = 3, x^5 S-box, 8 full + 57 partial rounds).
pub struct Hasher {
    c: Vec<Fr>,
    m: [[Fr; 3]; 3],
}

impl Hasher {
    pub fn new() -> Self {
        use crate::poseidon_consts as k;
        let f = |l: &[u64; 4]| Fr::new_unchecked(BigInt::new(*l));
        Hasher {
            c: k::C.iter().map(f).collect(),
            m: core::array::from_fn(|i| core::array::from_fn(|j| f(&k::M[i][j]))),
        }
    }

    pub fn hash2(&mut self, l: &F32, r: &F32) -> F32 {
        use crate::poseidon_consts::{N_ROUNDS_F, N_ROUNDS_P};
        let pow5 = |a: Fr| a.square().square() * a;
        let mut s = [Fr::from(0u8), to_fr(l), to_fr(r)];
        for round in 0..N_ROUNDS_F + N_ROUNDS_P {
            for i in 0..3 {
                s[i] += self.c[round * 3 + i];
            }
            if round < N_ROUNDS_F / 2 || round >= N_ROUNDS_F / 2 + N_ROUNDS_P {
                s = s.map(pow5);
            } else {
                s[0] = pow5(s[0]);
            }
            s = core::array::from_fn(|i| self.m[i][0] * s[0] + self.m[i][1] * s[1] + self.m[i][2] * s[2]);
        }
        from_fr(s[0])
    }
}
