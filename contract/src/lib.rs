//! NEAR Privacy Rings — a shielded pool for NEAR and NEP-141 tokens.
//!
//! Notes live off-chain, encrypted to their owner's viewing key; the contract stores
//! only Poseidon commitments (Merkle tree), spent nullifiers and the ciphertexts.
//! Every state change is authorised by a Groth16 proof (circuits/src/transaction.circom).
//!
//! Rings:
//! * confidential — the user's own NEAR account submits `transact`; asset and amount
//!   are hidden, the submitting account is visible.
//! * anonymous    — a relayer submits the same proof and is paid a public `fee`.
//! * swap         — two proofs settle atomically; each commits (via `swap_leg`) to the
//!   note it must receive from the other.
use near_sdk::json_types::{Base64VecU8, I128, U128};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    borsh, env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

mod field;
mod poseidon_consts;
mod tree;
mod verifier;
mod vk;

use field::{parse, public_amount, sha256_field, to_hex, Hasher, F32};
use tree::Tree;

pub const NATIVE: &str = "near";
pub const ENCRYPTED_OUTPUT_LEN: usize = 152; // eph pk 32 + nonce 24 + box(80) 96
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Roots,
    Known,
    Nullifiers,
    Leaves,
    Tokens,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TokenState {
    pub asset_id: String,
    pub cap: U128,
    pub tvl: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Leaf {
    pub commitment: String,
    pub encrypted_output: Base64VecU8,
}

/// Public inputs of one proof, as produced by the SDK.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct TxArgs {
    pub proof: Base64VecU8,
    pub root: String,
    pub input_nullifiers: [String; 2],
    pub output_commitments: [String; 2],
    pub public_amount: String,
    pub ext_data_hash: String,
    pub public_asset: String,
}

/// Data bound into the proof via `ext_data_hash` but not used inside the circuit.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct ExtData {
    pub recipient: String,
    pub ext_amount: I128,
    pub relayer: String,
    pub fee: U128,
    pub encrypted_output1: Base64VecU8,
    pub encrypted_output2: Base64VecU8,
    pub token: String,
    pub swap_leg: String,
}

#[derive(near_sdk::borsh::BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct ExtDataBorsh<'a> {
    recipient: &'a str,
    ext_amount: i128,
    relayer: &'a str,
    fee: u128,
    encrypted_output1: &'a [u8],
    encrypted_output2: &'a [u8],
    token: &'a str,
    swap_leg: F32,
}

impl ExtData {
    fn hash(&self) -> F32 {
        let b = ExtDataBorsh {
            recipient: &self.recipient,
            ext_amount: self.ext_amount.0,
            relayer: &self.relayer,
            fee: self.fee.0,
            encrypted_output1: &self.encrypted_output1.0,
            encrypted_output2: &self.encrypted_output2.0,
            token: &self.token,
            swap_leg: parse(&self.swap_leg),
        };
        sha256_field(&borsh::to_vec(&b).unwrap())
    }
}

/// A proof whose public inputs and ext data have been checked and verified.
struct Verified {
    nullifiers: [F32; 2],
    commitments: [F32; 2],
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    owner: AccountId,
    paused: bool,
    tree: Tree,
    nullifiers: LookupSet<F32>,
    leaves: Vector<Leaf>,
    tokens: LookupMap<String, TokenState>,
    /// payouts whose transfer failed, claimable by the recipient: (account, token) -> amount
    failed: LookupMap<(AccountId, String), U128>,
}

