//! Unit tests with real Groth16 proofs (contract/tests/fixtures/dev.json, made by
//! scripts/gen-fixtures.mjs with the SDK wallet). Host functions, including alt_bn128,
//! run for real in the mocked VM.
use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const WRAP: &str = "wrap.testnet";

fn fx() -> Value {
    serde_json::from_str(include_str!("../tests/fixtures/dev.json")).unwrap()
}
fn tx(v: &Value) -> (TxArgs, ExtData) {
    (serde_json::from_value(v["args"].clone()).unwrap(), serde_json::from_value(v["ext_data"].clone()).unwrap())
}
fn leg(v: &Value, l: &str, e: &str) -> (TxArgs, ExtData) {
    (serde_json::from_value(v[l].clone()).unwrap(), serde_json::from_value(v[e].clone()).unwrap())
}
fn ctx_at(who: &str, attached: u128, height: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id("pool.near".parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(attached))
        .account_balance(NearToken::from_near(100))
        .block_height(height)
        .prepaid_gas(Gas::from_tgas(300));
    b
}
fn ctx(who: &str, attached: u128) {
    testing_env!(ctx_at(who, attached, 1).build());
}
fn pool(cap: u128) -> Pool {
    ctx("owner.near", 0);
    let mut p = Pool::new("owner.near".parse().unwrap());
    p.set_token(NATIVE.into(), U128(cap));
    p.set_token(WRAP.into(), U128(cap));
    p
}
fn deposit(p: &mut Pool, f: &Value) {
    let (a, e) = tx(&f["deposit"]);
    ctx("alice.near", 10 + STORAGE_FEE);
    p.transact(a, e);
}
fn ft_deposit(p: &mut Pool, f: &Value) {
    ctx("bob.near", STORAGE_FEE);
    p.prepay_storage(None);
    ctx(WRAP, 0);
    let d = &f["ft_deposit"];
    p.ft_on_transfer("bob.near".parse().unwrap(), U128(d["amount"].as_str().unwrap().parse().unwrap()), d["msg"].as_str().unwrap().into());
}
fn root(f: &Value, k: &str) -> String {
    f[k].as_str().unwrap().to_string()
}

#[test]
fn empty_root_matches_sdk() {
    assert_eq!(pool(1000).get_root(), root(&fx(), "empty_root"));
}

#[test]
fn deposit_transfer_ft_deposit_swap() {
    let f = fx();
    let mut p = pool(1000);
    deposit(&mut p, &f);
    assert_eq!(p.get_root(), root(&f, "root_after_deposit"));
    assert_eq!(p.get_token(NATIVE.into()).unwrap().tvl.0, 10);

    let (a, e) = tx(&f["transfer"]);
    ctx("alice.near", STORAGE_FEE);
    p.transact(a.clone(), e);
    assert_eq!(p.get_root(), root(&f, "root_after_transfer"));
    assert!(p.is_spent(a.input_nullifiers[0].clone()));

    ft_deposit(&mut p, &f);
    assert_eq!(p.get_token(WRAP.into()).unwrap().tvl.0, 5);
    assert_eq!(p.get_storage_credit("bob.near".parse().unwrap()).0, 0);

    let (la, ea) = leg(&f["swap"], "leg_a", "ext_a");
    let (lb, eb) = leg(&f["swap"], "leg_b", "ext_b");
    ctx("relayer.near", 2 * STORAGE_FEE);
    p.swap(la, ea, lb, eb);
    assert_eq!(p.get_root(), root(&f, "root_after_swap"));
    assert_eq!(p.get_next_index(), 10);
    // swaps move no public value
    assert_eq!(p.get_token(NATIVE.into()).unwrap().tvl.0, 10);
    assert_eq!(p.get_token(WRAP.into()).unwrap().tvl.0, 5);
}

#[test]
#[should_panic(expected = "input already spent")]
fn double_spend_rejected() {
    let f = fx();
    let mut p = pool(1000);
    deposit(&mut p, &f);
    let (a, e) = tx(&f["transfer"]);
    ctx("alice.near", STORAGE_FEE);
    p.transact(a.clone(), e.clone());
    ctx("alice.near", STORAGE_FEE);
    p.transact(a, e);
}

