use crate::{mock::*, types::Bio, Error, Event, Identities, ProviderHeld};
use frame_support::{
	assert_noop, assert_ok,
	dispatch::{CheckIfFeeless, GetDispatchInfo},
};

fn bio(bytes: &[u8]) -> Bio {
	Bio::try_from(bytes.to_vec()).unwrap()
}

#[test]
fn set_bio_creates_then_updates_identity() {
	new_test_ext().execute_with(|| {
		assert_ok!(Identitee::set_bio(RuntimeOrigin::signed(1), bio(b"hello")));
		let identity = Identities::<Test>::get(1).unwrap();
		assert_eq!(identity.bio, bio(b"hello"));
		assert_eq!((identity.created_at, identity.updated_at), (1, 1));
		System::assert_last_event(Event::BioSet { who: 1 }.into());

		System::set_block_number(5);
		assert_ok!(Identitee::set_bio(RuntimeOrigin::signed(1), bio("été".as_bytes())));
		let identity = Identities::<Test>::get(1).unwrap();
		assert_eq!(identity.bio, bio("été".as_bytes()));
		assert_eq!((identity.created_at, identity.updated_at), (1, 5));
	});
}

#[test]
fn set_bio_rejects_invalid_utf8() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Identitee::set_bio(RuntimeOrigin::signed(1), bio(&[0xc3, 0x28])),
			Error::<Test>::InvalidUtf8
		);
		assert!(Identities::<Test>::get(1).is_none());
	});
}

#[test]
fn set_bio_requires_signed_origin() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Identitee::set_bio(RuntimeOrigin::root(), bio(b"x")),
			sp_runtime::DispatchError::BadOrigin
		);
	});
}

#[test]
fn set_bio_is_feeless() {
	new_test_ext().execute_with(|| {
		let call = RuntimeCall::Identitee(crate::Call::set_bio { bio: bio(b"x") });
		assert!(call.is_feeless(&RuntimeOrigin::signed(1)));
		assert!(call.get_dispatch_info().call_weight.ref_time() > 0);
	});
}

#[test]
fn bio_bound_is_max_bio_len() {
	let max = crate::limits::MAX_BIO_LEN as usize;
	assert!(Bio::try_from(vec![b'a'; max]).is_ok());
	assert!(Bio::try_from(vec![b'a'; max + 1]).is_err());
}

#[test]
fn note_onboarded_records_provider_held() {
	new_test_ext().execute_with(|| {
		assert!(!ProviderHeld::<Test>::contains_key(7));
		Identitee::note_onboarded(&7);
		assert!(ProviderHeld::<Test>::contains_key(7));
	});
}
