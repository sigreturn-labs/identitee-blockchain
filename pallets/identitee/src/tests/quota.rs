use crate::{
	limits::{GLOBAL_FEELESS_PER_BLOCK, QUOTA_PER_WINDOW},
	mock::*,
	types::Bio,
	BlockFeelessOps, Usage,
};
use frame_support::{assert_ok, dispatch::CheckIfFeeless, traits::Hooks};

/// Quota window of the mock runtime, in blocks.
const WINDOW: u64 = QUOTA_WINDOW_BLOCKS;

fn set_bio_call() -> RuntimeCall {
	RuntimeCall::Identitee(crate::Call::set_bio { bio: Bio::try_from(b"x".to_vec()).unwrap() })
}

/// Ends the current block and starts the next one, running the identitee hooks.
fn next_block() {
	let now = System::block_number();
	Identitee::on_finalize(now);
	System::set_block_number(now + 1);
	Identitee::on_initialize(now + 1);
}

/// Jumps to block `n` through a block boundary, so the per-block counter is reset.
fn jump_to(n: u64) {
	Identitee::on_finalize(System::block_number());
	System::set_block_number(n);
	Identitee::on_initialize(n);
}

#[test]
fn fifty_writes_per_day_then_blocked() {
	new_test_ext().execute_with(|| {
		// The quota is larger than the per-block cap: the calls span a few blocks.
		for _ in 0..QUOTA_PER_WINDOW {
			if !Identitee::block_cap_available() {
				next_block();
			}
			assert!(Identitee::feeless_allowed(&1));
			Identitee::note_usage(&1);
		}
		if !Identitee::block_cap_available() {
			next_block();
		}
		assert!(!Identitee::feeless_allowed(&1));
		assert!(!set_bio_call().is_feeless(&RuntimeOrigin::signed(1)));
		// Another account is not affected.
		assert!(Identitee::feeless_allowed(&2));

		// The window opened at block 1: still closed on its last block, open again after it.
		jump_to(1 + WINDOW - 1);
		assert!(!Identitee::feeless_allowed(&1));
		jump_to(1 + WINDOW);
		assert!(Identitee::feeless_allowed(&1));
		assert!(set_bio_call().is_feeless(&RuntimeOrigin::signed(1)));

		// The first use in the new window restarts the count from there.
		Identitee::note_usage(&1);
		assert_eq!(Usage::<Test>::get(1), Some((1 + WINDOW, 1)));
	});
}

#[test]
fn window_starts_at_first_use() {
	new_test_ext().execute_with(|| {
		jump_to(7);
		Identitee::note_usage(&1);
		assert_eq!(Usage::<Test>::get(1), Some((7, 1)));
		jump_to(8);
		Identitee::note_usage(&1);
		assert_eq!(Usage::<Test>::get(1), Some((7, 2)));
		// A whole window later, the count starts again.
		jump_to(7 + WINDOW);
		Identitee::note_usage(&1);
		assert_eq!(Usage::<Test>::get(1), Some((7 + WINDOW, 1)));
	});
}

#[test]
fn global_cap_per_block() {
	new_test_ext().execute_with(|| {
		let accounts = 1..=u64::from(GLOBAL_FEELESS_PER_BLOCK);
		for who in accounts {
			assert!(Identitee::feeless_allowed(&who));
			Identitee::note_usage(&who);
		}
		assert_eq!(BlockFeelessOps::<Test>::get(), GLOBAL_FEELESS_PER_BLOCK);
		let late = u64::from(GLOBAL_FEELESS_PER_BLOCK) + 1;
		assert!(!Identitee::feeless_allowed(&late));
		assert!(!Identitee::block_cap_available());
		assert!(Identitee::quota_available(&late));
		assert!(!set_bio_call().is_feeless(&RuntimeOrigin::signed(late)));

		next_block();
		assert_eq!(BlockFeelessOps::<Test>::get(), 0);
		assert!(Identitee::feeless_allowed(&late));
	});
}

#[test]
fn block_counter_is_cleared_when_the_block_ends() {
	new_test_ext().execute_with(|| {
		Identitee::note_usage(&1);
		assert_eq!(BlockFeelessOps::<Test>::get(), 1);
		// Cleared at the end of the block, so the state a transaction pool validates against
		// (the parent block's final state) never carries a previous block's count.
		Identitee::on_finalize(1);
		assert!(!BlockFeelessOps::<Test>::exists());
	});
}

#[test]
fn only_signed_origins_are_feeless() {
	new_test_ext().execute_with(|| {
		assert!(set_bio_call().is_feeless(&RuntimeOrigin::signed(1)));
		assert!(!set_bio_call().is_feeless(&RuntimeOrigin::root()));
		assert!(!set_bio_call().is_feeless(&RuntimeOrigin::none()));
	});
}

#[test]
fn checking_the_quota_does_not_consume_it() {
	new_test_ext().execute_with(|| {
		frame_support::assert_storage_noop!({
			assert!(Identitee::feeless_allowed(&1));
			assert!(set_bio_call().is_feeless(&RuntimeOrigin::signed(1)));
		});
	});
}

