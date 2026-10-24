//! `update_profile`: the whole profile in one call, each part as its single call does it, all or
//! nothing.

use crate::{
	limits::{MAX_CUSTOM_FIELDS, MAX_FIELD_CHANGES, MAX_LINKS},
	mock::*,
	types::{
		AvatarBytes, Bio, Capabilities, CustomKey, FieldChanges, FieldKey, FieldKind, FieldValue,
		LinkEdit, LinkTitle, MaxLinks, Method, ProfileUpdate, SecretBlob, Value, Verdict,
	},
	weights::{max_profile_work, ProfileWork},
	Error, Event, FieldAttestations, Identities, IdentitySecrets, WeightInfo,
};
use codec::{Decode, Encode};
use frame_support::{
	assert_noop, assert_ok,
	dispatch::{CheckIfFeeless, DispatchResult, GetDispatchInfo},
	traits::UnfilteredDispatchable,
	BoundedVec,
};
use sp_core::H256;

type Weights = <Test as crate::Config>::WeightInfo;

/// The agent of the one authority of [`ext`], holding ATTEST_FIELDS.
const AGENT: u64 = 10;

/// One authority, "Alpha", with [`AGENT`].
fn ext() -> sp_io::TestExternalities {
	let attest = Capabilities::ATTEST_FIELDS.bits();
	new_test_ext_with(crate::GenesisConfig::<Test> {
		authorities: vec![authority("Alpha", &[(AGENT, attest)])],
	})
}

fn value(bytes: &[u8]) -> Value {
	Value::try_from(bytes.to_vec()).unwrap()
}

fn title(bytes: &[u8]) -> LinkTitle {
	LinkTitle::try_from(bytes.to_vec()).unwrap()
}

fn public(bytes: &[u8]) -> FieldValue {
	FieldValue::Public(value(bytes))
}

fn bio(bytes: &[u8]) -> Bio {
	Bio::try_from(bytes.to_vec()).unwrap()
}

fn secret(bytes: &[u8]) -> SecretBlob {
	SecretBlob::try_from(bytes.to_vec()).unwrap()
}

fn fields(changes: Vec<(FieldKey, Option<FieldValue>)>) -> FieldChanges {
	FieldChanges::try_from(changes).unwrap()
}

fn links(edits: Vec<LinkEdit>) -> Option<BoundedVec<LinkEdit, MaxLinks>> {
	Some(BoundedVec::try_from(edits).unwrap())
}

fn add(t: &[u8], url: &[u8]) -> LinkEdit {
	LinkEdit::Add { title: title(t), url: value(url) }
}

fn update(id: u32, t: &[u8], url: &[u8]) -> LinkEdit {
	LinkEdit::Update { id, title: title(t), url: value(url) }
}

/// A 64x64 lossless WebP: RIFF header, `VP8L` chunk, signature and 14-bit width-1/height-1.
fn webp_64() -> AvatarBytes {
	let bits: u32 = 63 | (63 << 14);
	let mut payload = vec![0x2f];
	payload.extend_from_slice(&bits.to_le_bytes());
	let mut chunk = b"VP8L".to_vec();
	chunk.extend_from_slice(&(payload.len() as u32).to_le_bytes());
	chunk.extend_from_slice(&payload);
	let mut file = b"RIFF".to_vec();
	file.extend_from_slice(&((4 + chunk.len()) as u32).to_le_bytes());
	file.extend_from_slice(b"WEBP");
	file.extend_from_slice(&chunk);
	AvatarBytes::try_from(file).unwrap()
}

/// `update_profile` by `who`, as a plain result.
fn apply(who: u64, update: ProfileUpdate) -> DispatchResult {
	Identitee::update_profile(RuntimeOrigin::signed(who), update)
		.map(|_| ())
		.map_err(|e| e.error)
}

/// The events of the pallet since the last reset, in order.
fn pallet_events() -> Vec<RuntimeEvent> {
	System::events().into_iter().map(|record| record.event).collect()
}

fn link_ids(who: u64) -> Vec<u32> {
	Identities::<Test>::get(who).unwrap().links.iter().map(|link| link.id).collect()
}

