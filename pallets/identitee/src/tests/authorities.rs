use crate::{
	limits::MAX_AUTHORITY_NAME_LEN,
	mock::*,
	types::{AuthorityId, AuthorityInfo, AuthorityName, Capabilities},
	Agents, Authorities, Error, Event, NextAuthorityId,
};
use codec::{Decode, Encode};
use frame_support::{assert_noop, assert_ok, dispatch::CheckIfFeeless};
use sp_runtime::DispatchError;

const ATTEST: Capabilities = Capabilities::ATTEST_FIELDS;
const FACTS: Capabilities = Capabilities::PERSON_FACTS;
const MIGRATE: Capabilities = Capabilities::MIGRATE;

fn name(text: &str) -> AuthorityName {
	AuthorityName::try_from(text.as_bytes().to_vec()).unwrap()
}

/// Registers an authority as root and returns its id.
fn register(text: &str) -> AuthorityId {
	assert_ok!(Identitee::add_authority(RuntimeOrigin::root(), name(text)));
	NextAuthorityId::<Test>::get() - 1
}

fn set_agent(authority: AuthorityId, agent: u64, caps: Capabilities) {
	assert_ok!(Identitee::set_agent(RuntimeOrigin::root(), authority, agent, caps.bits()));
}

fn set_active(authority: AuthorityId, active: bool) {
	assert_ok!(Identitee::set_authority_active(RuntimeOrigin::root(), authority, active));
}

#[test]
fn register_assigns_sequential_ids() {
	new_test_ext().execute_with(|| {
		assert_eq!(NextAuthorityId::<Test>::get(), 0);
		for (expected, label) in ["Alpha", "Beta", "Gamma"].into_iter().enumerate() {
			let id = expected as AuthorityId;
			assert_eq!(register(label), id);
			assert_eq!(
				Authorities::<Test>::get(id),
				Some(AuthorityInfo { name: name(label), active: true })
			);
			System::assert_last_event(Event::AuthorityRegistered { id, name: name(label) }.into());
		}
		assert_eq!(NextAuthorityId::<Test>::get(), 3);
		assert_eq!(Authorities::<Test>::get(3), None);
	});
}

#[test]
fn register_rejects_invalid_utf8() {
	new_test_ext().execute_with(|| {
		let bad = AuthorityName::try_from(vec![0xff, 0xfe]).unwrap();
		assert_noop!(
			Identitee::add_authority(RuntimeOrigin::root(), bad),
			Error::<Test>::InvalidUtf8
		);
		assert_eq!(NextAuthorityId::<Test>::get(), 0);
	});
}

#[test]
fn authority_name_is_bounded() {
	assert!(AuthorityName::try_from(vec![b'a'; MAX_AUTHORITY_NAME_LEN as usize]).is_ok());
	assert!(AuthorityName::try_from(vec![b'a'; MAX_AUTHORITY_NAME_LEN as usize + 1]).is_err());
}

#[test]
fn authorities_are_capped() {
	new_test_ext().execute_with(|| {
		for i in 0..crate::limits::MAX_AUTHORITIES {
			register(&format!("A{i}"));
		}
		assert_noop!(
			Identitee::add_authority(RuntimeOrigin::root(), name("One too many")),
			Error::<Test>::TooManyAuthorities
		);
		assert_eq!(NextAuthorityId::<Test>::get(), crate::limits::MAX_AUTHORITIES);
	});
}

#[test]
#[should_panic(expected = "identitee genesis: authority #16 \"A16\": TooManyAuthorities")]
fn genesis_over_the_authority_cap_panics() {
	let authorities = (0..=crate::limits::MAX_AUTHORITIES)
		.map(|i| authority(&format!("A{i}"), &[]))
		.collect();
	new_test_ext_with(crate::GenesisConfig::<Test> { authorities });
}

#[test]
fn only_root_registers() {
	new_test_ext().execute_with(|| {
		for origin in [RuntimeOrigin::signed(1), RuntimeOrigin::none()] {
			assert_noop!(Identitee::add_authority(origin, name("Alpha")), DispatchError::BadOrigin);
		}
		assert_eq!(NextAuthorityId::<Test>::get(), 0);
		assert_eq!(Authorities::<Test>::get(0), None);
	});
}

#[test]
fn only_root_manages_agents_and_status() {
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		set_agent(id, 10, ATTEST);
		// Neither an ordinary account nor the agent itself may change the registry.
		for who in [1, 10] {
			assert_noop!(
				Identitee::set_agent(RuntimeOrigin::signed(who), id, 11, ATTEST.bits()),
				DispatchError::BadOrigin
			);
			assert_noop!(
				Identitee::remove_agent(RuntimeOrigin::signed(who), 10),
				DispatchError::BadOrigin
			);
			assert_noop!(
				Identitee::set_authority_active(RuntimeOrigin::signed(who), id, false),
				DispatchError::BadOrigin
			);
		}
		assert_noop!(
			Identitee::set_agent(RuntimeOrigin::none(), id, 11, ATTEST.bits()),
			DispatchError::BadOrigin
		);
	});
}