#[test]
#[should_panic(expected = "ext_data_hash mismatch")]
fn tampered_ext_data_rejected() {
    let f = fx();
    let mut p = pool(1000);
    let (a, mut e) = tx(&f["deposit"]);
    e.encrypted_output1.0[0] ^= 1;
    ctx("alice.near", 10 + STORAGE_FEE);
    p.transact(a, e);
}

#[test]
#[should_panic(expected = "invalid proof")]
fn forged_proof_rejected() {
    let f = fx();
    let mut p = pool(1000);
    let (mut a, e) = tx(&f["deposit"]);
    a.output_commitments[0] = a.output_commitments[1].clone();
    ctx("alice.near", 10 + STORAGE_FEE);
    p.transact(a, e);
}

#[test]
#[should_panic(expected = "deposit cap reached")]
fn cap_enforced() {
    let f = fx();
    let mut p = pool(5);
    deposit(&mut p, &f);
}

#[test]
#[should_panic(expected = "STORAGE_FEE")]
fn storage_fee_required() {
    let f = fx();
    let mut p = pool(1000);
    let (a, e) = tx(&f["deposit"]);
    ctx("alice.near", 10);
    p.transact(a, e);
}

#[test]
#[should_panic(expected = "prepay_storage first")]
fn ft_deposit_needs_prepaid_storage() {
    let f = fx();
    let mut p = pool(1000);
    ctx(WRAP, 0);
    let d = &f["ft_deposit"];
    p.ft_on_transfer("bob.near".parse().unwrap(), U128(5), d["msg"].as_str().unwrap().into());
}

#[test]
#[should_panic(expected = "token mismatch")]
fn ft_on_transfer_from_other_contract_rejected() {
    let f = fx();
    let mut p = pool(1000);
    ctx("bob.near", STORAGE_FEE);
    p.prepay_storage(None);
    ctx("evil.near", 0);
    p.ft_on_transfer("bob.near".parse().unwrap(), U128(5), f["ft_deposit"]["msg"].as_str().unwrap().into());
}

#[test]
#[should_panic(expected = "proof expired")]
fn expired_swap_rejected() {
    let f = fx();
    let mut p = pool(1000);
    deposit(&mut p, &f);
    let (a, e) = tx(&f["transfer"]);
    ctx("alice.near", STORAGE_FEE);
    p.transact(a, e);
    ft_deposit(&mut p, &f);
    let (la, ea) = leg(&f["swap"], "leg_a", "ext_a");
    let (lb, eb) = leg(&f["swap"], "leg_b", "ext_b");
    let h = f["swap_valid_until"].as_u64().unwrap() + 1;
    testing_env!(ctx_at("relayer.near", 2 * STORAGE_FEE, h).build());
    p.swap(la, ea, lb, eb);
}

#[test]
#[should_panic(expected = "swap_leg only allowed in swap")]
fn swap_leg_cannot_settle_alone() {
    let f = fx();
    let mut p = pool(1000);
    deposit(&mut p, &f);
    let (a, e) = tx(&f["transfer"]);
    ctx("alice.near", STORAGE_FEE);
    p.transact(a, e);
    ft_deposit(&mut p, &f);
    let (la, ea) = leg(&f["swap"], "leg_a", "ext_a");
    ctx("alice.near", STORAGE_FEE);
    p.transact(la, ea);
}

/// Review finding H1: a failed payout must be re-credited even when the token is at its cap.
#[test]
fn failed_payout_recredited_over_cap_and_claimable_by_anyone() {
    let f = fx();
    let mut p = pool(10);
    deposit(&mut p, &f); // tvl 10 == cap
    testing_env!(
        ctx_at("pool.near", 0, 1).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    p.on_payout(NATIVE.into(), "carol.near".parse().unwrap(), U128(3));
    assert_eq!(p.get_token(NATIVE.into()).unwrap().tvl.0, 13);
    assert_eq!(p.get_failed("carol.near".parse().unwrap(), NATIVE.into()).0, 3);

    ctx("anyone.near", 0);
    let _ = p.claim_failed("carol.near".parse().unwrap(), NATIVE.into());
    assert_eq!(p.get_failed("carol.near".parse().unwrap(), NATIVE.into()).0, 0);
    assert_eq!(p.get_token(NATIVE.into()).unwrap().tvl.0, 10);
}
