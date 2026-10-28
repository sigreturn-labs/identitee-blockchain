use crate::{mock::*, Changed, Error, Event, Validators as ValidatorList};
use frame_support::{assert_noop, assert_ok};
use pallet_session::SessionManager;
use pallet_session::{ExternallySetKeys, KeyOwner, NextKeys};
use sp_runtime::{testing::UintAuthorityId, traits::OpaqueKeys, DispatchError, KeyTypeId};

const DUMMY: KeyTypeId = sp_runtime::key_types::DUMMY;

fn session_validators() -> Vec<u64> {
	pallet_session::Validators::<Test>::get()
}

fn owner_of(key: u64) -> Option<u64> {
	KeyOwner::<Test>::get((DUMMY, UintAuthorityId(key).get_raw(DUMMY).to_vec()))
}

fn add(who: u64, key: u64) -> sp_runtime::DispatchResult {
	Validators::add_validator(RuntimeOrigin::root(), who, UintAuthorityId(key))
}

#[test]
fn genesis_validator_is_the_session_set() {
	new_test_ext().execute_with(|| {
		assert_eq!(ValidatorList::<Test>::get().into_inner(), vec![GENESIS_VALIDATOR]);
		assert_eq!(session_validators(), vec![GENESIS_VALIDATOR]);
		assert_eq!(owner_of(1), Some(GENESIS_VALIDATOR));
	});
}

#[test]
fn only_the_manager_adds_and_removes() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Validators::add_validator(RuntimeOrigin::signed(1), 2, UintAuthorityId(2)),
			DispatchError::BadOrigin
		);
		assert_noop!(
			Validators::remove_validator(RuntimeOrigin::signed(1), 1),
			DispatchError::BadOrigin
		);
	});
}

#[test]
fn an_added_validator_validates_from_the_session_after_next() {
	new_test_ext().execute_with(|| {
		// Account 2 holds no balance: the keys need neither a deposit nor a consumer reference.
		assert_ok!(add(2, 2));
		System::assert_last_event(Event::ValidatorAdded { who: 2 }.into());
		assert_eq!(ValidatorList::<Test>::get().into_inner(), vec![1, 2]);
		assert_eq!(NextKeys::<Test>::get(2), Some(UintAuthorityId(2)));
		assert_eq!(owner_of(2), Some(2));
		assert!(ExternallySetKeys::<Test>::contains_key(2));
		assert_eq!(System::consumers(&2), 0);

		next_session();
		assert_eq!(session_validators(), vec![1]);
		next_session();
		assert_eq!(session_validators(), vec![1, 2]);
	});
}

#[test]
fn add_refusals() {
	new_test_ext().execute_with(|| {
		assert_noop!(add(1, 9), Error::<Test>::AlreadyValidator);
		assert_noop!(add(2, 1), Error::<Test>::KeyInUse);
		assert_ok!(add(2, 2));
		assert_ok!(add(3, 3));
		assert_noop!(add(4, 4), Error::<Test>::TooManyValidators);
	});
}

#[test]
fn a_removed_validator_leaves_from_the_session_after_next() {
	new_test_ext().execute_with(|| {
		assert_ok!(add(2, 2));
		next_session();
		next_session();
		assert_eq!(session_validators(), vec![1, 2]);

		assert_ok!(Validators::remove_validator(RuntimeOrigin::root(), 2));
		System::assert_last_event(Event::ValidatorRemoved { who: 2 }.into());
		assert_eq!(ValidatorList::<Test>::get().into_inner(), vec![1]);
		// Its keys stay registered until it purges them.
		assert_eq!(NextKeys::<Test>::get(2), Some(UintAuthorityId(2)));

		next_session();
		assert_eq!(session_validators(), vec![1, 2]);
		next_session();
		assert_eq!(session_validators(), vec![1]);
	});
}

#[test]
fn remove_refusals() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Validators::remove_validator(RuntimeOrigin::root(), 2),
			Error::<Test>::NotValidator
		);
		assert_noop!(
			Validators::remove_validator(RuntimeOrigin::root(), 1),
			Error::<Test>::LastValidator
		);
	});
}

#[test]
fn reassigned_keys_free_the_old_ones() {
	new_test_ext().execute_with(|| {
		assert_ok!(add(2, 2));
		assert_ok!(Validators::assign_keys(&2, UintAuthorityId(5)));
		assert_eq!(owner_of(2), None);
		assert_eq!(owner_of(5), Some(2));
		assert_eq!(NextKeys::<Test>::get(2), Some(UintAuthorityId(5)));
		// Account 3 can now take key 2.
		assert_ok!(add(3, 2));
	});
}

#[test]
fn session_is_handed_the_list_only_after_a_change() {
	new_test_ext().execute_with(|| {
		assert_eq!(Validators::new_session(2), None);
		assert_ok!(add(2, 2));
		assert!(Changed::<Test>::get());
		assert_eq!(Validators::new_session(3), Some(vec![1, 2]));
		assert_eq!(Validators::new_session(4), None);
		assert_ok!(Validators::remove_validator(RuntimeOrigin::root(), 2));
		assert_eq!(Validators::new_session(5), Some(vec![1]));
	});
}