#[test]
fn agent_without_capability_rejected() {
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		set_agent(id, 10, ATTEST);
		System::assert_last_event(
			Event::AgentSet { authority: id, agent: 10, caps: ATTEST }.into(),
		);

		assert_eq!(Identitee::ensure_agent(&10, ATTEST), Ok(id));
		assert_eq!(
			Identitee::ensure_agent(&10, FACTS),
			Err(Error::<Test>::MissingCapability.into())
		);
		assert_eq!(Identitee::ensure_agent(&11, ATTEST), Err(Error::<Test>::NotAnAgent.into()));

		// An agent with no capability at all is meaningless: refused when it is set.
		assert_noop!(
			Identitee::set_agent(RuntimeOrigin::root(), id, 12, 0),
			Error::<Test>::NoCapabilities
		);
		assert_eq!(Agents::<Test>::get(12), None);
	});
}

#[test]
fn inactive_authority_cannot_act() {
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		set_agent(id, 10, ATTEST);
		assert_eq!(Identitee::ensure_agent(&10, ATTEST), Ok(id));

		set_active(id, false);
		System::assert_last_event(
			Event::AuthorityStatusChanged { authority: id, active: false }.into(),
		);
		assert_eq!(
			Identitee::ensure_agent(&10, ATTEST),
			Err(Error::<Test>::AuthorityInactive.into())
		);
		// The authority being inactive is reported before a missing capability.
		assert_eq!(
			Identitee::ensure_agent(&10, FACTS),
			Err(Error::<Test>::AuthorityInactive.into())
		);

		// Setting the same state again is harmless, and reactivating restores the agent.
		set_active(id, false);
		set_active(id, true);
		System::assert_last_event(
			Event::AuthorityStatusChanged { authority: id, active: true }.into(),
		);
		assert_eq!(Identitee::ensure_agent(&10, ATTEST), Ok(id));
	});
}

#[test]
fn migrate_only_agent_cannot_attest() {
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		set_agent(id, 10, MIGRATE);
		assert_eq!(Identitee::ensure_agent(&10, MIGRATE), Ok(id));
		for cap in [ATTEST, FACTS, Capabilities::MANAGE_NAMES] {
			assert_eq!(
				Identitee::ensure_agent(&10, cap),
				Err(Error::<Test>::MissingCapability.into())
			);
		}
	});
}

#[test]
fn agent_with_several_capabilities() {
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		set_agent(id, 10, ATTEST | MIGRATE);
		assert_eq!(Identitee::ensure_agent(&10, ATTEST), Ok(id));
		assert_eq!(Identitee::ensure_agent(&10, MIGRATE), Ok(id));
		assert_eq!(Identitee::ensure_agent(&10, ATTEST | MIGRATE), Ok(id));
		// Asking for several capabilities needs all of them.
		assert_eq!(
			Identitee::ensure_agent(&10, ATTEST | FACTS),
			Err(Error::<Test>::MissingCapability.into())
		);
	});
}

#[test]
fn set_agent_requires_a_registered_authority() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Identitee::set_agent(RuntimeOrigin::root(), 0, 10, ATTEST.bits()),
			Error::<Test>::UnknownAuthority
		);
		let id = register("Alpha");
		assert_noop!(
			Identitee::set_agent(RuntimeOrigin::root(), id + 1, 10, ATTEST.bits()),
			Error::<Test>::UnknownAuthority
		);
		assert_noop!(
			Identitee::set_authority_active(RuntimeOrigin::root(), id + 1, false),
			Error::<Test>::UnknownAuthority
		);
	});
}

#[test]
fn set_agent_rejects_unknown_capability_bits() {
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		for bits in [0b1_0000, 0xff, 0b1_0001] {
			assert_noop!(
				Identitee::set_agent(RuntimeOrigin::root(), id, 10, bits),
				Error::<Test>::UnknownCapabilities
			);
		}
		// All four known capabilities together are fine.
		assert_ok!(Identitee::set_agent(RuntimeOrigin::root(), id, 10, 0b1111));
	});
}

