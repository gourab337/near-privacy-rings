pragma circom 2.1.0;

// NEAR Privacy Rings — shielded transaction circuit.
//
// Note/keypair/nullifier scheme follows Tornado Cash Nova (MIT), extended with a
// hidden per-note asset id:
//   publicKey  = Poseidon(privateKey)
//   commitment = Poseidon(amount, publicKey, blinding, asset)
//   signature  = Poseidon(privateKey, commitment, leafIndex)
//   nullifier  = Poseidon(commitment, leafIndex, signature)
//
// All notes in one transaction share one private `asset`. `publicAsset` is 0 for a
// pure shielded transfer (asset stays hidden); the contract sets it to the token's
// asset id whenever value enters or leaves the pool, and then every note must match.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/switcher.circom";

template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices;
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== pathIndices;

    component sw[levels];
    component h[levels];
    for (var i = 0; i < levels; i++) {
        sw[i] = Switcher();
        sw[i].L <== i == 0 ? leaf : h[i - 1].out;
        sw[i].R <== pathElements[i];
        sw[i].sel <== bits.out[i];
        h[i] = Poseidon(2);
        h[i].inputs[0] <== sw[i].outL;
        h[i].inputs[1] <== sw[i].outR;
    }
    root <== h[levels - 1].out;
}

template Transaction(levels, nIns, nOuts) {
    // ---- public (order here = public signal order) ----
    signal input root;
    signal input publicAmount;      // extAmount - fee, mod p
    signal input extDataHash;       // binds recipient, relayer, fee, ciphertexts, swap leg
    signal input publicAsset;       // 0 => asset hidden
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // ---- private ----
    signal input asset;
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    // asset binding: publicAsset != 0  =>  asset == publicAsset
    (asset - publicAsset) * publicAsset === 0;

    component inPk[nIns];
    component inCm[nIns];
    component inSig[nIns];
    component inNf[nIns];
    component inTree[nIns];
    component inRootOk[nIns];
    component inBits[nIns];
    var sumIns = 0;

    for (var i = 0; i < nIns; i++) {
        inPk[i] = Poseidon(1);
        inPk[i].inputs[0] <== inPrivateKey[i];

        inCm[i] = Poseidon(4);
        inCm[i].inputs[0] <== inAmount[i];
        inCm[i].inputs[1] <== inPk[i].out;
        inCm[i].inputs[2] <== inBlinding[i];
        inCm[i].inputs[3] <== asset;

        inSig[i] = Poseidon(3);
        inSig[i].inputs[0] <== inPrivateKey[i];
        inSig[i].inputs[1] <== inCm[i].out;
        inSig[i].inputs[2] <== inPathIndices[i];

        inNf[i] = Poseidon(3);
        inNf[i].inputs[0] <== inCm[i].out;
        inNf[i].inputs[1] <== inPathIndices[i];
        inNf[i].inputs[2] <== inSig[i].out;
        inNf[i].out === inputNullifier[i];

        inTree[i] = MerkleProof(levels);
        inTree[i].leaf <== inCm[i].out;
        inTree[i].pathIndices <== inPathIndices[i];
        for (var j = 0; j < levels; j++) {
            inTree[i].pathElements[j] <== inPathElements[i][j];
        }

        // membership only enforced for non-zero inputs (zero-value dummies allowed)
        inRootOk[i] = ForceEqualIfEnabled();
        inRootOk[i].in[0] <== root;
        inRootOk[i].in[1] <== inTree[i].root;
        inRootOk[i].enabled <== inAmount[i];

        inBits[i] = Num2Bits(128);
        inBits[i].in <== inAmount[i];

        sumIns += inAmount[i];
    }

    component outCm[nOuts];
    component outBits[nOuts];
    var sumOuts = 0;
    for (var i = 0; i < nOuts; i++) {
        outCm[i] = Poseidon(4);
        outCm[i].inputs[0] <== outAmount[i];
        outCm[i].inputs[1] <== outPubkey[i];
        outCm[i].inputs[2] <== outBlinding[i];
        outCm[i].inputs[3] <== asset;
        outCm[i].out === outputCommitment[i];

        outBits[i] = Num2Bits(128);
        outBits[i].in <== outAmount[i];

        sumOuts += outAmount[i];
    }

    // no duplicate nullifiers inside one transaction
    component same[nIns * (nIns - 1) / 2];
    var k = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            same[k] = IsEqual();
            same[k].in[0] <== inputNullifier[i];
            same[k].in[1] <== inputNullifier[j];
            same[k].out === 0;
            k++;
        }
    }

    sumIns + publicAmount === sumOuts;

    // bind extDataHash into the proof
    signal extSq;
    extSq <== extDataHash * extDataHash;
}