/// The verdict of [`AGENT`] on link `id` of `who`, as it stands now.
fn attest_link(who: u64, id: u32) {
	let key = FieldKey::Link(id);
	assert_ok!(Identitee::provide_judgement(
		RuntimeOrigin::signed(AGENT),
		who,
		key.clone(),
		Identitee::current_commitment(&who, &key).unwrap(),
		Verdict::Verified,
		Method::Manual,
		None
	));
}

/// Whether the attestation of Alpha (authority 0) on link `id` of `who` exists, and is valid.
fn link_attestation(who: u64, id: u32) -> (bool, bool) {
	let key = FieldKey::Link(id);
	match FieldAttestations::<Test>::get((who, key.clone(), 0)) {
		Some(att) => (true, Identitee::attestation_is_valid(&who, &key, &att, 1)),
		None => (false, false),
	}
}

/// A profile built with the single calls: bio, avatar, an email, links a, b, c (ids 0, 1, 2).
fn full_profile(who: u64) {
	let origin = || RuntimeOrigin::signed(who);
	assert_ok!(Identitee::set_bio(origin(), bio(b"hello")));
	assert_ok!(Identitee::set_avatar(origin(), webp_64()));
	assert_ok!(Identitee::set_field(origin(), FieldKey::Typed(FieldKind::Email), public(b"a@b.c")));
	for t in [b"a", b"b", b"c"] {
		assert_ok!(Identitee::add_link(origin(), title(t), value(b"https://x")));
	}
	assert_ok!(Identitee::set_identity_secret(origin(), secret(b"v1|old")));
}

#[test]
fn everything_at_once_creates_the_identity() {
	ext().execute_with(|| {
		let email = FieldKey::Typed(FieldKind::Email);
		let telegram = FieldKey::Typed(FieldKind::Telegram);
		let private = FieldValue::Private(H256::repeat_byte(7));
		assert_ok!(apply(
			1,
			ProfileUpdate {
				bio: Some(bio(b"hi")),
				avatar: Some(Some(webp_64())),
				fields: fields(vec![
					(email.clone(), Some(public(b"a@b.c"))),
					(telegram.clone(), Some(private.clone())),
				]),
				links: links(vec![add(b"site", b"https://a"), add(b"blog", b"https://b")]),
				secret: Some(secret(b"v1|salt|nonce|ciphertext")),
			}
		));

		let identity = Identities::<Test>::get(1).unwrap();
		assert_eq!((identity.created_at, identity.updated_at), (1, 1));
		assert_eq!(identity.bio, bio(b"hi"));
		assert_eq!(identity.avatar, Some(webp_64()));
		assert_eq!(identity.typed.get(&FieldKind::Email), Some(&public(b"a@b.c")));
		assert_eq!(identity.typed.get(&FieldKind::Telegram), Some(&private));
		assert_eq!(link_ids(1), vec![0, 1]);
		assert_eq!(identity.next_link_id, 2);
		assert_eq!(identity.links[1].title, title(b"blog"));
		assert_eq!(IdentitySecrets::<Test>::get(1), Some(secret(b"v1|salt|nonce|ciphertext")));

		// The events of the single calls, in the order of the steps, then one for the update.
		let expected: Vec<RuntimeEvent> = vec![
			Event::IdentitySecretSet { who: 1 }.into(),
			Event::BioSet { who: 1 }.into(),
			Event::AvatarSet { who: 1 }.into(),
			Event::FieldSet { who: 1, key: email }.into(),
			Event::FieldSet { who: 1, key: telegram }.into(),
			Event::LinkAdded { who: 1, id: 0 }.into(),
			Event::LinkAdded { who: 1, id: 1 }.into(),
			Event::ProfileUpdated { who: 1 }.into(),
		];
		assert_eq!(pallet_events(), expected);
	});
}

