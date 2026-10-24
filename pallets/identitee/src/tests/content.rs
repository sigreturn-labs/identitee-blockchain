use crate::{
	limits::{MAX_CUSTOM_FIELDS, MAX_FIELD_CHANGES},
	mock::*,
	types::{
		commitment, AvatarBytes, Capabilities, CustomKey, FieldChanges, FieldKey, FieldKind,
		FieldValue, LinkIds, LinkTitle, Method, Value, Verdict,
	},
	Error, Event, FieldAttestations, Identities, ProviderHeld,
};
use codec::{Decode, Encode};
use frame_support::{assert_noop, assert_ok, dispatch::CheckIfFeeless};
use sp_core::H256;
use sp_io::hashing::blake2_256;

fn value(bytes: &[u8]) -> Value {
	Value::try_from(bytes.to_vec()).unwrap()
}

fn custom(key: &[u8]) -> CustomKey {
	CustomKey::try_from(key.to_vec()).unwrap()
}

fn title(bytes: &[u8]) -> LinkTitle {
	LinkTitle::try_from(bytes.to_vec()).unwrap()
}

fn ids(list: &[u32]) -> LinkIds {
	LinkIds::try_from(list.to_vec()).unwrap()
}

fn public(bytes: &[u8]) -> FieldValue {
	FieldValue::Public(value(bytes))
}

/// The private commitment, written out from its documented formula.
fn private_commitment(salt: &[u8; 32], v: &[u8]) -> H256 {
	let mut preimage = b"identitee:field:private:v1".to_vec();
	preimage.extend_from_slice(salt);
	preimage.extend_from_slice(v);
	H256(blake2_256(&preimage))
}

fn link_ids(who: u64) -> Vec<u32> {
	Identities::<Test>::get(who).unwrap().links.iter().map(|link| link.id).collect()
}

/// A 64x64 lossless WebP: RIFF header, `VP8L` chunk, signature and 14-bit width-1/height-1.
fn webp_64() -> Vec<u8> {
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
	file
}

#[test]
fn set_field_public_and_private() {
	new_test_ext().execute_with(|| {
		let email = FieldKey::Typed(FieldKind::Email);
		assert_ok!(Identitee::set_field(RuntimeOrigin::signed(1), email.clone(), public(b"a@b.c")));
		System::assert_last_event(Event::FieldSet { who: 1, key: email }.into());

		let h = H256::repeat_byte(7);
		let mastodon = FieldKey::Custom(custom(b"mastodon"));
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			mastodon.clone(),
			FieldValue::Private(h)
		));
		System::assert_last_event(Event::FieldSet { who: 1, key: mastodon }.into());

		let identity = Identities::<Test>::get(1).unwrap();
		assert_eq!(identity.typed.get(&FieldKind::Email), Some(&public(b"a@b.c")));
		assert_eq!(identity.custom.get(&custom(b"mastodon")), Some(&FieldValue::Private(h)));
		assert_eq!((identity.created_at, identity.updated_at), (1, 1));
	});
}

#[test]
fn set_field_rejects_invalid_utf8_and_link_keys() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Identitee::set_field(
				RuntimeOrigin::signed(1),
				FieldKey::Typed(FieldKind::Web),
				public(&[0xc3, 0x28])
			),
			Error::<Test>::InvalidUtf8
		);
		assert_noop!(
			Identitee::set_field(
				RuntimeOrigin::signed(1),
				FieldKey::Custom(custom(&[0xff])),
				public(b"x")
			),
			Error::<Test>::InvalidUtf8
		);
		assert_noop!(
			Identitee::set_field(RuntimeOrigin::signed(1), FieldKey::Link(0), public(b"x")),
			Error::<Test>::LinkKeyNotSettable
		);
	});
}

#[test]
fn pgp_field_must_be_20_or_32_bytes() {
	new_test_ext().execute_with(|| {
		let pgp = FieldKey::Typed(FieldKind::Pgp);
		assert_noop!(
			Identitee::set_field(RuntimeOrigin::signed(1), pgp.clone(), public(&[0xff; 19])),
			Error::<Test>::InvalidPgp
		);
		// A fingerprint is raw bytes, not text: non-UTF-8 bytes of the right length pass.
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			pgp.clone(),
			public(&[0xff; 20])
		));
		assert_ok!(Identitee::set_field(RuntimeOrigin::signed(1), pgp, public(&[0xff; 32])));
	});
}

