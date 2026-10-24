use identitee_runtime::{configs::SS58Prefix, WASM_BINARY};
use sc_service::{ChainType, Properties};

/// The chain spec type of the node.
pub type ChainSpec = sc_service::GenericChainSpec;

/// Ticker shown by wallets and explorers.
const TOKEN_SYMBOL: &str = "IDT";
/// Must match the unit definitions in the runtime (`UNIT = 10^12`) and the metadata hash
/// configuration in `runtime/build.rs`.
const TOKEN_DECIMALS: u32 = 12;

/// Chain properties read by polkadot.js/apps: SS58 prefix, ticker and number of decimals.
fn chain_properties() -> Properties {
	let mut properties = Properties::new();
	properties.insert("ss58Format".into(), SS58Prefix::get().into());
	properties.insert("tokenSymbol".into(), TOKEN_SYMBOL.into());
	properties.insert("tokenDecimals".into(), TOKEN_DECIMALS.into());
	properties
}

pub fn development_chain_spec() -> Result<ChainSpec, String> {
	Ok(ChainSpec::builder(
		WASM_BINARY.ok_or_else(|| "Development wasm not available".to_string())?,
		None,
	)
	.with_name("Identitee Development")
	.with_id("identitee_dev")
	.with_chain_type(ChainType::Development)
	.with_genesis_config_preset_name(sp_genesis_builder::DEV_RUNTIME_PRESET)
	.with_properties(chain_properties())
	.build())
}

pub fn local_chain_spec() -> Result<ChainSpec, String> {
	Ok(ChainSpec::builder(
		WASM_BINARY.ok_or_else(|| "Development wasm not available".to_string())?,
		None,
	)
	.with_name("Identitee Local")
	.with_id("identitee_local")
	.with_chain_type(ChainType::Local)
	.with_genesis_config_preset_name(sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET)
	.with_properties(chain_properties())
	.build())
}

/// The public testnet served at wss://rpc.identit.ee. Its raw form is committed as
/// `deploy/chainspec/identitee-testnet-raw.json`: testnet nodes run that file, not this builder,
/// so that the genesis stays fixed whatever the binary.
pub fn identitee_testnet_chain_spec() -> Result<ChainSpec, String> {
	Ok(ChainSpec::builder(
		WASM_BINARY.ok_or_else(|| "Testnet wasm not available".to_string())?,
		None,
	)
	.with_name("Identitee Testnet")
	.with_id("identitee_testnet")
	.with_chain_type(ChainType::Live)
	.with_genesis_config_preset_name(
		identitee_runtime::genesis_config_presets::IDENTITEE_TESTNET_PRESET,
	)
	.with_properties(chain_properties())
	.build())
}