#[test]
fn an_account_is_agent_of_one_authority_only() {
	new_test_ext().execute_with(|| {
		let first = register("Alpha");
		let second = register("Beta");
		set_agent(first, 10, ATTEST);

		assert_noop!(
			Identitee::set_agent(RuntimeOrigin::root(), second, 10, ATTEST.bits()),
			Error::<Test>::AgentOfAnotherAuthority
		);
		assert_eq!(Agents::<Test>::get(10), Some((first, ATTEST)));

		// Updating the capabilities within the same authority is allowed.
		set_agent(first, 10, MIGRATE);
		assert_eq!(Agents::<Test>::get(10), Some((first, MIGRATE)));
		assert_eq!(
			Identitee::ensure_agent(&10, ATTEST),
			Err(Error::<Test>::MissingCapability.into())
		);

		// Moving it to another authority takes an explicit removal first.
		assert_ok!(Identitee::remove_agent(RuntimeOrigin::root(), 10));
		set_agent(second, 10, ATTEST);
		assert_eq!(Identitee::ensure_agent(&10, ATTEST), Ok(second));
	});
}

#[test]
fn remove_agent_takes_effect_at_once() {
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		set_agent(id, 10, ATTEST);
		assert_ok!(Identitee::remove_agent(RuntimeOrigin::root(), 10));
		System::assert_last_event(Event::AgentRemoved { authority: id, agent: 10 }.into());
		assert_eq!(Agents::<Test>::get(10), None);
		assert_eq!(Identitee::ensure_agent(&10, ATTEST), Err(Error::<Test>::NotAnAgent.into()));

		assert_noop!(Identitee::remove_agent(RuntimeOrigin::root(), 10), Error::<Test>::NotAnAgent);
	});
}

#[test]
fn capabilities_are_a_plain_u8() {
	assert_eq!(ATTEST.encode(), vec![1]);
	assert_eq!(FACTS.encode(), vec![2]);
	assert_eq!(Capabilities::MANAGE_NAMES.encode(), vec![4]);
	assert_eq!(MIGRATE.encode(), vec![8]);
	assert_eq!((ATTEST | MIGRATE).encode(), vec![9]);
	assert_eq!(Capabilities::decode(&mut &[5u8][..]).unwrap(), ATTEST | Capabilities::MANAGE_NAMES);
	// The registry value is `(u32, u8)` on the wire.
	assert_eq!((7u32, ATTEST | FACTS).encode(), (7u32, 3u8).encode());
}

#[test]
fn capabilities_contain_what_they_were_built_from() {
	let both = ATTEST | MIGRATE;
	assert!(both.contains(ATTEST));
	assert!(both.contains(MIGRATE));
	assert!(both.contains(both));
	assert!(!both.contains(FACTS));
	assert!(!both.contains(ATTEST | FACTS));
	assert!(!ATTEST.contains(both));
	assert_eq!(Capabilities::from_bits(0b1111).map(Capabilities::bits), Some(0b1111));
	assert_eq!(Capabilities::from_bits(0b1_0000), None);
	assert!(Capabilities::from_bits(0).unwrap().is_empty());
}

#[test]
fn agent_calls_are_feeless_only_for_active_agents() {
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		set_agent(id, 10, MIGRATE);
		let feeless = |origin: RuntimeOrigin| Identitee::agent_call_feeless(&origin, MIGRATE);

		assert!(feeless(RuntimeOrigin::signed(10)));
		// Not an agent, or not signed at all.
		assert!(!feeless(RuntimeOrigin::signed(11)));
		assert!(!feeless(RuntimeOrigin::root()));
		assert!(!feeless(RuntimeOrigin::none()));

		// The authority being deactivated switches it off, reactivating switches it back on.
		set_active(id, false);
		assert!(!feeless(RuntimeOrigin::signed(10)));
		set_active(id, true);
		assert!(feeless(RuntimeOrigin::signed(10)));

		assert_ok!(Identitee::remove_agent(RuntimeOrigin::root(), 10));
		assert!(!feeless(RuntimeOrigin::signed(10)));
	});
}

#[test]
fn agent_call_feeless_does_not_write() {
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		set_agent(id, 10, ATTEST);
		frame_support::assert_storage_noop!({
			assert!(Identitee::agent_call_feeless(&RuntimeOrigin::signed(10), ATTEST));
			assert!(!Identitee::agent_call_feeless(&RuntimeOrigin::signed(10), FACTS));
			assert!(!Identitee::agent_call_feeless(&RuntimeOrigin::signed(11), ATTEST));
		});
	});
}

#[test]
fn registry_calls_are_never_feeless() {
	use crate::Call;
	new_test_ext().execute_with(|| {
		let id = register("Alpha");
		set_agent(id, 10, Capabilities::ALL);
		let calls = [
			Call::<Test>::add_authority { name: name("Beta") },
			Call::set_agent { authority: id, agent: 11, caps: ATTEST.bits() },
			Call::remove_agent { agent: 10 },
			Call::set_authority_active { authority: id, active: false },
		];
		for call in calls {
			assert!(!call.counts_against_quota(), "{call:?}");
			// Not even for an active agent: these calls are root-only.
			for origin in
				[RuntimeOrigin::signed(10), RuntimeOrigin::signed(1), RuntimeOrigin::root()]
			{
				assert!(!RuntimeCall::Identitee(call.clone()).is_feeless(&origin), "{call:?}");
			}
		}
	});
}