#[test]
fn custom_fields_capped_at_16() {
	new_test_ext().execute_with(|| {
		for i in 0..16u8 {
			let key = FieldKey::Custom(custom(format!("k{i}").as_bytes()));
			assert_ok!(Identitee::set_field(RuntimeOrigin::signed(1), key, public(b"v")));
		}
		// Overwriting an existing key does not count against the cap.
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			FieldKey::Custom(custom(b"k0")),
			public(b"w")
		));
		assert_noop!(
			Identitee::set_field(
				RuntimeOrigin::signed(1),
				FieldKey::Custom(custom(b"k16")),
				public(b"v")
			),
			Error::<Test>::TooManyCustomFields
		);
	});
}

#[test]
fn clear_field_removes_it() {
	new_test_ext().execute_with(|| {
		let email = FieldKey::Typed(FieldKind::Email);
		assert_noop!(
			Identitee::clear_field(RuntimeOrigin::signed(1), email.clone()),
			Error::<Test>::NoIdentity
		);
		assert_ok!(Identitee::set_field(RuntimeOrigin::signed(1), email.clone(), public(b"a@b.c")));
		assert_ok!(Identitee::clear_field(RuntimeOrigin::signed(1), email.clone()));
		System::assert_last_event(Event::FieldCleared { who: 1, key: email }.into());
		assert!(Identities::<Test>::get(1).unwrap().typed.is_empty());
		assert_noop!(
			Identitee::clear_field(RuntimeOrigin::signed(1), FieldKey::Link(0)),
			Error::<Test>::LinkKeyNotSettable
		);
	});
}

#[test]
fn links_crud_and_stable_ids() {
	new_test_ext().execute_with(|| {
		let origin = || RuntimeOrigin::signed(1);
		for (i, t) in [b"a", b"b", b"c"].iter().enumerate() {
			assert_ok!(Identitee::add_link(origin(), title(*t), value(b"https://x")));
			System::assert_last_event(Event::LinkAdded { who: 1, id: i as u32 }.into());
		}
		assert_eq!(link_ids(1), vec![0, 1, 2]);

		assert_ok!(Identitee::remove_link(origin(), 1));
		System::assert_last_event(Event::LinkRemoved { who: 1, id: 1 }.into());
		assert_ok!(Identitee::add_link(origin(), title(b"d"), value(b"https://d")));
		assert_eq!(link_ids(1), vec![0, 2, 3]);

		assert_ok!(Identitee::update_link(origin(), 2, title(b"C"), value(b"https://c")));
		System::assert_last_event(Event::LinkUpdated { who: 1, id: 2 }.into());
		let identity = Identities::<Test>::get(1).unwrap();
		let link = identity.links.iter().find(|link| link.id == 2).unwrap();
		assert_eq!((&link.title, &link.url), (&title(b"C"), &value(b"https://c")));

		assert_ok!(Identitee::reorder_links(origin(), ids(&[3, 0, 2])));
		System::assert_last_event(Event::LinksReordered { who: 1 }.into());
		assert_eq!(link_ids(1), vec![3, 0, 2]);

		assert_noop!(Identitee::remove_link(origin(), 1), Error::<Test>::UnknownLink);
		assert_noop!(
			Identitee::update_link(origin(), 9, title(b"x"), value(b"y")),
			Error::<Test>::UnknownLink
		);
		assert_noop!(
			Identitee::add_link(origin(), title(&[0xc3, 0x28]), value(b"y")),
			Error::<Test>::InvalidUtf8
		);
		assert_noop!(
			Identitee::add_link(origin(), title(b"x"), value(&[0xc3, 0x28])),
			Error::<Test>::InvalidUtf8
		);
	});
}

#[test]
fn links_capped_at_16() {
	new_test_ext().execute_with(|| {
		for _ in 0..16 {
			assert_ok!(Identitee::add_link(RuntimeOrigin::signed(1), title(b"t"), value(b"u")));
		}
		assert_noop!(
			Identitee::add_link(RuntimeOrigin::signed(1), title(b"t"), value(b"u")),
			Error::<Test>::TooManyLinks
		);
	});
}