#[test]
fn secret_with_a_private_field() {
	ext().execute_with(|| {
		// The identity secret and the private commitment it opens, in one signed call.
		let legal = FieldKey::Typed(FieldKind::LegalName);
		let private = FieldValue::Private(H256::repeat_byte(3));
		assert_ok!(apply(
			1,
			ProfileUpdate {
				fields: fields(vec![(legal.clone(), Some(private.clone()))]),
				secret: Some(secret(b"v1|key")),
				..Default::default()
			}
		));
		assert_eq!(IdentitySecrets::<Test>::get(1), Some(secret(b"v1|key")));
		assert_eq!(
			Identities::<Test>::get(1).unwrap().typed.get(&FieldKind::LegalName),
			Some(&private)
		);
		let expected: Vec<RuntimeEvent> = vec![
			Event::IdentitySecretSet { who: 1 }.into(),
			Event::FieldSet { who: 1, key: legal }.into(),
			Event::ProfileUpdated { who: 1 }.into(),
		];
		assert_eq!(pallet_events(), expected);

		// The secret alone needs no identity and creates none, as `set_identity_secret`.
		assert_ok!(apply(2, ProfileUpdate { secret: Some(secret(b"v1|x")), ..Default::default() }));
		assert_eq!(IdentitySecrets::<Test>::get(2), Some(secret(b"v1|x")));
		assert!(Identities::<Test>::get(2).is_none());
	});
}

#[test]
fn keep_everything_but_the_bio() {
	ext().execute_with(|| {
		full_profile(1);
		System::set_block_number(5);
		let before = Identities::<Test>::get(1).unwrap();
		System::reset_events();

		assert_ok!(apply(1, ProfileUpdate { bio: Some(bio(b"new")), ..Default::default() }));
		let after = Identities::<Test>::get(1).unwrap();
		let mut expected = before;
		expected.bio = bio(b"new");
		expected.updated_at = 5;
		assert_eq!(after, expected);
		assert_eq!(IdentitySecrets::<Test>::get(1), Some(secret(b"v1|old")));
		let events: Vec<RuntimeEvent> =
			vec![Event::BioSet { who: 1 }.into(), Event::ProfileUpdated { who: 1 }.into()];
		assert_eq!(pallet_events(), events);

		// An empty bio is a bio, as with `set_bio`.
		assert_ok!(apply(1, ProfileUpdate { bio: Some(bio(b"")), ..Default::default() }));
		assert!(Identities::<Test>::get(1).unwrap().bio.is_empty());
	});
}

#[test]
fn avatar_set_clear_and_keep() {
	ext().execute_with(|| {
		let avatar = |who| Identities::<Test>::get(who).unwrap().avatar;
		assert_ok!(apply(1, ProfileUpdate { avatar: Some(Some(webp_64())), ..Default::default() }));
		assert_eq!(avatar(1), Some(webp_64()));

		// `None` keeps it.
		assert_ok!(apply(1, ProfileUpdate { bio: Some(bio(b"x")), ..Default::default() }));
		assert_eq!(avatar(1), Some(webp_64()));

		// `Some(None)` clears it, and clearing again succeeds, as `clear_avatar`.
		System::reset_events();
		assert_ok!(apply(1, ProfileUpdate { avatar: Some(None), ..Default::default() }));
		assert_eq!(avatar(1), None);
		let events: Vec<RuntimeEvent> =
			vec![Event::AvatarCleared { who: 1 }.into(), Event::ProfileUpdated { who: 1 }.into()];
		assert_eq!(pallet_events(), events);
		assert_ok!(apply(1, ProfileUpdate { avatar: Some(None), ..Default::default() }));

		// Without an identity there is nothing to clear in, as with `clear_avatar`, unless an
		// earlier step of the same call created it.
		assert_noop!(
			apply(2, ProfileUpdate { avatar: Some(None), ..Default::default() }),
			Error::<Test>::NoIdentity
		);
		assert_ok!(apply(
			2,
			ProfileUpdate { bio: Some(bio(b"x")), avatar: Some(None), ..Default::default() }
		));
		assert_eq!(avatar(2), None);
	});
}

