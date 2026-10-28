//! Block rewards: the author of each block, found from its Aura slot, earns 10 IDT, and the fees of
//! the block go to it too.

use codec::Encode;
use frame_support::traits::{
	fungible::{Balanced, Inspect},
	Hooks, OnUnbalanced,
};
use identitee_runtime::{
	configs::{FeesToAuthor, BLOCK_REWARD},
	genesis_config_presets::local_config_genesis,
	AccountId, Balances, Runtime, RuntimeGenesisConfig, UNIT,
};
use sp_consensus_aura::{Slot, AURA_ENGINE_ID};
use sp_keyring::Sr25519Keyring;
use sp_runtime::{BuildStorage, Digest, DigestItem};

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

/// The local preset: Alice and Bob validate, in that order.
fn local_chain() -> sp_io::TestExternalities {
	let mut config = serde_json::to_value(RuntimeGenesisConfig::default()).unwrap();
	merge(&mut config, local_config_genesis());
	let config: RuntimeGenesisConfig = serde_json::from_value(config).unwrap();
	sp_io::TestExternalities::new(config.build_storage().unwrap())
}

/// Starts block 1 claiming Aura slot `slot`, and runs the authorship hook that notes its author.
fn start_block(slot: u64) {
	let digest =
		Digest { logs: vec![DigestItem::PreRuntime(AURA_ENGINE_ID, Slot::from(slot).encode())] };
	frame_system::Pallet::<Runtime>::initialize(&1, &Default::default(), &digest);
	pallet_authorship::Pallet::<Runtime>::on_initialize(1);
}

fn balance(who: &AccountId) -> u128 {
	Balances::balance(who)
}

#[test]
fn the_reward_is_ten_idt() {
	assert_eq!(BLOCK_REWARD, 10 * UNIT);
}

#[test]
fn the_slot_owner_earns_the_block_reward() {
	let alice = Sr25519Keyring::Alice.to_account_id();
	let bob = Sr25519Keyring::Bob.to_account_id();
	local_chain().execute_with(|| {
		let (a, b) = (balance(&alice), balance(&bob));
		let issuance = Balances::total_issuance();
		// Two validators: odd slots belong to the second, Bob.
		start_block(7);
		assert_eq!(pallet_authorship::Pallet::<Runtime>::author(), Some(bob.clone()));
		assert_eq!(balance(&bob), b + BLOCK_REWARD);
		assert_eq!(balance(&alice), a);
		assert_eq!(Balances::total_issuance(), issuance + BLOCK_REWARD);
	});
}

#[test]
fn fees_go_to_the_author() {
	let alice = Sr25519Keyring::Alice.to_account_id();
	local_chain().execute_with(|| {
		start_block(8);
		let before = balance(&alice);
		let issuance = Balances::total_issuance();
		FeesToAuthor::on_unbalanced(Balances::issue(3 * UNIT));
		assert_eq!(balance(&alice), before + 3 * UNIT);
		assert_eq!(Balances::total_issuance(), issuance + 3 * UNIT);
	});
}
