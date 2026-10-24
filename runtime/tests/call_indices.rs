//! Pins the encoding of every identitee call: pallet index and call index.
//!
//! A signed transaction carries these two bytes, not the call's name. Renaming a call is free;
//! moving one to another index would make wallets, the migrator and old transactions call the
//! wrong function. The table below is the reference: any call added, removed, renamed or
//! re-indexed without updating it fails here.

use codec::{Decode, Encode};
use frame_support::traits::GetCallName;
use identitee_runtime::{Runtime, RuntimeCall};

/// Index of the identitee pallet in the runtime declaration.
const PALLET_INDEX: u8 = 8;

/// Every call of the pallet, in declaration order, with its pinned call index.
const CALLS: &[(&str, u8)] = &[
	("set_bio", 0),
	("set_field", 1),
	("clear_field", 2),
	("add_link", 3),
	("update_link", 4),
	("remove_link", 5),
	("reorder_links", 6),
	("set_avatar", 7),
	("clear_avatar", 8),
	("reveal_field", 9),
	("clear_identity", 10),
	("kill_identity", 11),
	("set_identity", 12),
	("set_identity_secret", 13),
	("clear_identity_secret", 14),
	("update_profile", 15),
	("add_authority", 20),
	("set_agent", 21),
	("remove_agent", 22),
	("set_authority_active", 23),
	("request_judgement", 30),
	("cancel_request", 31),
	("provide_judgement", 32),
	("revoke_attestation", 33),
	("reject_request", 34),
	("grant_fact", 35),
	("revoke_fact", 36),
	("claim_username", 40),
	("release_username", 41),
	("reserve_username", 42),
	("unreserve_username", 43),
	("set_username_for", 44),
	("unbind_username", 45),
	("add_sub", 50),
	("accept_sub", 51),
	("remove_sub", 52),
	("quit_sub", 53),
	("rename_sub", 54),
	("decline_sub", 55),
	("request_migration", 60),
	("cancel_migration", 61),
	("fulfil_migration", 62),
	("reject_migration", 63),
];

#[test]
fn the_table_lists_every_call_of_the_pallet() {
	let names = pallet_identitee::Call::<Runtime>::get_call_names();
	let pinned: Vec<&str> = CALLS.iter().map(|(name, _)| *name).collect();
	assert_eq!(names, pinned.as_slice());
}

#[test]
fn every_call_encodes_with_its_pinned_indices() {
	for (name, index) in CALLS {
		// Two index bytes followed by zeros: every argument decodes to its zero value (empty
		// vectors, first enum variant, zero account, None), so each variant can be built
		// without knowing its arguments.
		let mut bytes = vec![PALLET_INDEX, *index];
		bytes.extend([0u8; 512]);
		let call = RuntimeCall::decode(&mut &bytes[..]).unwrap_or_else(|e| {
			panic!("{name}: indices {PALLET_INDEX}/{index} do not decode: {e}")
		});
		let RuntimeCall::Identitee(inner) = &call else {
			panic!("{name}: pallet index {PALLET_INDEX} is not identitee: {call:?}");
		};
		assert_eq!(inner.get_call_name(), *name, "call index {index}");
		assert_eq!(call.encode()[..2], [PALLET_INDEX, *index], "{name}");
	}
}