#[test]
fn links_keep_update_add_remove_and_reorder_in_one_call() {
	ext().execute_with(|| {
		// Accounts 1 and 2 get the same links and attestations; 2 is changed with the single
		// calls, for comparison.
		for who in [1, 2] {
			for t in [b"a", b"b", b"c", b"d"] {
				assert_ok!(Identitee::add_link(
					RuntimeOrigin::signed(who),
					title(t),
					value(b"https://x")
				));
			}
			for id in [0, 1, 2] {
				attest_link(who, id);
			}
		}
		System::reset_events();

		// Remove 1 (not named), update 2, add one, and put the new link first.
		assert_ok!(apply(
			1,
			ProfileUpdate {
				links: links(vec![
					add(b"e", b"https://e"),
					LinkEdit::Keep(3),
					update(2, b"C", b"https://c"),
					LinkEdit::Keep(0),
				]),
				..Default::default()
			}
		));
		assert_eq!(link_ids(1), vec![4, 3, 2, 0]);
		let identity = Identities::<Test>::get(1).unwrap();
		assert_eq!(
			(&identity.links[0].title, &identity.links[0].url),
			(&title(b"e"), &value(b"https://e"))
		);
		assert_eq!(
			(&identity.links[2].title, &identity.links[2].url),
			(&title(b"C"), &value(b"https://c"))
		);
		assert_eq!(identity.next_link_id, 5);
		let expected: Vec<RuntimeEvent> = vec![
			Event::LinkRemoved { who: 1, id: 1 }.into(),
			Event::LinkUpdated { who: 1, id: 2 }.into(),
			Event::LinkAdded { who: 1, id: 4 }.into(),
			Event::LinksReordered { who: 1 }.into(),
			Event::ProfileUpdated { who: 1 }.into(),
		];
		assert_eq!(pallet_events(), expected);

		// The same with the single calls on account 2.
		let origin = || RuntimeOrigin::signed(2);
		assert_ok!(Identitee::remove_link(origin(), 1));
		assert_ok!(Identitee::update_link(origin(), 2, title(b"C"), value(b"https://c")));
		assert_ok!(Identitee::add_link(origin(), title(b"e"), value(b"https://e")));

		// The removed link's attestation is gone; the kept one still holds; the updated one is
		// still there and no longer valid, exactly as after `update_link`.
		assert_eq!(link_attestation(1, 1), (false, false));
		assert_eq!(link_attestation(1, 0), (true, true));
		assert_eq!(link_attestation(1, 2), (true, false));
		for id in [0, 1, 2] {
			assert_eq!(link_attestation(1, id), link_attestation(2, id));
			assert_eq!(
				FieldAttestations::<Test>::get((1, FieldKey::Link(id), 0)),
				FieldAttestations::<Test>::get((2, FieldKey::Link(id), 0))
			);
		}
		assert_eq!(
			Identitee::current_commitment(&1, &FieldKey::Link(2)),
			Identitee::current_commitment(&2, &FieldKey::Link(2))
		);

		// Updating back to the attested title and url makes it valid again, as with
		// `update_link`.
		assert_ok!(apply(
			1,
			ProfileUpdate {
				links: links(vec![
					LinkEdit::Keep(4),
					LinkEdit::Keep(3),
					update(2, b"c", b"https://x"),
					LinkEdit::Keep(0),
				]),
				..Default::default()
			}
		));
		assert_eq!(link_attestation(1, 2), (true, true));
	});
}

#[test]
fn links_in_their_order_are_not_reordered() {
	ext().execute_with(|| {
		for t in [b"a", b"b"] {
			assert_ok!(Identitee::add_link(RuntimeOrigin::signed(1), title(t), value(b"u")));
		}
		System::reset_events();
		assert_ok!(apply(
			1,
			ProfileUpdate {
				links: links(vec![LinkEdit::Keep(0), LinkEdit::Keep(1), add(b"c", b"u")]),
				..Default::default()
			}
		));
		assert_eq!(link_ids(1), vec![0, 1, 2]);
		let expected: Vec<RuntimeEvent> = vec![
			Event::LinkAdded { who: 1, id: 2 }.into(),
			Event::ProfileUpdated { who: 1 }.into(),
		];
		assert_eq!(pallet_events(), expected);

		// The same list again changes nothing, so it is refused.
		System::reset_events();
		let all = links(vec![LinkEdit::Keep(0), LinkEdit::Keep(1), LinkEdit::Keep(2)]);
		assert_noop!(
			apply(1, ProfileUpdate { links: all, ..Default::default() }),
			Error::<Test>::EmptyUpdate
		);
		assert_eq!(link_ids(1), vec![0, 1, 2]);
		assert!(pallet_events().is_empty());
	});
}