#[test]
fn genesis_seeds_authorities_and_agents() {
	let config = crate::GenesisConfig::<Test> {
		authorities: vec![
			authority("Alpha", &[(10, ATTEST.bits()), (11, (ATTEST | FACTS).bits())]),
			authority("Beta", &[]),
			authority("Gamma", &[(12, MIGRATE.bits())]),
		],
	};
	new_test_ext_with(config).execute_with(|| {
		assert_eq!(NextAuthorityId::<Test>::get(), 3);
		for (id, label) in ["Alpha", "Beta", "Gamma"].into_iter().enumerate() {
			assert_eq!(
				Authorities::<Test>::get(id as AuthorityId),
				Some(AuthorityInfo { name: name(label), active: true })
			);
		}
		assert_eq!(Agents::<Test>::get(10), Some((0, ATTEST)));
		assert_eq!(Agents::<Test>::get(11), Some((0, ATTEST | FACTS)));
		assert_eq!(Agents::<Test>::get(12), Some((2, MIGRATE)));
		assert_eq!(Agents::<Test>::iter().count(), 3);
		assert_eq!(Identitee::ensure_agent(&12, MIGRATE), Ok(2));
		assert!(Identitee::agent_call_feeless(&RuntimeOrigin::signed(10), ATTEST));

		// Authorities registered afterwards continue the numbering.
		assert_eq!(register("Delta"), 3);
	});
}

#[test]
fn genesis_is_empty_by_default() {
	new_test_ext().execute_with(|| {
		assert_eq!(NextAuthorityId::<Test>::get(), 0);
		assert_eq!(Authorities::<Test>::iter().count(), 0);
		assert_eq!(Agents::<Test>::iter().count(), 0);
	});
}

#[test]
fn genesis_reads_from_json() {
	// The shape a chain spec preset uses: named fields, the name as a string.
	let json = r#"{ "authorities": [
		{ "name": "Alpha", "agents": [{ "account": 10, "caps": 15 }, { "account": 11, "caps": 8 }] },
		{ "name": "Beta", "agents": [] }
	] }"#;
	let config: crate::GenesisConfig<Test> = serde_json::from_str(json).unwrap();
	assert_eq!(
		config.authorities,
		vec![authority("Alpha", &[(10, 15), (11, 8)]), authority("Beta", &[])]
	);
	// And back: what a preset writes is what it reads.
	let written = serde_json::to_value(&config).unwrap();
	assert_eq!(written, serde_json::from_str::<serde_json::Value>(json).unwrap());
}

#[test]
fn genesis_json_rejects_unknown_or_missing_keys() {
	for json in [
		r#"{ "authorities": [{ "name": "Alpha", "agents": [], "active": true }] }"#,
		r#"{ "authorities": [{ "name": "Alpha", "agents": [{ "account": 10, "caps": 1, "x": 0 }] }] }"#,
		r#"{ "authorities": [{ "name": "Alpha" }] }"#,
		r#"{ "authorities": [{ "name": "Alpha", "agents": [{ "account": 10 }] }] }"#,
	] {
		assert!(serde_json::from_str::<crate::GenesisConfig<Test>>(json).is_err(), "{json}");
	}
}

#[test]
#[should_panic(expected = "identitee genesis: authority #0 \"Alpha\": agent 10: NoCapabilities")]
fn genesis_rejects_an_agent_without_capability() {
	let config = crate::GenesisConfig::<Test> { authorities: vec![authority("Alpha", &[(10, 0)])] };
	let _ = new_test_ext_with(config);
}

#[test]
#[should_panic(
	expected = "identitee genesis: authority #1 \"Beta\": agent 10: AgentOfAnotherAuthority"
)]
fn genesis_rejects_an_agent_of_two_authorities() {
	let config = crate::GenesisConfig::<Test> {
		authorities: vec![
			authority("Alpha", &[(10, ATTEST.bits())]),
			authority("Beta", &[(10, ATTEST.bits())]),
		],
	};
	let _ = new_test_ext_with(config);
}

#[test]
#[should_panic(expected = "identitee genesis: authority #0 \"aaaa")]
fn genesis_rejects_a_name_too_long() {
	let too_long = "a".repeat(MAX_AUTHORITY_NAME_LEN as usize + 1);
	let _ = new_test_ext_with(crate::GenesisConfig::<Test> {
		authorities: vec![authority(&too_long, &[])],
	});
}
