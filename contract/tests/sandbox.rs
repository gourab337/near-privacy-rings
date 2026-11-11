//! End-to-end on a local NEAR sandbox: real wasm, real gas.
//! Build the wasm first: `cargo near build non-reproducible-wasm`.
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const WASM: &str = "target/near/near_privacy_rings.wasm";

#[tokio::test]
async fn deposit_and_private_transfer_on_sandbox() -> anyhow_free::Result {
    let f: Value = serde_json::from_str(include_str!("fixtures/dev.json"))?;
    let worker = near_workspaces::sandbox().await?;
    let pool = worker.dev_deploy(&std::fs::read(WASM)?).await?;
    let owner = worker.dev_create_account().await?;
    let init = pool.call("new").args_json(json!({ "owner": owner.id() })).max_gas().transact().await?;
    println!("init     gas burnt: {:.1} Tgas", init.total_gas_burnt.as_gas() as f64 / 1e12);
    init.into_result()?;
    owner.call(pool.id(), "set_token").args_json(json!({ "token": "near", "cap": "1000" })).transact().await?.into_result()?;

    let user = worker.dev_create_account().await?;
    let dep = user
        .call(pool.id(), "transact")
        .args_json(json!({ "args": f["deposit"]["args"], "ext_data": f["deposit"]["ext_data"] }))
        .deposit(NearToken::from_yoctonear(10))
        .max_gas()
        .transact()
        .await?;
    println!("deposit  gas burnt: {:.1} Tgas", dep.total_gas_burnt.as_gas() as f64 / 1e12);
    dep.into_result()?;
    let root: String = pool.view("get_root").await?.json()?;
    assert_eq!(root, f["root_after_deposit"].as_str().unwrap());

    let tr = user
        .call(pool.id(), "transact")
        .args_json(json!({ "args": f["transfer"]["args"], "ext_data": f["transfer"]["ext_data"] }))
        .max_gas()
        .transact()
        .await?;
    println!("transfer gas burnt: {:.1} Tgas", tr.total_gas_burnt.as_gas() as f64 / 1e12);
    tr.into_result()?;
    let root: String = pool.view("get_root").await?.json()?;
    assert_eq!(root, f["root_after_transfer"].as_str().unwrap());
    Ok(())
}

mod anyhow_free {
    pub type Result = std::result::Result<(), Box<dyn std::error::Error>>;
}
