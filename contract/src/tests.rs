use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../tests/fixtures/dev.json")).unwrap()
}
fn parse_tx(v: &Value) -> (TxArgs, ExtData) {
    (serde_json::from_value(v["args"].clone()).unwrap(), serde_json::from_value(v["ext_data"].clone()).unwrap())
}
fn ctx(attached: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("pool.near".parse().unwrap())
        .predecessor_account_id("alice.near".parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(attached))
        .account_balance(NearToken::from_near(100))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}
fn pool() -> Pool {
    ctx(0);
    let mut p = Pool::new("owner.near".parse().unwrap());
    ctx(0);
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id("owner.near".parse().unwrap()).account_balance(NearToken::from_near(100));
    testing_env!(b.build());
    p.set_token(NATIVE.into(), U128(1_000));
    p
}

#[test]
fn empty_root_matches_sdk() {
    let f = fixtures();
    assert_eq!(pool().get_root(), f["empty_root"].as_str().unwrap());
}

#[test]
fn deposit_then_private_transfer() {
    let f = fixtures();
    let mut p = pool();
    let (a, e) = parse_tx(&f["deposit"]);
    ctx(10);
    p.transact(a, e);
    assert_eq!(p.get_root(), f["root_after_deposit"].as_str().unwrap());
    assert_eq!(p.get_token(NATIVE.into()).unwrap().tvl.0, 10);

    let (a, e) = parse_tx(&f["transfer"]);
    ctx(0);
    let gas_before = env::used_gas();
    p.transact(a.clone(), e.clone());
    eprintln!("transfer host-fn gas: {} Tgas", (env::used_gas().as_gas() - gas_before.as_gas()) / 1_000_000_000_000);
    assert_eq!(p.get_root(), f["root_after_transfer"].as_str().unwrap());
    assert_eq!(p.get_next_index(), 4);
    assert!(p.is_spent(a.input_nullifiers[0].clone()));
    assert_eq!(p.get_leaves(0, 10).len(), 4);
}

#[test]
#[should_panic(expected = "input already spent")]
fn double_spend_rejected() {
    let f = fixtures();
    let mut p = pool();
    let (a, e) = parse_tx(&f["deposit"]);
    ctx(10);
    p.transact(a, e);
    let (a, e) = parse_tx(&f["transfer"]);
    ctx(0);
    p.transact(a.clone(), e.clone());
    p.transact(a, e);
}

#[test]
#[should_panic(expected = "ext_data_hash mismatch")]
fn tampered_ext_data_rejected() {
    let f = fixtures();
    let mut p = pool();
    let (a, mut e) = parse_tx(&f["deposit"]);
    e.encrypted_output1.0[0] ^= 1;
    ctx(10);
    p.transact(a, e);
}

#[test]
#[should_panic(expected = "invalid proof")]
fn forged_proof_rejected() {
    let f = fixtures();
    let mut p = pool();
    let (mut a, e) = parse_tx(&f["deposit"]);
    // flip a commitment the proof did not attest to (still canonical)
    a.output_commitments[0] = a.output_commitments[1].clone();
    ctx(10);
    p.transact(a, e);
}

#[test]
#[should_panic(expected = "deposit cap reached")]
fn cap_enforced() {
    let f = fixtures();
    let mut p = pool();
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id("owner.near".parse().unwrap());
    testing_env!(b.build());
    p.set_token(NATIVE.into(), U128(5));
    let (a, e) = parse_tx(&f["deposit"]);
    ctx(10);
    p.transact(a, e);
}