#[test]
fn reorder_must_be_a_permutation() {
	new_test_ext().execute_with(|| {
		for t in [b"a", b"b", b"c"] {
			assert_ok!(Identitee::add_link(RuntimeOrigin::signed(1), title(t), value(b"u")));
		}
		for bad in [&[0, 0, 2][..], &[0, 1][..], &[0, 1, 2, 3][..], &[0, 1, 5][..]] {
			assert_noop!(
				Identitee::reorder_links(RuntimeOrigin::signed(1), ids(bad)),
				Error::<Test>::InvalidLinkOrder
			);
		}
	});
}

#[test]
fn invalid_avatar_rejected() {
	new_test_ext().execute_with(|| {
		assert_ok!(Identitee::set_bio(
			RuntimeOrigin::signed(1),
			b"hi".to_vec().try_into().unwrap()
		));
		let before = Identities::<Test>::get(1);
		let png = AvatarBytes::try_from(b"\x89PNG\r\n\x1a\n0000000000000000".to_vec()).unwrap();
		assert_noop!(
			Identitee::set_avatar(RuntimeOrigin::signed(1), png),
			Error::<Test>::InvalidAvatar
		);
		assert_eq!(Identities::<Test>::get(1), before);
	});
}

#[test]
fn avatar_set_and_cleared() {
	new_test_ext().execute_with(|| {
		let webp = AvatarBytes::try_from(webp_64()).unwrap();
		assert_ok!(Identitee::set_avatar(RuntimeOrigin::signed(1), webp.clone()));
		System::assert_last_event(Event::AvatarSet { who: 1 }.into());
		assert_eq!(Identities::<Test>::get(1).unwrap().avatar, Some(webp));
		assert_ok!(Identitee::clear_avatar(RuntimeOrigin::signed(1)));
		System::assert_last_event(Event::AvatarCleared { who: 1 }.into());
		assert_eq!(Identities::<Test>::get(1).unwrap().avatar, None);
		assert_noop!(Identitee::clear_avatar(RuntimeOrigin::signed(2)), Error::<Test>::NoIdentity);
	});
}

#[test]
fn reveal_turns_private_into_public() {
	new_test_ext().execute_with(|| {
		let salt = [9u8; 32];
		let key = FieldKey::Typed(FieldKind::Email);
		let h = private_commitment(&salt, b"me@x.org");
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			key.clone(),
			FieldValue::Private(h)
		));
		assert_eq!(commitment(&FieldValue::Private(h)), h);

		assert_ok!(Identitee::reveal_field(
			RuntimeOrigin::signed(1),
			key.clone(),
			value(b"me@x.org"),
			salt
		));
		System::assert_last_event(Event::FieldRevealed { who: 1, key: key.clone() }.into());
		let stored = Identities::<Test>::get(1).unwrap().typed.get(&FieldKind::Email).cloned();
		assert_eq!(stored, Some(public(b"me@x.org")));
		assert_eq!(
			commitment(&public(b"me@x.org")),
			H256(blake2_256(b"identitee:field:public:v1me@x.org"))
		);

		// Already public: nothing to reveal.
		assert_noop!(
			Identitee::reveal_field(RuntimeOrigin::signed(1), key, value(b"me@x.org"), salt),
			Error::<Test>::NotPrivate
		);
	});
}

#[test]
fn reveal_with_wrong_salt_fails() {
	new_test_ext().execute_with(|| {
		let key = FieldKey::Custom(custom(b"mastodon"));
		let h = private_commitment(&[1u8; 32], b"@me@social");
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			key.clone(),
			FieldValue::Private(h)
		));
		assert_noop!(
			Identitee::reveal_field(RuntimeOrigin::signed(1), key, value(b"@me@social"), [2u8; 32]),
			Error::<Test>::RevealMismatch
		);
	});
}

#[test]
fn reveal_checks_the_revealed_value() {
	new_test_ext().execute_with(|| {
		let salt = [3u8; 32];
		let key = FieldKey::Typed(FieldKind::Pgp);
		let short = [0xaa; 19];
		let h = private_commitment(&salt, &short);
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			key.clone(),
			FieldValue::Private(h)
		));
		assert_noop!(
			Identitee::reveal_field(RuntimeOrigin::signed(1), key, value(&short), salt),
			Error::<Test>::InvalidPgp
		);
	});
}