/// At least one value of every call of the pallet, whatever its classification (two for
/// `reject_request`, whose fee rule depends on its target).
///
/// Add the new call here whenever a call is added to the pallet: the tests below check that
/// the list covers every call the pallet declares, and fail with the missing names otherwise.
fn all_calls() -> Vec<crate::Call<Test>> {
	use crate::types::{
		AuthorityName, AvatarBytes, FactKind, FieldChanges, FieldKey, FieldKind, FieldValue,
		LinkIds, LinkTitle, Method, MigrationPayload, Name, Note, ReasonCode, SourceChain,
		SubLabel, Target, Value, Verdict,
	};
	let value = || Value::try_from(b"x".to_vec()).unwrap();
	let name = || Name::try_from(b"xyz".to_vec()).unwrap();
	vec![
		crate::Call::set_bio { bio: Bio::default() },
		crate::Call::set_field {
			key: FieldKey::Typed(FieldKind::Email),
			value: FieldValue::Public(value()),
		},
		crate::Call::clear_field { key: FieldKey::Typed(FieldKind::Email) },
		crate::Call::set_identity {
			changes: FieldChanges::try_from(vec![(FieldKey::Typed(FieldKind::Email), None)])
				.unwrap(),
		},
		crate::Call::set_identity_secret { blob: Default::default() },
		crate::Call::clear_identity_secret {},
		crate::Call::update_profile { update: Default::default() },
		crate::Call::add_link { title: LinkTitle::default(), url: value() },
		crate::Call::update_link { id: 0, title: LinkTitle::default(), url: value() },
		crate::Call::remove_link { id: 0 },
		crate::Call::reorder_links { ids: LinkIds::default() },
		crate::Call::set_avatar { bytes: AvatarBytes::default() },
		crate::Call::clear_avatar {},
		crate::Call::reveal_field {
			key: FieldKey::Typed(FieldKind::Email),
			value: value(),
			salt: [0; 32],
		},
		crate::Call::clear_identity {},
		crate::Call::kill_identity { who: 1 },
		crate::Call::add_authority { name: AuthorityName::default() },
		crate::Call::set_agent { authority: 0, agent: 1, caps: 1 },
		crate::Call::remove_agent { agent: 1 },
		crate::Call::set_authority_active { authority: 0, active: true },
		crate::Call::request_judgement { authority: 0, target: Target::Fact(FactKind::Fraud) },
		crate::Call::cancel_request { authority: 0, target: Target::Fact(FactKind::Fraud) },
		crate::Call::provide_judgement {
			who: 2,
			key: FieldKey::Typed(FieldKind::Email),
			expected_commitment: Default::default(),
			verdict: Verdict::Verified,
			method: Method::Manual,
			expires_at: None,
		},
		crate::Call::revoke_attestation {
			who: 2,
			key: FieldKey::Typed(FieldKind::Email),
			reason: ReasonCode::Other,
		},
		crate::Call::reject_request {
			who: 2,
			target: Target::Field(FieldKey::Typed(FieldKind::Email)),
			reason: ReasonCode::Other,
			note: Note::default(),
		},
		crate::Call::reject_request {
			who: 2,
			target: Target::Fact(FactKind::Fraud),
			reason: ReasonCode::Other,
			note: Note::default(),
		},
		crate::Call::grant_fact {
			who: 2,
			kind: FactKind::Fraud,
			expires_at: None,
			reason: ReasonCode::Other,
			note: Note::default(),
		},
		crate::Call::revoke_fact { who: 2, kind: FactKind::Fraud, reason: ReasonCode::Other },
		crate::Call::claim_username { name: name() },
		crate::Call::release_username {},
		crate::Call::reserve_username { name: name() },
		crate::Call::unreserve_username { name: name() },
		crate::Call::set_username_for { who: 2, name: name() },
		crate::Call::unbind_username { who: 2, reason: ReasonCode::Other },
		crate::Call::add_sub { sub: 2, label: SubLabel::default() },
		crate::Call::accept_sub { parent: 2 },
		crate::Call::remove_sub { sub: 2 },
		crate::Call::quit_sub {},
		crate::Call::rename_sub { sub: 2, label: SubLabel::default() },
		crate::Call::decline_sub { parent: 2 },
		crate::Call::request_migration { source: SourceChain::Polkadot },
		crate::Call::cancel_migration {},
		crate::Call::fulfil_migration {
			who: 2,
			source: SourceChain::Polkadot,
			block: 0,
			block_hash: Default::default(),
			payload: MigrationPayload {
				typed: Default::default(),
				custom: Default::default(),
				judgements: Default::default(),
			},
		},
		crate::Call::reject_migration { who: 2, reason: ReasonCode::Other },
	]
}

/// Calls reserved to `Config::AuthorityOrigin`: never feeless, never counted.
const ROOT_CALLS: [&str; 5] =
	["kill_identity", "add_authority", "set_agent", "remove_agent", "set_authority_active"];