#[test]
fn an_empty_link_list_removes_every_link() {
	ext().execute_with(|| {
		full_profile(1);
		attest_link(1, 1);
		assert_ok!(apply(1, ProfileUpdate { links: links(vec![]), ..Default::default() }));
		assert!(link_ids(1).is_empty());
		assert_eq!(FieldAttestations::<Test>::iter_prefix((1, FieldKey::Link(1))).count(), 0);
		// Ids are never given again.
		assert_ok!(apply(
			1,
			ProfileUpdate { links: links(vec![add(b"d", b"u")]), ..Default::default() }
		));
		assert_eq!(link_ids(1), vec![3]);

		// Without an identity, an empty list has nothing to do: refused, no identity.
		assert_noop!(
			apply(2, ProfileUpdate { links: links(vec![]), ..Default::default() }),
			Error::<Test>::EmptyUpdate
		);
		assert!(Identities::<Test>::get(2).is_none());
		// But a kept link it does not have is unknown.
		assert_noop!(
			apply(2, ProfileUpdate { links: links(vec![LinkEdit::Keep(0)]), ..Default::default() }),
			Error::<Test>::UnknownLink
		);
	});
}

#[test]
fn a_failure_leaves_no_change_at_all() {
	ext().execute_with(|| {
		full_profile(1);
		attest_link(1, 0);
		let email = FieldKey::Typed(FieldKind::Email);
		// Every update changes the secret, the bio and the email before its bad part, so a
		// failure has something to undo.
		let with = |bad: ProfileUpdate| ProfileUpdate {
			secret: bad.secret.or(Some(secret(b"v1|new"))),
			bio: bad.bio.or(Some(bio(b"changed"))),
			fields: if bad.fields.is_empty() {
				fields(vec![(email.clone(), Some(public(b"new@b.c")))])
			} else {
				bad.fields
			},
			..bad
		};
		let png = AvatarBytes::try_from(b"\x89PNG\r\n\x1a\n0000000000000000".to_vec()).unwrap();
		let cases: Vec<(ProfileUpdate, Error<Test>)> = vec![
			// The same id twice, kept or updated.
			(
				ProfileUpdate {
					links: links(vec![LinkEdit::Keep(0), update(0, b"x", b"y")]),
					..Default::default()
				},
				Error::<Test>::InvalidLinkOrder,
			),
			(
				ProfileUpdate {
					links: links(vec![LinkEdit::Keep(1), LinkEdit::Keep(1)]),
					..Default::default()
				},
				Error::<Test>::InvalidLinkOrder,
			),
			// An id that is not a current link.
			(
				ProfileUpdate { links: links(vec![LinkEdit::Keep(9)]), ..Default::default() },
				Error::<Test>::UnknownLink,
			),
			(
				ProfileUpdate { links: links(vec![update(7, b"x", b"y")]), ..Default::default() },
				Error::<Test>::UnknownLink,
			),
			// Invalid url, invalid title.
			(
				ProfileUpdate {
					links: links(vec![LinkEdit::Keep(0), add(b"x", &[0xc3, 0x28])]),
					..Default::default()
				},
				Error::<Test>::InvalidUtf8,
			),
			(
				ProfileUpdate {
					links: links(vec![update(2, &[0xc3, 0x28], b"y")]),
					..Default::default()
				},
				Error::<Test>::InvalidUtf8,
			),
			// Invalid avatar.
			(
				ProfileUpdate { avatar: Some(Some(png)), ..Default::default() },
				Error::<Test>::InvalidAvatar,
			),
			// Invalid bio.
			(
				ProfileUpdate { bio: Some(bio(&[0xff])), ..Default::default() },
				Error::<Test>::InvalidUtf8,
			),
			// The same field twice.
			(
				ProfileUpdate {
					fields: fields(vec![
						(email.clone(), Some(public(b"x@y.z"))),
						(email.clone(), None),
					]),
					..Default::default()
				},
				Error::<Test>::DuplicateFieldInBatch,
			),
			// An empty secret.
			(
				ProfileUpdate { secret: Some(secret(b"")), ..Default::default() },
				Error::<Test>::EmptySecretBlob,
			),
		];
		for (bad, error) in cases {
			let before = Identities::<Test>::get(1).encode();
			// `assert_noop` compares the whole storage, events and the secret included.
			assert_noop!(apply(1, with(bad)), error);
			assert_eq!(Identities::<Test>::get(1).encode(), before);
		}
		assert_eq!(IdentitySecrets::<Test>::get(1), Some(secret(b"v1|old")));
		assert_eq!(link_ids(1), vec![0, 1, 2]);
		assert_eq!(link_attestation(1, 0), (true, true));

		// Nor does a failure create an identity.
		assert_noop!(
			apply(
				2,
				with(ProfileUpdate { links: links(vec![LinkEdit::Keep(0)]), ..Default::default() })
			),
			Error::<Test>::UnknownLink
		);
	});
}