#[test]
fn clear_identity_removes_content_keeps_account() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Identitee::clear_identity(RuntimeOrigin::signed(1)).map_err(|e| e.error),
			Error::<Test>::NoIdentity
		);

		// Account onboarded by a feeless call, as the runtime extension does.
		System::inc_providers(&1);
		Identitee::note_onboarded(&1);
		System::inc_account_nonce(1);
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			FieldKey::Typed(FieldKind::Email),
			public(b"a@b.c")
		));
		assert_ok!(Identitee::add_link(RuntimeOrigin::signed(1), title(b"t"), value(b"u")));

		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(1)));
		System::assert_last_event(Event::IdentityCleared { who: 1 }.into());
		assert!(Identities::<Test>::get(1).is_none());
		// The provider reference stays, so the nonce survives and old feeless
		// transactions cannot be replayed.
		assert!(ProviderHeld::<Test>::contains_key(1));
		assert_eq!(System::providers(&1), 1);
		assert_eq!(System::account_nonce(1), 1);
	});
}

#[test]
fn kill_identity_requires_root() {
	new_test_ext().execute_with(|| {
		System::inc_providers(&1);
		Identitee::note_onboarded(&1);
		assert_ok!(Identitee::add_link(RuntimeOrigin::signed(1), title(b"t"), value(b"u")));

		assert_noop!(
			Identitee::kill_identity(RuntimeOrigin::signed(2), 1).map_err(|e| e.error),
			sp_runtime::DispatchError::BadOrigin
		);
		assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), 1));
		System::assert_last_event(Event::IdentityPurged { who: 1 }.into());
		assert!(Identities::<Test>::get(1).is_none());
		assert!(ProviderHeld::<Test>::contains_key(1));
		assert_eq!(System::providers(&1), 1);

		assert_noop!(
			Identitee::kill_identity(RuntimeOrigin::root(), 1).map_err(|e| e.error),
			Error::<Test>::NoIdentity
		);
	});
}

#[test]
fn user_calls_are_feeless() {
	new_test_ext().execute_with(|| {
		let calls = [
			crate::Call::set_field { key: FieldKey::Typed(FieldKind::Email), value: public(b"x") },
			crate::Call::clear_field { key: FieldKey::Typed(FieldKind::Email) },
			crate::Call::add_link { title: title(b"t"), url: value(b"u") },
			crate::Call::update_link { id: 0, title: title(b"t"), url: value(b"u") },
			crate::Call::remove_link { id: 0 },
			crate::Call::reorder_links { ids: ids(&[]) },
			crate::Call::set_avatar { bytes: AvatarBytes::default() },
			crate::Call::clear_avatar {},
			crate::Call::reveal_field {
				key: FieldKey::Typed(FieldKind::Email),
				value: value(b"x"),
				salt: [0; 32],
			},
			crate::Call::clear_identity {},
		];
		for call in calls {
			assert!(RuntimeCall::Identitee(call).is_feeless(&RuntimeOrigin::signed(1)));
		}
		let purge = RuntimeCall::Identitee(crate::Call::kill_identity { who: 1 });
		assert!(!purge.is_feeless(&RuntimeOrigin::root()));
	});
}

#[test]
fn verifiable_kinds() {
	assert!(!FieldKind::DisplayName.is_verifiable());
	assert!(!FieldKind::LegalName.is_verifiable());
	for kind in [
		FieldKind::Web,
		FieldKind::Email,
		FieldKind::Matrix,
		FieldKind::X,
		FieldKind::Discord,
		FieldKind::GitHub,
		FieldKind::Telegram,
		FieldKind::Pgp,
	] {
		assert!(kind.is_verifiable());
	}
}

// --- set_identity ---

type Change = (FieldKey, Option<FieldValue>);

/// `set_identity` by `who`, as a plain result.
fn batch(who: u64, changes: Vec<Change>) -> frame_support::dispatch::DispatchResult {
	Identitee::set_identity(RuntimeOrigin::signed(who), FieldChanges::try_from(changes).unwrap())
		.map(|_| ())
		.map_err(|e| e.error)
}

/// The events of the pallet since the last reset, in order.
fn pallet_events() -> Vec<RuntimeEvent> {
	System::events().into_iter().map(|record| record.event).collect()
}