#[test]
fn all_calls_lists_every_call_of_the_pallet() {
	use frame_support::traits::GetCallName;
	let listed: std::collections::BTreeSet<_> =
		all_calls().iter().map(|call| call.get_call_name()).collect();
	let declared: std::collections::BTreeSet<_> =
		crate::Call::<Test>::get_call_names().iter().copied().collect();
	assert_eq!(listed, declared, "all_calls() must list one value of every call");
	// Each call once, except reject_request: once per target type.
	for name in declared {
		let times = all_calls().iter().filter(|call| call.get_call_name() == name).count();
		let expected = if name == "reject_request" { 2 } else { 1 };
		assert_eq!(times, expected, "all_calls() lists {name} {times} times");
	}
}

#[test]
fn user_calls_count_against_the_quota() {
	let user_calls = [
		"set_bio",
		"set_field",
		"clear_field",
		"set_identity",
		"set_identity_secret",
		"clear_identity_secret",
		"update_profile",
		"add_link",
		"update_link",
		"remove_link",
		"reorder_links",
		"set_avatar",
		"clear_avatar",
		"reveal_field",
		"clear_identity",
		"request_judgement",
		"cancel_request",
		"claim_username",
		"release_username",
		"add_sub",
		"accept_sub",
		"remove_sub",
		"quit_sub",
		"rename_sub",
		"decline_sub",
		"request_migration",
		"cancel_migration",
	];
	for call in all_calls() {
		use frame_support::traits::GetCallName;
		let expected = user_calls.contains(&call.get_call_name());
		assert_eq!(call.counts_against_quota(), expected, "{call:?}");
	}
}

#[test]
fn set_fields_counts_one_quota_unit() {
	use crate::types::{FieldChanges, FieldKey, FieldKind, FieldValue, Value};
	new_test_ext().execute_with(|| {
		let field = |kind| {
			let value = FieldValue::Public(Value::try_from(b"v".to_vec()).unwrap());
			(FieldKey::Typed(kind), Some(value))
		};
		let changes = FieldChanges::try_from(vec![
			field(FieldKind::Email),
			field(FieldKind::Web),
			(FieldKey::Typed(FieldKind::Matrix), None),
		])
		.unwrap();
		let call = crate::Call::<Test>::set_identity { changes: changes.clone() };

		// A counted user call, like set_field: the transaction extension records one use for it
		// (checked on the real runtime in runtime/tests/feeless.rs), however many changes it
		// holds, and it is feeless while that quota lasts.
		assert!(call.counts_against_quota());
		assert!(RuntimeCall::Identitee(call).is_feeless(&RuntimeOrigin::signed(1)));

		// Dispatch itself records nothing (it is the extension's job, once per transaction).
		assert_ok!(Identitee::set_identity(RuntimeOrigin::signed(1), changes));
		assert_eq!(Usage::<Test>::get(1), None);
		assert_eq!(BlockFeelessOps::<Test>::get(), 0);

		// With the quota used up, the call is no longer feeless.
		for _ in 0..QUOTA_PER_WINDOW {
			Identitee::note_usage(&1);
		}
		let call = crate::Call::<Test>::set_identity { changes: Default::default() };
		assert!(!RuntimeCall::Identitee(call).is_feeless(&RuntimeOrigin::signed(1)));
	});
}

#[test]
fn feeless_for_a_plain_signed_account_exactly_when_counted_against_the_quota() {
	new_test_ext().execute_with(|| {
		// Account 1 is no agent and has all its quota left, so only the call decides.
		let origin = RuntimeOrigin::signed(1);
		for call in all_calls() {
			let feeless = RuntimeCall::Identitee(call.clone()).is_feeless(&origin);
			// A call feeless through the user rule but not counted would be applied for free
			// without ever consuming quota: unlimited free writes.
			if feeless {
				assert!(call.counts_against_quota(), "{call:?} is feeless but not counted");
			}
			// And a counted call that is not feeless would never be recorded (nor be free).
			if call.counts_against_quota() {
				assert!(feeless, "{call:?} is counted but not feeless");
			}
		}
	});
}

#[test]
fn every_agent_call_is_feeless_and_uncounted_for_an_agent_holding_every_capability() {
	use frame_support::traits::GetCallName;
	let config = crate::GenesisConfig::<Test> {
		authorities: vec![authority("Alpha", &[(10, crate::types::Capabilities::ALL.bits())])],
	};
	new_test_ext_with(config).execute_with(|| {
		let origin = RuntimeOrigin::signed(10);
		for call in all_calls() {
			// Agent calls are the calls neither counted (user calls) nor reserved to root: a new
			// one that forgot its `feeless_if` would cost the agent fees.
			if call.counts_against_quota() || ROOT_CALLS.contains(&call.get_call_name()) {
				continue;
			}
			assert!(
				RuntimeCall::Identitee(call.clone()).is_feeless(&origin),
				"{call:?} is not feeless for an agent holding every capability"
			);
		}
		// Root calls stay paid even for such an agent.
		for call in all_calls() {
			if ROOT_CALLS.contains(&call.get_call_name()) {
				assert!(!RuntimeCall::Identitee(call.clone()).is_feeless(&origin), "{call:?}");
				assert!(!call.counts_against_quota(), "{call:?}");
			}
		}
	});
}