#[test]
fn an_update_that_changes_nothing_is_refused() {
	ext().execute_with(|| {
		full_profile(1);
		assert_noop!(apply(1, ProfileUpdate::default()), Error::<Test>::EmptyUpdate);
		assert_noop!(apply(2, ProfileUpdate::default()), Error::<Test>::EmptyUpdate);
		// An empty link list is a change (it removes every link), so it is not refused.
		assert_ok!(apply(1, ProfileUpdate { links: links(vec![]), ..Default::default() }));
	});
}

#[test]
fn a_link_list_that_leaves_the_links_as_they_are_is_refused() {
	ext().execute_with(|| {
		System::set_block_number(2);
		let only_links =
			|edits: Vec<LinkEdit>| ProfileUpdate { links: links(edits), ..Default::default() };

		// No identity, or an identity without links: an empty list changes nothing.
		assert_noop!(apply(2, only_links(vec![])), Error::<Test>::EmptyUpdate);
		assert!(Identities::<Test>::get(2).is_none());
		assert_ok!(Identitee::set_bio(RuntimeOrigin::signed(3), bio(b"hi")));
		System::reset_events();
		assert_noop!(apply(3, only_links(vec![])), Error::<Test>::EmptyUpdate);
		assert!(pallet_events().is_empty());
		assert!(crate::Usage::<Test>::get(3).is_none());

		// Every current link kept, in its order, and nothing else.
		full_profile(1);
		let before = Identities::<Test>::get(1).unwrap();
		System::reset_events();
		let keep_all = vec![LinkEdit::Keep(0), LinkEdit::Keep(1), LinkEdit::Keep(2)];
		assert_noop!(apply(1, only_links(keep_all.clone())), Error::<Test>::EmptyUpdate);
		assert!(pallet_events().is_empty());
		assert_eq!(Identities::<Test>::get(1), Some(before.clone()));

		// The same list with another change goes through, and leaves the links as they are.
		assert_ok!(apply(
			1,
			ProfileUpdate { bio: Some(bio(b"new")), links: links(keep_all), ..Default::default() }
		));
		assert_eq!(link_ids(1), vec![0, 1, 2]);
		assert_eq!(Identities::<Test>::get(1).unwrap().bio, bio(b"new"));

		// Any real link change is still a change: a reorder, a removal, an update, an addition.
		for edits in [
			vec![LinkEdit::Keep(1), LinkEdit::Keep(0), LinkEdit::Keep(2)],
			vec![LinkEdit::Keep(0), LinkEdit::Keep(1)],
			vec![LinkEdit::Keep(0), LinkEdit::Keep(1), update(2, b"c", b"https://x")],
			vec![LinkEdit::Keep(0), LinkEdit::Keep(1), LinkEdit::Keep(2), add(b"d", b"u")],
		] {
			frame_support::storage::with_transaction(|| {
				assert_ok!(apply(1, only_links(edits)));
				sp_runtime::TransactionOutcome::Rollback(Ok::<(), sp_runtime::DispatchError>(()))
			})
			.unwrap();
		}
		// Unknown ids are still reported as such, not as an empty update.
		assert_noop!(apply(1, only_links(vec![LinkEdit::Keep(9)])), Error::<Test>::UnknownLink);
	});
}

