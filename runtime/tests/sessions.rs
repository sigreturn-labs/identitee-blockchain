//! Sessions: the upgrade of a chain started without them (runtime 8) and adding a validator.
//!
//! The pre-upgrade chain is rebuilt as runtime 8 left it: Aura and GRANDPA authorities from
//! genesis, a sudo key, no session state. The migration must make the sudo account the validator
//! of the existing keys without changing any authority, and a validator added afterwards must
//! reach Aura and GRANDPA two sessions later.

use codec::Encode;
use frame_support::{
	assert_noop, assert_ok,
	traits::{GetCallName, OnRuntimeUpgrade},
};
use identitee_runtime::{
	migrations::SessionFromConsensus, AccountId, Runtime, RuntimeCall, RuntimeGenesisConfig,
	RuntimeOrigin, SessionKeys,
};
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_consensus_grandpa::AuthorityId as GrandpaId;
use sp_keyring::{Ed25519Keyring, Sr25519Keyring};
use sp_runtime::{traits::Dispatchable, BuildStorage};

fn alice() -> AccountId {
	Sr25519Keyring::Alice.to_account_id()
}

fn keys_of(sr: Sr25519Keyring, ed: Ed25519Keyring) -> SessionKeys {
	SessionKeys { aura: AuraId::from(sr.public()), grandpa: GrandpaId::from(ed.public()) }
}

/// A chain as runtime 8 built it: Alice's keys as the only authority, Alice as sudo.
fn runtime_8_chain() -> sp_io::TestExternalities {
	let config = RuntimeGenesisConfig {
		aura: pallet_aura::GenesisConfig {
			authorities: vec![AuraId::from(Sr25519Keyring::Alice.public())],
		},
		grandpa: pallet_grandpa::GenesisConfig {
			authorities: vec![(GrandpaId::from(Ed25519Keyring::Alice.public()), 1)],
			..Default::default()
		},
		balances: pallet_balances::GenesisConfig {
			balances: vec![(alice(), 1 << 60)],
			..Default::default()
		},
		sudo: pallet_sudo::GenesisConfig { key: Some(alice()) },
		..Default::default()
	};
	let mut ext = sp_io::TestExternalities::new(config.build_storage().unwrap());
	ext.execute_with(|| frame_system::Pallet::<Runtime>::set_block_number(1));
	ext
}

fn aura_authorities() -> Vec<AuraId> {
	pallet_aura::Authorities::<Runtime>::get().into_inner()
}

fn next_session() {
	pallet_session::Pallet::<Runtime>::rotate_session();
}

#[test]
fn the_runtime_8_chain_has_no_session_state() {
	runtime_8_chain().execute_with(|| {
		assert!(pallet_session::Validators::<Runtime>::get().is_empty());
		assert!(pallet_validators::Validators::<Runtime>::get().is_empty());
		assert_eq!(aura_authorities(), vec![AuraId::from(Sr25519Keyring::Alice.public())]);
	});
}

#[test]
fn the_migration_makes_sudo_the_validator_of_the_current_keys() {
	runtime_8_chain().execute_with(|| {
		SessionFromConsensus::on_runtime_upgrade();
		let keys = keys_of(Sr25519Keyring::Alice, Ed25519Keyring::Alice);
		assert_eq!(pallet_validators::Validators::<Runtime>::get().into_inner(), vec![alice()]);
		assert_eq!(pallet_session::Validators::<Runtime>::get(), vec![alice()]);
		assert_eq!(pallet_session::QueuedKeys::<Runtime>::get(), vec![(alice(), keys.clone())]);
		assert_eq!(pallet_session::NextKeys::<Runtime>::get(alice()), Some(keys));

		// Sessions go on with the same authorities, and GRANDPA schedules no change.
		let set_id = pallet_grandpa::CurrentSetId::<Runtime>::get();
		next_session();
		next_session();
		assert_eq!(aura_authorities(), vec![AuraId::from(Sr25519Keyring::Alice.public())]);
		assert!(pallet_grandpa::PendingChange::<Runtime>::get().is_none());
		assert_eq!(pallet_grandpa::CurrentSetId::<Runtime>::get(), set_id);
	});
}

#[test]
fn the_migration_runs_once() {
	runtime_8_chain().execute_with(|| {
		SessionFromConsensus::on_runtime_upgrade();
		let before = pallet_session::QueuedKeys::<Runtime>::get();
		SessionFromConsensus::on_runtime_upgrade();
		assert_eq!(pallet_session::QueuedKeys::<Runtime>::get(), before);
		assert_eq!(pallet_validators::Validators::<Runtime>::get().len(), 1);
	});
}

#[test]
fn an_added_validator_reaches_aura_and_grandpa_two_sessions_later() {
	runtime_8_chain().execute_with(|| {
		SessionFromConsensus::on_runtime_upgrade();
		let bob = Sr25519Keyring::Bob.to_account_id();
		let call = RuntimeCall::Validators(pallet_validators::Call::add_validator {
			who: bob.clone(),
			keys: keys_of(Sr25519Keyring::Bob, Ed25519Keyring::Bob),
		});
		assert_noop!(
			call.clone().dispatch(RuntimeOrigin::signed(alice())),
			sp_runtime::DispatchError::BadOrigin
		);
		assert_ok!(call.dispatch(RuntimeOrigin::root()));

		next_session();
		assert_eq!(aura_authorities().len(), 1);
		next_session();
		assert_eq!(
			aura_authorities(),
			vec![
				AuraId::from(Sr25519Keyring::Alice.public()),
				AuraId::from(Sr25519Keyring::Bob.public())
			]
		);
		let pending = pallet_grandpa::PendingChange::<Runtime>::get().expect("GRANDPA change");
		let next: Vec<GrandpaId> =
			pending.next_authorities.iter().map(|(k, _)| k.clone()).collect();
		assert_eq!(
			next,
			vec![
				GrandpaId::from(Ed25519Keyring::Alice.public()),
				GrandpaId::from(Ed25519Keyring::Bob.public())
			]
		);
		assert_eq!(pallet_session::Validators::<Runtime>::get(), vec![alice(), bob]);
	});
}

/// Pallet and call indices of the validator calls: wallets and the operator's transactions
/// carry these bytes.
#[test]
fn validator_call_indices() {
	assert_eq!(
		pallet_validators::Call::<Runtime>::get_call_names(),
		&["add_validator", "remove_validator"]
	);
	let call = RuntimeCall::Validators(pallet_validators::Call::remove_validator { who: alice() });
	assert_eq!(&call.encode()[..2], &[9, 1]);
	let call = RuntimeCall::Session(pallet_session::Call::purge_keys {});
	assert_eq!(&call.encode()[..2], &[10, 1]);
}
