//! The on-chain slot for the encrypted identity secret: opaque bytes the chain stores for the
//! account and never interprets.

use crate::{
	limits::MAX_SECRET_BLOB_LEN,
	mock::*,
	types::{FieldKey, FieldKind, FieldValue, SecretBlob, Value},
	Error, Event, Identities, IdentitySecrets, Usage,
};
use codec::{Decode, Encode};
use frame_support::{assert_noop, assert_ok, dispatch::CheckIfFeeless};

const USER: u64 = 1;
const OTHER: u64 = 2;

fn blob(bytes: &[u8]) -> SecretBlob {
	SecretBlob::try_from(bytes.to_vec()).unwrap()
}

fn set(who: u64, bytes: &[u8]) -> frame_support::dispatch::DispatchResult {
	Identitee::set_identity_secret(RuntimeOrigin::signed(who), blob(bytes))
}

fn put_email(who: u64) {
	let value = FieldValue::Public(Value::try_from(b"a@x.org".to_vec()).unwrap());
	assert_ok!(Identitee::set_field(
		RuntimeOrigin::signed(who),
		FieldKey::Typed(FieldKind::Email),
		value
	));
}

#[test]
fn set_overwrite_and_clear() {
	new_test_ext().execute_with(|| {
		assert_eq!(MAX_SECRET_BLOB_LEN, 256);
		assert_eq!(Identitee::identity_secret(&USER), None);

		assert_ok!(set(USER, b"first"));
		System::assert_last_event(Event::IdentitySecretSet { who: USER }.into());
		assert_eq!(Identitee::identity_secret(&USER), Some(b"first".to_vec()));
		assert_eq!(IdentitySecrets::<Test>::get(USER), Some(blob(b"first")));

		// Overwriting replaces the whole blob; other accounts are not touched.
		assert_ok!(set(OTHER, b"other"));
		assert_ok!(set(USER, b"second, longer"));
		assert_eq!(Identitee::identity_secret(&USER), Some(b"second, longer".to_vec()));
		assert_eq!(Identitee::identity_secret(&OTHER), Some(b"other".to_vec()));

		assert_ok!(Identitee::clear_identity_secret(RuntimeOrigin::signed(USER)));
		System::assert_last_event(Event::IdentitySecretCleared { who: USER }.into());
		assert_eq!(Identitee::identity_secret(&USER), None);
		assert!(!IdentitySecrets::<Test>::contains_key(USER));
		assert_eq!(Identitee::identity_secret(&OTHER), Some(b"other".to_vec()));

		// Clearing again succeeds, like clearing a field that is not there.
		assert_ok!(Identitee::clear_identity_secret(RuntimeOrigin::signed(USER)));
		System::assert_last_event(Event::IdentitySecretCleared { who: USER }.into());
	});
}

#[test]
fn events_carry_no_blob() {
	new_test_ext().execute_with(|| {
		assert_ok!(set(USER, b"super secret ciphertext"));
		let event = System::events().pop().expect("an event").event;
		// The event is exactly `IdentitySecretSet { who }`: no byte of the blob is in it.
		assert_eq!(event, Event::<Test>::IdentitySecretSet { who: USER }.into());
		assert!(!event.encode().windows(5).any(|w| w == b"super"));
	});
}

#[test]
fn an_empty_blob_is_refused() {
	new_test_ext().execute_with(|| {
		assert_noop!(set(USER, b""), Error::<Test>::EmptySecretBlob);
		assert_eq!(Identitee::identity_secret(&USER), None);

		// Nor does it erase an existing secret: clearing is its own call.
		assert_ok!(set(USER, b"kept"));
		assert_noop!(set(USER, b""), Error::<Test>::EmptySecretBlob);
		assert_eq!(Identitee::identity_secret(&USER), Some(b"kept".to_vec()));
	});
}