#[test]
fn set_fields_sets_and_clears_in_one_call() {
	new_test_ext().execute_with(|| {
		let email = FieldKey::Typed(FieldKind::Email);
		let telegram = FieldKey::Typed(FieldKind::Telegram);
		let github = FieldKey::Typed(FieldKind::GitHub);
		let site = FieldKey::Custom(custom(b"site"));
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			email.clone(),
			public(b"old@b.c")
		));
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			telegram.clone(),
			public(b"@old")
		));
		System::reset_events();

		let h = H256::repeat_byte(7);
		assert_ok!(batch(
			1,
			vec![
				(email.clone(), Some(public(b"new@b.c"))),
				(telegram.clone(), None),
				(site.clone(), Some(FieldValue::Private(h))),
				(github.clone(), Some(public(b"octo"))),
			]
		));

		let identity = Identities::<Test>::get(1).unwrap();
		assert_eq!(identity.typed.get(&FieldKind::Email), Some(&public(b"new@b.c")));
		assert_eq!(identity.typed.get(&FieldKind::Telegram), None);
		assert_eq!(identity.typed.get(&FieldKind::GitHub), Some(&public(b"octo")));
		assert_eq!(identity.custom.get(&custom(b"site")), Some(&FieldValue::Private(h)));
		// The events the single calls emit, one per change, in the order of the changes.
		let expected: Vec<RuntimeEvent> = vec![
			Event::FieldSet { who: 1, key: email }.into(),
			Event::FieldCleared { who: 1, key: telegram }.into(),
			Event::FieldSet { who: 1, key: site }.into(),
			Event::FieldSet { who: 1, key: github }.into(),
		];
		assert_eq!(pallet_events(), expected);
	});
}

#[test]
fn set_fields_creates_the_identity_like_set_field() {
	new_test_ext().execute_with(|| {
		// Clearing a field that is not there succeeds, like `clear_field`, once the identity
		// exists: here an earlier change of the same call created it.
		assert_ok!(batch(
			1,
			vec![
				(FieldKey::Typed(FieldKind::Email), Some(public(b"a@b.c"))),
				(FieldKey::Typed(FieldKind::Telegram), None),
			]
		));
		let identity = Identities::<Test>::get(1).unwrap();
		assert_eq!((identity.created_at, identity.updated_at), (1, 1));
		assert_eq!(identity.typed.len(), 1);

		// But a call that only clears has no identity to clear in, as `clear_field` has not.
		assert_noop!(
			batch(2, vec![(FieldKey::Typed(FieldKind::Email), None)]),
			Error::<Test>::NoIdentity
		);
	});
}

#[test]
fn set_fields_is_all_or_nothing() {
	new_test_ext().execute_with(|| {
		let email = FieldKey::Typed(FieldKind::Email);
		let pgp = FieldKey::Typed(FieldKind::Pgp);
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(1),
			email.clone(),
			public(b"old@b.c")
		));

		// The second change is an invalid fingerprint: the first one is not stored, and nothing
		// else changes (`assert_noop` compares the whole storage), events included.
		assert_noop!(
			batch(
				1,
				vec![
					(email.clone(), Some(public(b"new@b.c"))),
					(pgp.clone(), Some(public(&[0xff; 19]))),
				]
			),
			Error::<Test>::InvalidPgp
		);
		let identity = Identities::<Test>::get(1).unwrap();
		assert_eq!(identity.typed.get(&FieldKind::Email), Some(&public(b"old@b.c")));

		// Without an identity, a failed call does not create one either.
		assert_noop!(
			batch(2, vec![(email, Some(public(b"a@b.c"))), (pgp, Some(public(&[0xff; 19])))]),
			Error::<Test>::InvalidPgp
		);
		assert!(Identities::<Test>::get(2).is_none());
	});
}

#[test]
fn set_fields_rejects_duplicate_keys() {
	new_test_ext().execute_with(|| {
		let email = FieldKey::Typed(FieldKind::Email);
		let site = FieldKey::Custom(custom(b"site"));
		// Twice the same key, whether both set or one set and one cleared, in any order.
		assert_noop!(
			batch(
				1,
				vec![(email.clone(), Some(public(b"a"))), (email.clone(), Some(public(b"b")))]
			),
			Error::<Test>::DuplicateFieldInBatch
		);
		assert_noop!(
			batch(1, vec![(email.clone(), Some(public(b"a"))), (email.clone(), None)]),
			Error::<Test>::DuplicateFieldInBatch
		);
		assert_noop!(
			batch(
				1,
				vec![
					(site.clone(), None),
					(email.clone(), None),
					(site.clone(), Some(public(b"x")))
				]
			),
			Error::<Test>::DuplicateFieldInBatch
		);
		// A typed field and a custom field of the same name are two fields.
		assert_ok!(batch(
			1,
			vec![
				(email, Some(public(b"a"))),
				(FieldKey::Custom(custom(b"Email")), Some(public(b"b")))
			]
		));
	});
}