#[test]
fn more_links_than_the_bound_do_not_fit_the_call() {
	ext().execute_with(|| {
		let edits: Vec<LinkEdit> = (0..=MAX_LINKS).map(|_| add(b"t", b"u")).collect();
		assert!(BoundedVec::<LinkEdit, MaxLinks>::try_from(edits.clone()).is_err());
		// Nor from the wire: a 17-entry list does not decode.
		let encode = |edits: &[LinkEdit]| {
			let mut wire = vec![15u8]; // call index of `update_profile`
			wire.extend(None::<Bio>.encode());
			wire.extend(None::<Option<AvatarBytes>>.encode());
			wire.extend(FieldChanges::default().encode());
			wire.extend(Some(edits.to_vec()).encode());
			wire.extend(None::<SecretBlob>.encode());
			wire
		};
		assert!(crate::Call::<Test>::decode(&mut &encode(&edits)[..]).is_err());

		// 16 fit, and fill the identity.
		let full = &edits[..MAX_LINKS as usize];
		let call = crate::Call::<Test>::decode(&mut &encode(full)[..]).unwrap();
		assert_ok!(call.dispatch_bypass_filter(RuntimeOrigin::signed(1)));
		assert_eq!(link_ids(1), (0..MAX_LINKS).collect::<Vec<_>>());
	});
}

#[test]
fn update_profile_is_a_feeless_user_call() {
	ext().execute_with(|| {
		let call = crate::Call::<Test>::update_profile { update: Default::default() };
		assert!(call.counts_against_quota());
		assert!(RuntimeCall::Identitee(call).is_feeless(&RuntimeOrigin::signed(1)));
	});
}

// --- weight ---

/// Dispatch `update` by `origin`: its error if any, the weight it reported, the weight declared.
fn run(
	update: ProfileUpdate,
	origin: RuntimeOrigin,
) -> (
	Option<sp_runtime::DispatchError>,
	frame_support::weights::Weight,
	frame_support::weights::Weight,
) {
	let call = crate::Call::<Test>::update_profile { update };
	let declared = call.get_dispatch_info().call_weight;
	let (error, post_info) = match call.dispatch_bypass_filter(origin) {
		Ok(post_info) => (None, post_info),
		Err(e) => (Some(e.error), e.post_info),
	};
	(error, post_info.actual_weight.expect("the call reports the weight it used"), declared)
}

#[test]
fn update_profile_declares_its_worst_case() {
	let declared = crate::Call::<Test>::update_profile { update: Default::default() }
		.get_dispatch_info()
		.call_weight;
	assert_eq!(declared, Weights::update_profile());
	assert_eq!(Weights::update_profile(), Weights::update_profile_actual(max_profile_work()));
	// At least every step at its heaviest: a full `set_identity`, and every current link removed
	// with a full list added.
	let link_edit = Weights::remove_link().max(Weights::add_link()).max(Weights::update_link());
	let floor = Weights::set_identity_secret()
		.saturating_add(Weights::set_bio())
		.saturating_add(Weights::set_avatar())
		.saturating_add(Weights::set_identity())
		.saturating_add(link_edit.saturating_mul(u64::from(2 * MAX_LINKS)))
		.saturating_add(Weights::reorder_links());
	assert!(floor.all_lt(declared));
	// Each step adds to it.
	let none = Weights::update_profile_actual(ProfileWork::default());
	for step in [
		ProfileWork { secret: true, ..Default::default() },
		ProfileWork { bio: true, ..Default::default() },
		ProfileWork { avatar: true, ..Default::default() },
		ProfileWork { field_changes: 1, ..Default::default() },
		ProfileWork { links_read: true, ..Default::default() },
		ProfileWork { link_edits: 1, ..Default::default() },
		ProfileWork { reorder: true, ..Default::default() },
	] {
		assert!(none.all_lt(Weights::update_profile_actual(step)), "{step:?}");
	}
}

