//! Groth16 verification over BN254 using NEAR's alt_bn128 host functions.
use crate::field::F32;
use crate::vk;
use near_sdk::{env, require};

pub const PROOF_LEN: usize = 256; // A (G1, 64) || B (G2, 128) || C (G1, 64)

pub fn verify(proof: &[u8], inputs: &[F32]) -> bool {
    require!(proof.len() == PROOF_LEN, "proof must be 256 bytes");
    require!(inputs.len() == vk::N_PUBLIC, "wrong number of public inputs");

    // vk_x = IC[0] + sum(IC[i+1] * input[i])
    let mut msm = Vec::with_capacity(96 * (inputs.len() + 1));
    msm.extend_from_slice(&vk::IC[0]);
    let mut one = [0u8; 32];
    one[0] = 1;
    msm.extend_from_slice(&one);
    for (i, x) in inputs.iter().enumerate() {
        msm.extend_from_slice(&vk::IC[i + 1]);
        let mut le = *x;
        le.reverse();
        msm.extend_from_slice(&le);
    }
    let vk_x = env::alt_bn128_g1_multiexp(&msm);

    // -A
    let mut neg = Vec::with_capacity(65);
    neg.push(1u8);
    neg.extend_from_slice(&proof[0..64]);
    let neg_a = env::alt_bn128_g1_sum(&neg);

    // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    let mut p = Vec::with_capacity(4 * 192);
    p.extend_from_slice(&neg_a);
    p.extend_from_slice(&proof[64..192]);
    p.extend_from_slice(&vk::ALPHA_G1);
    p.extend_from_slice(&vk::BETA_G2);
    p.extend_from_slice(&vk_x);
    p.extend_from_slice(&vk::GAMMA_G2);
    p.extend_from_slice(&proof[192..256]);
    p.extend_from_slice(&vk::DELTA_G2);
    env::alt_bn128_pairing_check(&p)
}