#[near]
impl Pool {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            paused: false,
            tree: Tree::new(Key::Roots, Key::Known),
            nullifiers: LookupSet::new(Key::Nullifiers),
            leaves: Vector::new(Key::Leaves),
            tokens: LookupMap::new(Key::Tokens),
            failed: LookupMap::new(Key::Failed),
        }
    }

    // ------------------------------------------------------------------ user

    /// Deposit native NEAR (attach exactly `ext_amount`), transfer, or withdraw.
    #[payable]
    pub fn transact(&mut self, args: TxArgs, ext_data: ExtData) {
        let attached = env::attached_deposit().as_yoctonear();
        let ext = ext_data.ext_amount.0;
        if ext > 0 {
            require!(ext_data.token == NATIVE, "NEP-141 deposits go through ft_transfer_call");
            require!(attached == ext as u128, "attached deposit must equal ext_amount");
        } else {
            require!(attached == 0, "no deposit expected");
        }
        self.process(&args, &ext_data);
    }

    /// NEP-141 deposit: `ft_transfer_call(pool, amount, msg = {"args":..,"ext_data":..})`.
    /// Any panic here makes the token contract refund the full amount.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = sender_id;
        #[near(serializers = [json])]
        struct Msg {
            args: TxArgs,
            ext_data: ExtData,
        }
        let m: Msg = near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("invalid msg"));
        require!(m.ext_data.token == env::predecessor_account_id().as_str(), "token mismatch");
        require!(m.ext_data.ext_amount.0 > 0 && m.ext_data.ext_amount.0 as u128 == amount.0, "amount mismatch");
        self.process(&m.args, &m.ext_data);
        PromiseOrValue::Value(U128(0))
    }

    /// Atomic private swap: both legs are hidden-asset transfers, and each leg's
    /// `swap_leg` must be one of the other leg's output commitments.
    pub fn swap(&mut self, leg_a: TxArgs, ext_a: ExtData, leg_b: TxArgs, ext_b: ExtData) {
        require!(!self.paused, "paused");
        for (a, e) in [(&leg_a, &ext_a), (&leg_b, &ext_b)] {
            require!(e.ext_amount.0 == 0 && e.fee.0 == 0, "swap legs move no public value");
            require!(parse(&a.public_asset) == [0u8; 32], "swap legs must hide the asset");
        }
        let mut h = Hasher::new();
        let va = self.verify_leg(&leg_a, &ext_a, true);
        let vb = self.verify_leg(&leg_b, &ext_b, true);
        let (sa, sb) = (parse(&ext_a.swap_leg), parse(&ext_b.swap_leg));
        require!(vb.commitments.contains(&sa), "leg B does not create the note leg A expects");
        require!(va.commitments.contains(&sb), "leg A does not create the note leg B expects");
        self.apply(&mut h, &va, &ext_a);
        self.apply(&mut h, &vb, &ext_b);
        self.assert_solvent();
    }

    /// Re-try a payout whose transfer failed (e.g. recipient not registered with the token).
    pub fn claim_failed(&mut self, token: String) -> Promise {
        let who = env::predecessor_account_id();
        let key = (who.clone(), token.clone());
        let amount = self.failed.remove(&key).unwrap_or_else(|| env::panic_str("nothing to claim")).0;
        self.debit(&token, amount);
        self.payout(&token, who, amount)
    }

    // ------------------------------------------------------------------ views

    pub fn get_root(&self) -> String {
        to_hex(&self.tree.root())
    }
    pub fn is_known_root(&self, root: String) -> bool {
        self.tree.is_known_root(&parse(&root))
    }
    pub fn get_next_index(&self) -> u32 {
        self.tree.next_index
    }
    /// Leaves in insertion order, for wallet sync (trial-decrypt `encrypted_output`).
    pub fn get_leaves(&self, from_index: u32, limit: u32) -> Vec<Leaf> {
        let end = (from_index.saturating_add(limit.min(200))).min(self.leaves.len());
        (from_index..end).map(|i| self.leaves[i].clone()).collect()
    }
    pub fn is_spent(&self, nullifier: String) -> bool {
        self.nullifiers.contains(&parse(&nullifier))
    }
    pub fn get_token(&self, token: String) -> Option<TokenState> {
        self.tokens.get(&token).cloned()
    }
    pub fn get_failed(&self, account_id: AccountId, token: String) -> U128 {
        self.failed.get(&(account_id, token)).copied().unwrap_or(U128(0))
    }
    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    // ------------------------------------------------------------------ owner
    // The owner can list tokens, set deposit caps and pause. It cannot move notes.

    pub fn set_token(&mut self, token: String, cap: U128) {
        self.assert_owner();
        if token != NATIVE {
            let _: AccountId = token.parse().unwrap_or_else(|_| env::panic_str("invalid token account"));
        }
        let asset_id = to_hex(&sha256_field(token.as_bytes()));
        let tvl = self.tokens.get(&token).map(|t| t.tvl).unwrap_or(U128(0));
        self.tokens.insert(token, TokenState { asset_id, cap, tvl });
    }
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }
    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        self.owner = owner;
    }

    // ------------------------------------------------------------------ callbacks

    #[private]
    pub fn on_payout(&mut self, token: String, to: AccountId, amount: U128) {
        // transfers return no value; only an explicit failure means the funds came back
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            // funds came back to the pool; keep them owed to the recipient
            self.credit(&token, amount.0);
            let key = (to.clone(), token.clone());
            let prev = self.failed.get(&key).map(|v| v.0).unwrap_or(0);
            self.failed.insert(key, U128(prev + amount.0));
            log!("payout of {} {} to {} failed; claim with claim_failed", amount.0, token, to);
        }
    }
}

// ---------------------------------------------------------------------- internals

impl Pool {
    fn process(&mut self, args: &TxArgs, ext: &ExtData) {
        require!(!self.paused, "paused");
        let v = self.verify_leg(args, ext, false);
        let mut h = Hasher::new();
        self.apply(&mut h, &v, ext);

        let e = ext.ext_amount.0;
        let fee = ext.fee.0;
        if e > 0 {
            require!(fee == 0, "deposits carry no fee");
            self.credit(&ext.token, e as u128);
        }
        if e < 0 {
            let amount = e.unsigned_abs();
            let to: AccountId = ext.recipient.parse().unwrap_or_else(|_| env::panic_str("invalid recipient"));
            self.debit(&ext.token, amount);
            self.payout(&ext.token, to, amount).detach();
        }
        if fee > 0 {
            let relayer: AccountId = ext.relayer.parse().unwrap_or_else(|_| env::panic_str("invalid relayer"));
            self.debit(&ext.token, fee);
            self.payout(&ext.token, relayer, fee).detach();
        }
        self.assert_solvent();
    }

