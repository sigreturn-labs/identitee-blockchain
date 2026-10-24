//! The `identitee_testnet` genesis preset: the public testnet served at wss://rpc.identit.ee.
//!
//! Builds the real genesis storage from the preset (as `export-chain-spec` does) and checks the
//! values the deployment relies on: the validator's session keys, the owner as sudo and full agent,
//! the migrator, the verifier.

use identitee_runtime::{
	genesis_config_presets::{
		get_preset, preset_names, IDENTITEE_TESTNET_PRESET, TESTNET_AURA, TESTNET_GRANDPA,
		TESTNET_MIGRATOR, TESTNET_OWNER, TESTNET_VERIFIER,
	},
	Runtime, RuntimeGenesisConfig, UNIT,
};
use pallet_identitee::types::{AuthorityInfo, Capabilities};
use sp_runtime::{AccountId32, BuildStorage};

/// The testnet operator account, written out independently of the preset.
const OWNER: [u8; 32] = [
	0xfa, 0xfe, 0x6f, 0xf6, 0x94, 0x5e, 0x27, 0xf3, 0xc3, 0x9f, 0xe8, 0xbf, 0x5a, 0x90, 0xcb, 0x0f,
	0xa6, 0x1b, 0x3c, 0x27, 0xc9, 0xfa, 0xa3, 0xba, 0x37, 0x41, 0x36, 0x26, 0x43, 0xee, 0x30, 0x3f,
];

fn merge(base: &mut serde_json::Value, patch: serde_json::Value) {
	match (base, patch) {
		(serde_json::Value::Object(base), serde_json::Value::Object(patch)) => {
			for (key, value) in patch {
				merge(base.entry(key).or_insert(serde_json::Value::Null), value);
			}
		},
		(base, patch) => *base = patch,
	}
}

fn testnet_ext() -> sp_io::TestExternalities {
	let preset = get_preset(&IDENTITEE_TESTNET_PRESET.into()).expect("testnet preset exists");
	let patch: serde_json::Value = serde_json::from_slice(&preset).expect("valid preset JSON");
	let mut config = serde_json::to_value(RuntimeGenesisConfig::default()).unwrap();
	merge(&mut config, patch);
	let config: RuntimeGenesisConfig =
		serde_json::from_value(config).expect("merged config deserializes");
	sp_io::TestExternalities::new(config.build_storage().expect("genesis storage builds"))
}

#[test]
fn testnet_preset_is_listed() {
	assert!(preset_names().contains(&IDENTITEE_TESTNET_PRESET.into()));
	assert_eq!(IDENTITEE_TESTNET_PRESET, "identitee_testnet");
}

#[test]
fn testnet_owner_key() {
	assert_eq!(TESTNET_OWNER, OWNER);
	assert_ne!(TESTNET_MIGRATOR, OWNER);
}

#[test]
fn testnet_verifier_key() {
	let hex: String = TESTNET_VERIFIER.iter().map(|b| format!("{b:02x}")).collect();
	assert_eq!(hex, "84a13ca0a7873fc954090b91368de6674d96850466119e42d5c9f24b57ab2c5f");
	assert_ne!(TESTNET_VERIFIER, OWNER);
	assert_ne!(TESTNET_VERIFIER, TESTNET_MIGRATOR);
}

#[test]
fn testnet_genesis_values() {
	let owner = AccountId32::from(OWNER);
	let migrator = AccountId32::from(TESTNET_MIGRATOR);
	let verifier = AccountId32::from(TESTNET_VERIFIER);
	testnet_ext().execute_with(|| {
		// Sudo is the owner, endowed with 1 000 000 IDT; nobody else holds a balance.
		assert_eq!(pallet_sudo::Key::<Runtime>::get(), Some(owner.clone()));
		assert_eq!(pallet_balances::Pallet::<Runtime>::free_balance(&owner), 1_000_000 * UNIT);
		assert_eq!(pallet_balances::TotalIssuance::<Runtime>::get(), 1_000_000 * UNIT);

		// One validator: its Aura (sr25519) and GRANDPA (ed25519) keys.
		let aura: Vec<[u8; 32]> = pallet_aura::Authorities::<Runtime>::get()
			.into_iter()
			.map(|k| <[u8; 32]>::try_from(AsRef::<[u8]>::as_ref(&k)).unwrap())
			.collect();
		assert_eq!(aura, vec![TESTNET_AURA]);
		let grandpa: Vec<([u8; 32], u64)> =
			pallet_grandpa::Pallet::<Runtime>::grandpa_authorities()
				.into_iter()
				.map(|(k, w)| (<[u8; 32]>::try_from(AsRef::<[u8]>::as_ref(&k)).unwrap(), w))
				.collect();
		assert_eq!(grandpa, vec![(TESTNET_GRANDPA, 1)]);

		// Authority 0 "identitee": the owner with every capability, the migrator with MIGRATE only,
		// the verifier with ATTEST_FIELDS and PERSON_FACTS.
		assert_eq!(
			pallet_identitee::Authorities::<Runtime>::get(0),
			Some(AuthorityInfo { name: b"identitee".to_vec().try_into().unwrap(), active: true })
		);
		assert_eq!(pallet_identitee::Agents::<Runtime>::get(&owner), Some((0, Capabilities::ALL)));
		assert_eq!(Capabilities::ALL.bits(), 15);
		assert_eq!(
			pallet_identitee::Agents::<Runtime>::get(&migrator),
			Some((0, Capabilities::MIGRATE))
		);
		assert_eq!(Capabilities::MIGRATE.bits(), 8);
		assert_eq!(
			pallet_identitee::Agents::<Runtime>::get(&verifier).map(|(a, c)| (a, c.bits())),
			Some((0, 3))
		);
		assert_eq!(
			pallet_identitee::Agents::<Runtime>::get(&verifier),
			Some((0, Capabilities::ATTEST_FIELDS | Capabilities::PERSON_FACTS))
		);
		assert_eq!(pallet_identitee::Agents::<Runtime>::iter().count(), 3);
		// The verifier holds no balance: its calls are feeless agent calls.
		assert_eq!(pallet_balances::Pallet::<Runtime>::free_balance(&verifier), 0);
	});
}
