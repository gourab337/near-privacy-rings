pragma circom 2.1.0;
include "./transaction.circom";
component main {public [root, publicAmount, extDataHash, publicAsset, inputNullifier, outputCommitment]} = Transaction(20, 2, 2);