    /// Checks every public input against contract state and ext data, then the proof.
    fn verify_leg(&self, a: &TxArgs, ext: &ExtData, is_swap: bool) -> Verified {
        let root = parse(&a.root);
        let nullifiers = [parse(&a.input_nullifiers[0]), parse(&a.input_nullifiers[1])];
        let commitments = [parse(&a.output_commitments[0]), parse(&a.output_commitments[1])];
        let pub_amount = parse(&a.public_amount);
        let ext_hash = parse(&a.ext_data_hash);
        let pub_asset = parse(&a.public_asset);

        require!(self.tree.is_known_root(&root), "unknown merkle root");
        for n in &nullifiers {
            require!(!self.nullifiers.contains(n), "input already spent");
        }
        require!(ext.ext_amount.0 != i128::MIN, "invalid ext_amount");
        require!(pub_amount == public_amount(ext.ext_amount.0, ext.fee.0), "public_amount mismatch");
        require!(ext_hash == ext.hash(), "ext_data_hash mismatch");
        require!(
            ext.encrypted_output1.0.len() == ENCRYPTED_OUTPUT_LEN && ext.encrypted_output2.0.len() == ENCRYPTED_OUTPUT_LEN,
            "bad encrypted output length"
        );
        let swap_leg = parse(&ext.swap_leg);
        require!(is_swap == (swap_leg != [0u8; 32]), "swap_leg only allowed in swap");

        let moves_value = ext.ext_amount.0 != 0 || ext.fee.0 != 0;
        if moves_value {
            let t = self.tokens.get(&ext.token).unwrap_or_else(|| env::panic_str("token not supported"));
            require!(to_hex(&pub_asset) == t.asset_id, "public_asset must be the token's asset id");
        } else {
            require!(pub_asset == [0u8; 32], "hidden transfers must not reveal the asset");
            require!(ext.token.is_empty() && ext.recipient.is_empty(), "hidden transfers name no token or recipient");
        }

        let inputs = [root, pub_amount, ext_hash, pub_asset, nullifiers[0], nullifiers[1], commitments[0], commitments[1]];
        require!(verifier::verify(&a.proof.0, &inputs), "invalid proof");
        Verified { nullifiers, commitments }
    }

    fn apply(&mut self, h: &mut Hasher, v: &Verified, ext: &ExtData) {
        for n in &v.nullifiers {
            require!(self.nullifiers.insert(*n), "input already spent");
        }
        let first = self.tree.insert_pair(h, &v.commitments[0], &v.commitments[1]);
        for (c, enc) in [(&v.commitments[0], &ext.encrypted_output1), (&v.commitments[1], &ext.encrypted_output2)] {
            self.leaves.push(Leaf { commitment: to_hex(c), encrypted_output: enc.clone() });
        }
        log!(
            "EVENT_JSON:{{\"standard\":\"npr\",\"version\":\"1.0.0\",\"event\":\"transact\",\"data\":[{{\"first_leaf\":{},\"nullifiers\":[\"{}\",\"{}\"]}}]}}",
            first,
            to_hex(&v.nullifiers[0]),
            to_hex(&v.nullifiers[1])
        );
    }

    fn credit(&mut self, token: &str, amount: u128) {
        let t = self.tokens.get_mut(token).unwrap_or_else(|| env::panic_str("token not supported"));
        let tvl = t.tvl.0.checked_add(amount).unwrap_or_else(|| env::panic_str("overflow"));
        require!(tvl <= t.cap.0, "deposit cap reached");
        t.tvl = U128(tvl);
    }

    fn debit(&mut self, token: &str, amount: u128) {
        let t = self.tokens.get_mut(token).unwrap_or_else(|| env::panic_str("token not supported"));
        t.tvl = U128(t.tvl.0.checked_sub(amount).unwrap_or_else(|| env::panic_str("insufficient pool balance")));
    }

    fn payout(&self, token: &str, to: AccountId, amount: u128) -> Promise {
        let p = if token == NATIVE {
            Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount))
        } else {
            let token_id: AccountId = token.parse().unwrap();
            ext_ft::ext(token_id)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(to.clone(), U128(amount), None)
        };
        p.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_PAYOUT)
                .on_payout(token.to_string(), to, U128(amount)),
        )
    }

    /// Native NEAR owed to users plus storage staking must always be covered.
    fn assert_solvent(&self) {
        let owed = self.tokens.get(NATIVE).map(|t| t.tvl.0).unwrap_or(0);
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        require!(
            env::account_balance().as_yoctonear() >= owed + storage,
            "pool needs more NEAR for storage; ask the operator to top up"
        );
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }
}

#[cfg(test)]
mod tests;
