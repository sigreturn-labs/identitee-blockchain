//! # Validators pallet
//!
//! The validator set of the chain, managed by `Config::ManagerOrigin` (root on the runtime) and
//! handed to `pallet_session` as its `SessionManager`. Session then gives Aura and GRANDPA the
//! keys of the validators at each session change, so a validator added or removed here produces
//! blocks and votes from the session after next.
//!
//! A validator is an account. [`Pallet::add_validator`] takes its session keys along with it:
//! the operator registers a validator from the two public keys its node generated, without a
//! proof of ownership, and the account needs no balance. The validator may later rotate its keys
//! itself with `session.set_keys`. Removing a validator leaves its keys registered; it can clear
//! them with `session.purge_keys`.
//!
//! The last validator cannot be removed. Session skips the validators without keys, so a
//! validator purging its keys stops validating like one removed.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

pub mod weights;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub use weights::WeightInfo;

#[frame_support::pallet]
pub mod pallet {
	use super::WeightInfo;
	use alloc::vec::Vec;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;
	use pallet_session::SessionManager;
	use sp_runtime::traits::OpaqueKeys;

	/// The session keys of a validator.
	pub type KeysOf<T> = <T as pallet_session::Config>::Keys;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config:
		frame_system::Config
		+ pallet_session::Config<ValidatorId = <Self as frame_system::Config>::AccountId>
	{
		/// The overarching event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// Weight information for the calls of this pallet.
		type WeightInfo: WeightInfo;
		/// Origin allowed to add and remove validators.
		type ManagerOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// Maximum number of validators (the Aura and GRANDPA authority limit).
		#[pallet::constant]
		type MaxValidators: Get<u32>;
	}

	/// The validators, in the order they were added.
	#[pallet::storage]
	pub type Validators<T: Config> =
		StorageValue<_, BoundedVec<T::AccountId, T::MaxValidators>, ValueQuery>;

	/// Whether the list changed since session last took it. Session is handed the list only then:
	/// handing it an unchanged list would still make GRANDPA start a new authority set.
	#[pallet::storage]
	pub type Changed<T: Config> = StorageValue<_, bool, ValueQuery>;

	#[pallet::genesis_config]
	#[derive(frame_support::DefaultNoBound)]
	pub struct GenesisConfig<T: Config> {
		/// The validators at genesis. Their keys go in the session genesis config.
		pub validators: Vec<T::AccountId>,
	}

	#[pallet::genesis_build]
	impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
		fn build(&self) {
			let validators: BoundedVec<_, _> =
				self.validators.clone().try_into().expect("genesis validators within the limit");
			Validators::<T>::put(validators);
		}
	}

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A validator was added, with its session keys. It validates from the session after
		/// next.
		ValidatorAdded { who: T::AccountId },
		/// A validator was removed. It stops validating from the session after next.
		ValidatorRemoved { who: T::AccountId },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The account is already a validator.
		AlreadyValidator,
		/// The account is not a validator.
		NotValidator,
		/// The validator set is full.
		TooManyValidators,
		/// The last validator cannot be removed: the chain would stop.
		LastValidator,
		/// One of the keys is already registered to another account.
		KeyInUse,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Add `who` as a validator, with the session keys of its node.
		#[pallet::call_index(0)]
		#[pallet::weight(<T as Config>::WeightInfo::add_validator(
			<KeysOf<T> as OpaqueKeys>::key_ids().len() as u32
		))]
		pub fn add_validator(
			origin: OriginFor<T>,
			who: T::AccountId,
			keys: KeysOf<T>,
		) -> DispatchResult {
			T::ManagerOrigin::ensure_origin(origin)?;
			let mut validators = Validators::<T>::get();
			ensure!(!validators.contains(&who), Error::<T>::AlreadyValidator);
			validators.try_push(who.clone()).map_err(|_| Error::<T>::TooManyValidators)?;
			Self::assign_keys(&who, keys)?;
			Validators::<T>::put(validators);
			Changed::<T>::put(true);
			Self::deposit_event(Event::ValidatorAdded { who });
			Ok(())
		}

		/// Remove `who` from the validators. Its session keys stay registered.
		#[pallet::call_index(1)]
		#[pallet::weight(<T as Config>::WeightInfo::remove_validator())]
		pub fn remove_validator(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::ManagerOrigin::ensure_origin(origin)?;
			let mut validators = Validators::<T>::get();
			let index =
				validators.iter().position(|v| v == &who).ok_or(Error::<T>::NotValidator)?;
			ensure!(validators.len() > 1, Error::<T>::LastValidator);
			validators.remove(index);
			Validators::<T>::put(validators);
			Changed::<T>::put(true);
			Self::deposit_event(Event::ValidatorRemoved { who });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		/// Register `keys` as the next session keys of `who`, as `session.set_keys` does but
		/// without a proof of ownership, a deposit or a consumer reference: the keys are marked as
		/// set from outside the session pallet (`ExternallySetKeys`), which is what session expects
		/// from privileged callers. Fails with `KeyInUse` if another account holds one of the keys.
		pub fn assign_keys(who: &T::AccountId, keys: KeysOf<T>) -> DispatchResult {
			let old = pallet_session::NextKeys::<T>::get(who);
			for id in <KeysOf<T> as OpaqueKeys>::key_ids() {
				let owner = pallet_session::KeyOwner::<T>::get((*id, keys.get_raw(*id).to_vec()));
				ensure!(owner.map_or(true, |owner| &owner == who), Error::<T>::KeyInUse);
			}
			for id in <KeysOf<T> as OpaqueKeys>::key_ids() {
				let key = keys.get_raw(*id);
				if let Some(old) = &old {
					let old_key = old.get_raw(*id);
					if old_key == key {
						continue;
					}
					pallet_session::KeyOwner::<T>::remove((*id, old_key.to_vec()));
				}
				pallet_session::KeyOwner::<T>::insert((*id, key.to_vec()), who);
			}
			if old.is_none() {
				pallet_session::ExternallySetKeys::<T>::insert(who, ());
			}
			pallet_session::NextKeys::<T>::insert(who, keys);
			Ok(())
		}
	}

	impl<T: Config> SessionManager<T::AccountId> for Pallet<T> {
		/// The validators of the session after next, if the list changed; `None` keeps the set.
		fn new_session(_: u32) -> Option<Vec<T::AccountId>> {
			Changed::<T>::take().then(|| Validators::<T>::get().into_inner())
		}

		fn new_session_genesis(_: u32) -> Option<Vec<T::AccountId>> {
			Some(Validators::<T>::get().into_inner())
		}

		fn end_session(_: u32) {}

		fn start_session(_: u32) {}
	}
}