#[test]
fn more_than_256_bytes_do_not_fit_the_call() {
	new_test_ext().execute_with(|| {
		assert!(SecretBlob::try_from(vec![7u8; 257]).is_err());
		let longest = vec![7u8; 256];
		assert_ok!(set(USER, &longest));
		assert_eq!(Identitee::identity_secret(&USER), Some(longest.clone()));

		// A 257th byte is refused when the call is decoded, before it can be dispatched.
		let mut wire = vec![13u8]; // call index of `set_identity_secret`
		wire.extend(vec![7u8; 257].encode());
		assert!(crate::Call::<Test>::decode(&mut &wire[..]).is_err());
		let mut wire = vec![13u8];
		wire.extend(longest.encode());
		assert_eq!(
			crate::Call::<Test>::decode(&mut &wire[..]).unwrap(),
			crate::Call::set_identity_secret { blob: blob(&[7u8; 256]) }
		);
		// And the clearing call sits at the next index.
		assert_eq!(
			crate::Call::<Test>::decode(&mut &[14u8][..]).unwrap(),
			crate::Call::clear_identity_secret {}
		);
	});
}

#[test]
fn it_does_not_need_an_identity() {
	new_test_ext().execute_with(|| {
		assert_ok!(set(USER, b"first"));
		assert!(Identities::<Test>::get(USER).is_none());
		assert_ok!(Identitee::clear_identity_secret(RuntimeOrigin::signed(USER)));
		assert!(Identities::<Test>::get(USER).is_none());
	});
}

#[test]
fn only_a_signed_origin_can_write_it() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Identitee::set_identity_secret(RuntimeOrigin::root(), blob(b"x")),
			sp_runtime::DispatchError::BadOrigin
		);
		assert_noop!(
			Identitee::clear_identity_secret(RuntimeOrigin::none()),
			sp_runtime::DispatchError::BadOrigin
		);
	});
}

#[test]
fn clear_identity_keeps_it_but_a_purge_removes_it() {
	new_test_ext().execute_with(|| {
		put_email(USER);
		assert_ok!(set(USER, b"salts"));

		// The secret belongs to the account, not to the profile: the person may re-create the
		// fields later with the same salts.
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert!(Identities::<Test>::get(USER).is_none());
		assert_eq!(Identitee::identity_secret(&USER), Some(b"salts".to_vec()));

		// A purge by the authority origin deletes it with the rest.
		put_email(USER);
		put_email(OTHER);
		assert_ok!(set(OTHER, b"theirs"));
		assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), USER));
		assert_eq!(Identitee::identity_secret(&USER), None);
		assert!(!IdentitySecrets::<Test>::contains_key(USER));
		// Only the purged account's.
		assert_eq!(Identitee::identity_secret(&OTHER), Some(b"theirs".to_vec()));
	});
}

#[test]
fn both_calls_are_feeless_user_calls_that_count_against_the_quota() {
	new_test_ext().execute_with(|| {
		let calls = [
			crate::Call::<Test>::set_identity_secret { blob: blob(b"x") },
			crate::Call::<Test>::clear_identity_secret {},
		];
		for call in calls {
			assert!(call.counts_against_quota(), "{call:?}");
			assert!(RuntimeCall::Identitee(call.clone()).is_feeless(&RuntimeOrigin::signed(USER)));
			assert!(!RuntimeCall::Identitee(call.clone()).is_feeless(&RuntimeOrigin::root()));
		}
		// Dispatch records nothing: the transaction extension does, once per transaction.
		assert_ok!(set(USER, b"x"));
		assert_eq!(Usage::<Test>::get(USER), None);
		// With the quota used up, the call is no longer feeless.
		for _ in 0..crate::limits::QUOTA_PER_WINDOW {
			Identitee::note_usage(&USER);
		}
		let call = crate::Call::<Test>::set_identity_secret { blob: blob(b"x") };
		assert!(!RuntimeCall::Identitee(call).is_feeless(&RuntimeOrigin::signed(USER)));
	});
}
