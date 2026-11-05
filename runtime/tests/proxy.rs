//! Sudo proxies: the sudo account adds a second operator key that may send sudo calls for it, and
//! nothing else. The wrapped call may not touch the sudo key, and the proxy cannot add or remove
//! proxies.

use codec::Encode;
use frame_support::traits::fungible::Inspect;
use identitee_runtime::{
	configs::ProxyType, genesis_config_presets::local_config_genesis, AccountId, Balances, Proxy,
	Runtime, RuntimeCall, RuntimeEvent, RuntimeGenesisConfig, RuntimeOrigin, System, UNIT,
};
use sp_keyring::Sr25519Keyring;
use sp_runtime::{BuildStorage, DispatchError};

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

/// The local preset: Alice is sudo, and the dev accounts are endowed.
fn local_chain() -> sp_io::TestExternalities {
	let mut config = serde_json::to_value(RuntimeGenesisConfig::default()).unwrap();
	merge(&mut config, local_config_genesis());
	let config: RuntimeGenesisConfig = serde_json::from_value(config).unwrap();
	let mut ext = sp_io::TestExternalities::new(config.build_storage().unwrap());
	ext.execute_with(|| System::set_block_number(1));
	ext
}

fn alice() -> AccountId {
	Sr25519Keyring::Alice.to_account_id()
}

fn bob() -> AccountId {
	Sr25519Keyring::Bob.to_account_id()
}

fn charlie() -> AccountId {
	Sr25519Keyring::Charlie.to_account_id()
}

fn sudo(call: RuntimeCall) -> RuntimeCall {
	RuntimeCall::Sudo(pallet_sudo::Call::sudo { call: Box::new(call) })
}

fn set_balance(who: AccountId, amount: u128) -> RuntimeCall {
	RuntimeCall::Balances(pallet_balances::Call::force_set_balance {
		who: who.into(),
		new_free: amount,
	})
}

/// Alice, sudo, makes Bob her sudo proxy.
fn add_bob() {
	Proxy::add_proxy(RuntimeOrigin::signed(alice()), bob().into(), ProxyType::Sudo, 0).unwrap();
}

/// Bob sends `call` for Alice, and returns what the wrapped call gave.
fn bob_sends(call: RuntimeCall) -> Result<(), DispatchError> {
	System::reset_events();
	Proxy::proxy(RuntimeOrigin::signed(bob()), alice().into(), None, Box::new(call)).unwrap();
	System::events()
		.into_iter()
		.find_map(|r| match r.event {
			RuntimeEvent::Proxy(pallet_proxy::Event::ProxyExecuted { result }) => Some(result),
			_ => None,
		})
		.expect("the proxy call ran")
}

#[test]
fn the_pallet_is_at_index_12() {
	let call = RuntimeCall::Proxy(pallet_proxy::Call::remove_proxies {});
	assert_eq!(call.encode()[0], 12);
}

#[test]
fn a_sudo_proxy_sends_sudo_calls() {
	local_chain().execute_with(|| {
		add_bob();
		assert_eq!(bob_sends(sudo(set_balance(charlie(), 5 * UNIT))), Ok(()));
		assert_eq!(Balances::balance(&charlie()), 5 * UNIT);

		let unchecked = RuntimeCall::Sudo(pallet_sudo::Call::sudo_unchecked_weight {
			call: Box::new(set_balance(charlie(), 7 * UNIT)),
			weight: Default::default(),
		});
		assert_eq!(bob_sends(unchecked), Ok(()));
		assert_eq!(Balances::balance(&charlie()), 7 * UNIT);
	});
}

#[test]
fn a_sudo_proxy_cannot_spend_from_the_sudo_account() {
	local_chain().execute_with(|| {
		add_bob();
		let before = Balances::balance(&charlie());
		let transfer = RuntimeCall::Balances(pallet_balances::Call::transfer_keep_alive {
			dest: charlie().into(),
			value: UNIT,
		});
		assert_eq!(bob_sends(transfer), Err(frame_system::Error::<Runtime>::CallFiltered.into()));
		assert_eq!(Balances::balance(&charlie()), before);
	});
}

#[test]
fn a_sudo_proxy_cannot_change_the_sudo_key() {
	local_chain().execute_with(|| {
		add_bob();
		let set_key = RuntimeCall::Sudo(pallet_sudo::Call::set_key { new: bob().into() });
		let filtered = Err(frame_system::Error::<Runtime>::CallFiltered.into());
		assert_eq!(bob_sends(set_key.clone()), filtered);
		assert_eq!(bob_sends(sudo(set_key)), filtered);
		let remove_key = RuntimeCall::Sudo(pallet_sudo::Call::remove_key {});
		assert_eq!(bob_sends(sudo(remove_key)), filtered);
		assert_eq!(pallet_sudo::Key::<Runtime>::get(), Some(alice()));
	});
}

#[test]
fn a_sudo_proxy_cannot_manage_proxies() {
	local_chain().execute_with(|| {
		add_bob();
		let filtered = Err(frame_system::Error::<Runtime>::CallFiltered.into());
		let add = RuntimeCall::Proxy(pallet_proxy::Call::add_proxy {
			delegate: charlie().into(),
			proxy_type: ProxyType::Sudo,
			delay: 0,
		});
		assert_eq!(bob_sends(add), filtered);
		assert_eq!(bob_sends(RuntimeCall::Proxy(pallet_proxy::Call::remove_proxies {})), filtered);
		assert_eq!(pallet_proxy::Proxies::<Runtime>::get(alice()).0.len(), 1);
	});
}

#[test]
fn the_sudo_account_removes_its_proxy() {
	local_chain().execute_with(|| {
		add_bob();
		Proxy::remove_proxy(RuntimeOrigin::signed(alice()), bob().into(), ProxyType::Sudo, 0)
			.unwrap();
		assert!(Proxy::proxy(
			RuntimeOrigin::signed(bob()),
			alice().into(),
			None,
			Box::new(sudo(set_balance(charlie(), UNIT)))
		)
		.is_err());
	});
}

#[test]
fn adding_a_proxy_holds_a_deposit() {
	local_chain().execute_with(|| {
		let before = Balances::reserved_balance(&alice());
		add_bob();
		assert_eq!(Balances::reserved_balance(&alice()), before + UNIT + UNIT / 10);
	});
}