#[test]
fn set_fields_refuses_link_keys() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			batch(
				1,
				vec![
					(FieldKey::Typed(FieldKind::Email), Some(public(b"a@b.c"))),
					(FieldKey::Link(0), Some(public(b"x")))
				]
			),
			Error::<Test>::LinkKeyNotSettable
		);
		assert_noop!(batch(1, vec![(FieldKey::Link(0), None)]), Error::<Test>::LinkKeyNotSettable);
	});
}

#[test]
fn set_fields_clearing_removes_attestations() {
	let attest = Capabilities::ATTEST_FIELDS.bits();
	let config =
		crate::GenesisConfig::<Test> { authorities: vec![authority("Alpha", &[(10, attest)])] };
	new_test_ext_with(config).execute_with(|| {
		let email = FieldKey::Typed(FieldKind::Email);
		let github = FieldKey::Typed(FieldKind::GitHub);
		for (key, v) in [(&email, &b"a@b.c"[..]), (&github, &b"octo"[..])] {
			assert_ok!(Identitee::set_field(RuntimeOrigin::signed(1), key.clone(), public(v)));
			assert_ok!(Identitee::provide_judgement(
				RuntimeOrigin::signed(10),
				1,
				key.clone(),
				Identitee::current_commitment(&1, key).unwrap(),
				Verdict::Verified,
				Method::Manual,
				None
			));
		}
		assert_eq!(FieldAttestations::<Test>::iter().count(), 2);

		// Clearing the email deletes its attestation, as `clear_field` does; changing the
		// GitHub name leaves its (now stale) attestation, as `set_field` does.
		assert_ok!(batch(1, vec![(email.clone(), None), (github.clone(), Some(public(b"other")))]));
		assert_eq!(FieldAttestations::<Test>::iter_prefix((1, email)).count(), 0);
		assert_eq!(FieldAttestations::<Test>::iter_prefix((1, github)).count(), 1);
	});
}

#[test]
fn set_fields_max_32() {
	new_test_ext().execute_with(|| {
		assert_eq!(MAX_FIELD_CHANGES, 32);
		// 32 different keys: the 10 typed fields, the 16 custom fields an identity can hold, and
		// 6 clears of custom fields that are not there.
		let mut changes: Vec<Change> = [
			FieldKind::DisplayName,
			FieldKind::LegalName,
			FieldKind::Web,
			FieldKind::Email,
			FieldKind::Matrix,
			FieldKind::X,
			FieldKind::Discord,
			FieldKind::GitHub,
			FieldKind::Telegram,
		]
		.into_iter()
		.map(|kind| (FieldKey::Typed(kind), Some(public(b"v"))))
		.collect();
		changes.push((FieldKey::Typed(FieldKind::Pgp), Some(public(&[7; 20]))));
		for i in 0..MAX_CUSTOM_FIELDS {
			changes
				.push((FieldKey::Custom(custom(format!("k{i}").as_bytes())), Some(public(b"v"))));
		}
		for i in 0..6 {
			changes.push((FieldKey::Custom(custom(format!("gone{i}").as_bytes())), None));
		}
		assert_eq!(changes.len(), 32);
		assert_ok!(batch(1, changes.clone()));
		let identity = Identities::<Test>::get(1).unwrap();
		assert_eq!((identity.typed.len(), identity.custom.len()), (10, 16));

		// A 33rd change does not fit the call: neither to build nor to decode from the wire.
		changes.push((FieldKey::Custom(custom(b"one-more")), None));
		assert!(FieldChanges::try_from(changes.clone()).is_err());
		let mut wire = vec![12u8]; // call index of `set_identity`
		wire.extend(changes.encode());
		assert!(crate::Call::<Test>::decode(&mut &wire[..]).is_err());
		changes.pop();
		let mut wire = vec![12u8];
		wire.extend(changes.encode());
		assert_eq!(
			crate::Call::<Test>::decode(&mut &wire[..]).unwrap(),
			crate::Call::set_identity { changes: FieldChanges::try_from(changes).unwrap() }
		);
	});
}