#[test]
fn update_profile_reports_what_it_did() {
	ext().execute_with(|| {
		full_profile(1);
		// The bio alone weighs what `set_bio` does.
		let (error, actual, declared) = run(
			ProfileUpdate { bio: Some(bio(b"x")), ..Default::default() },
			RuntimeOrigin::signed(1),
		);
		assert_eq!(error, None);
		assert_eq!(
			actual,
			Weights::update_profile_actual(ProfileWork { bio: true, ..Default::default() })
		);
		assert_eq!(actual, Weights::set_bio());
		assert!(actual.ref_time() * 100 < declared.ref_time());

		// Links: one removed, one updated, one added, reordered.
		let update = ProfileUpdate {
			links: links(vec![add(b"d", b"u"), update(0, b"A", b"u"), LinkEdit::Keep(2)]),
			..Default::default()
		};
		let (error, actual, _) = run(update, RuntimeOrigin::signed(1));
		assert_eq!(error, None);
		let work =
			ProfileWork { links_read: true, link_edits: 3, reorder: true, ..Default::default() };
		assert_eq!(actual, Weights::update_profile_actual(work));

		// Refused at once: an empty update, or not signed.
		let (error, actual, _) = run(ProfileUpdate::default(), RuntimeOrigin::signed(1));
		assert_eq!(error, Some(Error::<Test>::EmptyUpdate.into()));
		assert_eq!(actual, Weights::update_profile_actual(ProfileWork::default()));
		let (error, actual, _) = run(
			ProfileUpdate { bio: Some(bio(b"x")), ..Default::default() },
			RuntimeOrigin::root(),
		);
		assert_eq!(error, Some(sp_runtime::DispatchError::BadOrigin));
		assert_eq!(actual, Weights::update_profile_actual(ProfileWork::default()));

		// A failure reports the steps it started: the secret, the bio, then an unknown link.
		let update = ProfileUpdate {
			secret: Some(secret(b"v1|x")),
			bio: Some(bio(b"y")),
			links: links(vec![LinkEdit::Keep(9)]),
			..Default::default()
		};
		let (error, actual, _) = run(update, RuntimeOrigin::signed(1));
		assert_eq!(error, Some(Error::<Test>::UnknownLink.into()));
		let work = ProfileWork { secret: true, bio: true, links_read: true, ..Default::default() };
		assert_eq!(actual, Weights::update_profile_actual(work));
	});
}

#[test]
fn the_fullest_update_stays_within_what_it_declares() {
	ext().execute_with(|| {
		for _ in 0..MAX_LINKS {
			assert_ok!(Identitee::add_link(RuntimeOrigin::signed(1), title(b"t"), value(b"u")));
		}
		// 32 field changes: the 10 typed fields, 16 custom ones and 6 clears.
		let kinds = [
			FieldKind::DisplayName,
			FieldKind::LegalName,
			FieldKind::Web,
			FieldKind::Email,
			FieldKind::Matrix,
			FieldKind::X,
			FieldKind::Discord,
			FieldKind::GitHub,
			FieldKind::Telegram,
		];
		let mut changes: Vec<_> = kinds
			.into_iter()
			.map(|kind| (FieldKey::Typed(kind), Some(public(b"v"))))
			.collect();
		changes.push((FieldKey::Typed(FieldKind::Pgp), Some(public(&[7; 20]))));
		let custom =
			|name: String| FieldKey::Custom(CustomKey::try_from(name.into_bytes()).unwrap());
		changes
			.extend((0..MAX_CUSTOM_FIELDS).map(|i| (custom(format!("k{i}")), Some(public(b"v")))));
		changes.extend((0..6).map(|i| (custom(format!("gone{i}")), None)));
		assert_eq!(changes.len(), MAX_FIELD_CHANGES as usize);

		// Every current link replaced by a new one.
		let update = ProfileUpdate {
			bio: Some(bio(b"b")),
			avatar: Some(Some(webp_64())),
			fields: fields(changes),
			links: links((0..MAX_LINKS).map(|_| add(b"n", b"u")).collect()),
			secret: Some(secret(b"v1|s")),
		};
		let (error, actual, declared) = run(update, RuntimeOrigin::signed(1));
		assert_eq!(error, None);
		let work = ProfileWork {
			secret: true,
			bio: true,
			avatar: true,
			field_changes: MAX_FIELD_CHANGES,
			links_read: true,
			link_edits: 2 * MAX_LINKS,
			reorder: false,
		};
		assert_eq!(actual, Weights::update_profile_actual(work));
		assert!(actual.all_lte(declared));
		assert_eq!(link_ids(1), (MAX_LINKS..2 * MAX_LINKS).collect::<Vec<_>>());
	});
}
