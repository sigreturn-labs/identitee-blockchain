//! Native names: one per identity, claimed by the owner, reserved and assigned by authorities.
//!
//! A name is a short handle (see [`crate::validate::validate_name`]) that resolves to one
//! account ([`Pallet::resolve`]). `NameOwner` and `NameOf` are the two directions of the same
//! relation, and always agree.
//!
//! - **Claiming** needs an identity with a field that has a valid `Verified` attestation from any
//!   authority and no valid `Rejected` one (a rejected field counts as not verified, as for the
//!   trust level). Names are not transferable.
//! - **Fraud**: an identity about which any authority has an active `Fraud` fact cannot claim a
//!   name (its trust level is `Fraudulent`). A manager can still assign one.
//! - **Keeping**: the attestation is only looked at when the name is claimed. If it stops being
//!   valid later (field changed, attestation revoked or expired), the name stays; only a manager
//!   takes it away ([`Pallet::do_unbind_username`]).
//! - **Managers**: reserving, assigning and revoking are for `Config::AuthorityOrigin` (Root) or an
//!   agent of an active authority holding `MANAGE_NAMES` ([`Pallet::ensure_names_manager`]). Only
//!   the agent path is feeless.
//! - **Reserving**: a manager reserves names (system words, famous brands) so nobody can claim
//!   them. It assigns a reserved name to someone after checking them, which goes past the
//!   reservation and the attestation requirement but not the quarantine. A reserved name is never
//!   owned.
//! - **Quarantine**: a name that leaves its owner (released, revoked, or the identity cleared)
//!   cannot be claimed or assigned again for `Config::NameQuarantine` blocks, the former owner
//!   included. It is claimable from block `until` on, where `until` is the block of the release
//!   plus the quarantine. A quarantine that has ended is deleted lazily, when the name is next
//!   claimed or assigned.
//! - **Cooldown**: after a voluntary `release_username`, the account cannot claim a name for
//!   `Config::QuotaWindow` blocks (`LastRelease`). Claiming and releasing in a loop would otherwise
//!   freeze one name per cycle in quarantine. Assigning ignores it, and so do a revocation and the
//!   clearing of the identity, which do not set it.
//!
//! `claim_username` is free for the caller and its worst case is large (a scan of every attestation
//! of the identity), so it reports the weight it actually used, like the calls that clear an
//! identity (see [`crate::WeightInfo`]).

use crate::{
	types::{Capabilities, FactKind, Identity, Name, ReasonCode},
	validate::{self, NameError},
	Config, Error, Event, Facts, Identities, LastRelease, NameOf, NameOwner, NextAuthorityId,
	Pallet, Quarantine, Reserved, WeightInfo,
};
use frame_support::{
	dispatch::{DispatchResult, DispatchResultWithPostInfo},
	ensure,
	traits::{EnsureOrigin, Get},
};
use frame_system::{
	ensure_signed,
	pallet_prelude::{BlockNumberFor, OriginFor},
};
use sp_runtime::Saturating;

impl<T: Config> Pallet<T> {
	/// The account that owns `name`, if any.
	pub fn resolve(name: &Name) -> Option<T::AccountId> {
		NameOwner::<T>::get(name)
	}

	/// Check that `origin` may manage names: `Config::AuthorityOrigin` (Root), or an agent of an
	/// active authority holding `MANAGE_NAMES`.
	pub(crate) fn ensure_names_manager(origin: OriginFor<T>) -> DispatchResult {
		let origin = match T::AuthorityOrigin::try_origin(origin) {
			Ok(_) => return Ok(()),
			Err(origin) => origin,
		};
		let agent = ensure_signed(origin)?;
		Self::ensure_agent(&agent, Capabilities::MANAGE_NAMES)?;
		Ok(())
	}

	/// Give `name` to `who`, who must be able to claim it. Reports the weight it used: little
	/// when it fails early, in proportion to the attestations read when it searches for a
	/// verified field.
	pub(crate) fn do_claim_username(who: &T::AccountId, name: Name) -> DispatchResultWithPostInfo {
		let early = |error: Error<T>| Self::failed(T::WeightInfo::claim_username_early(), error);
		let checked =
			|error: Error<T>| Self::failed(T::WeightInfo::claim_username_actual(0, false), error);

		Self::check_name(&name).map_err(early)?;
		ensure!(!NameOf::<T>::contains_key(who), early(Error::<T>::AlreadyHasName));
		Self::ensure_not_cooling_down(who).map_err(early)?;
		let identity = Identities::<T>::get(who).ok_or_else(|| checked(Error::<T>::NoIdentity))?;
		ensure!(!NameOwner::<T>::contains_key(&name), checked(Error::<T>::NameTaken));
		ensure!(!Reserved::<T>::contains_key(&name), checked(Error::<T>::NameIsReserved));
		Self::ensure_out_of_quarantine(&name).map_err(checked)?;
		ensure!(!Self::fraud_flagged(who), checked(Error::<T>::FraudFlagged));
		// The most expensive check comes last.
		let (found, scan_reads) = Self::has_verified_field(who, &identity);
		ensure!(
			found,
			Self::failed(
				T::WeightInfo::claim_username_actual(scan_reads, false),
				Error::<T>::NoVerifiedField
			)
		);
		LastRelease::<T>::remove(who);
		Self::bind_name(who, &name);
		Self::deposit_event(Event::NameClaimed { who: who.clone(), name });
		Ok(Self::used(T::WeightInfo::claim_username_actual(scan_reads, true)))
	}

	/// Whether an authority has an active `Fraud` fact about `who`. Reads the id counter, then
	/// one fact per authority ever registered (at most [`crate::limits::MAX_AUTHORITIES`]).
	fn fraud_flagged(who: &T::AccountId) -> bool {
		let now = frame_system::Pallet::<T>::block_number();
		(0..NextAuthorityId::<T>::get()).any(|authority| {
			Facts::<T>::get(who, (FactKind::Fraud, authority))
				.is_some_and(|fact| Self::fact_is_active(&fact, now))
		})
	}

	/// Give up the name of `who`. A voluntary release starts the cooldown of the account: it
	/// cannot claim a name again for `Config::QuotaWindow` blocks, so that claim and release in
	/// a loop cannot hold many names in quarantine at once.
	pub(crate) fn do_release_username(who: &T::AccountId) -> DispatchResult {
		let name = Self::unbind_name(who).ok_or(Error::<T>::NoName)?;
		LastRelease::<T>::insert(who, frame_system::Pallet::<T>::block_number());
		Self::deposit_event(Event::NameReleased { who: who.clone(), name });
		Ok(())
	}

	/// Reserve `name`.
	pub(crate) fn do_reserve_username(name: Name) -> DispatchResult {
		Self::check_name(&name)?;
		ensure!(!NameOwner::<T>::contains_key(&name), Error::<T>::NameTaken);
		ensure!(!Reserved::<T>::contains_key(&name), Error::<T>::AlreadyReserved);
		Reserved::<T>::insert(&name, ());
		Self::deposit_event(Event::NameReserved { name });
		Ok(())
	}

	/// Lift the reservation of `name`.
	pub(crate) fn do_unreserve_username(name: Name) -> DispatchResult {
		Reserved::<T>::take(&name).ok_or(Error::<T>::NotReserved)?;
		Self::deposit_event(Event::NameUnreserved { name });
		Ok(())
	}

	/// Give `name` to `who`, which needs an identity and no name. Consumes the reservation of
	/// `name`. Looks at no attestation, at no cooldown, and does not override the quarantine.
	pub(crate) fn do_set_username_for(who: T::AccountId, name: Name) -> DispatchResult {
		Self::check_name(&name)?;
		ensure!(Identities::<T>::contains_key(&who), Error::<T>::NoIdentity);
		ensure!(!NameOf::<T>::contains_key(&who), Error::<T>::AlreadyHasName);
		ensure!(!NameOwner::<T>::contains_key(&name), Error::<T>::NameTaken);
		Self::ensure_out_of_quarantine(&name)?;
		Reserved::<T>::remove(&name);
		Self::bind_name(&who, &name);
		Self::deposit_event(Event::NameAssigned { who, name });
		Ok(())
	}

	/// Take the name of `who` away, into quarantine. Not a voluntary release: no cooldown.
	pub(crate) fn do_unbind_username(who: T::AccountId, reason: ReasonCode) -> DispatchResult {
		let name = Self::unbind_name(&who).ok_or(Error::<T>::NoName)?;
		Self::deposit_event(Event::NameRevoked { who, name, reason });
		Ok(())
	}

	/// Run when the identity of `who` is cleared: its name, if any, goes into quarantine. Not a
	/// voluntary release: no cooldown. Whether there was a name.
	pub(crate) fn release_name_on_identity_cleared(who: &T::AccountId) -> bool {
		let Some(name) = Self::unbind_name(who) else { return false };
		Self::deposit_event(Event::NameReleased { who: who.clone(), name });
		true
	}

	/// A name that is valid, with the error that says why not.
	fn check_name(name: &Name) -> Result<(), Error<T>> {
		validate::validate_name(name).map_err(|error| match error {
			NameError::TooShort => Error::<T>::NameTooShort,
			NameError::TooLong => Error::<T>::NameTooLong,
			NameError::InvalidChar => Error::<T>::NameInvalidChar,
		})
	}

	/// The account did not release a name of its own accord less than `Config::QuotaWindow`
	/// blocks ago.
	fn ensure_not_cooling_down(who: &T::AccountId) -> Result<(), Error<T>> {
		if let Some(released) = LastRelease::<T>::get(who) {
			let now = frame_system::Pallet::<T>::block_number();
			ensure!(
				now >= released.saturating_add(T::QuotaWindow::get()),
				Error::<T>::ClaimCooldown
			);
		}
		Ok(())
	}

	/// The name is not in quarantine: it never was, or the quarantine has ended.
	fn ensure_out_of_quarantine(name: &Name) -> Result<(), Error<T>> {
		if let Some(until) = Quarantine::<T>::get(name) {
			let now = frame_system::Pallet::<T>::block_number();
			ensure!(now >= until, Error::<T>::NameInQuarantine);
		}
		Ok(())
	}

	/// Whether some field of `identity` (the identity of `who`) is verified: a valid `Verified`
	/// attestation and no valid `Rejected` one; and the storage reads it took to find out. It
	/// stops at the first verified field, otherwise looks at every field.
	fn has_verified_field(
		who: &T::AccountId,
		identity: &Identity<BlockNumberFor<T>>,
	) -> (bool, u32) {
		let now = frame_system::Pallet::<T>::block_number();
		let mut reads = 0u32;
		let found = crate::trust::field_keys(identity).any(|key| {
			let verdicts = Self::field_verdicts(who, identity, &key, now);
			// Every attestation of the field, then the lookup that finds there is no more.
			reads = reads.saturating_add(verdicts.attestations).saturating_add(1);
			verdicts.verified && !verdicts.rejected
		});
		(found, reads)
	}

	/// Make `name` the name of `who`. The caller has checked that both are free; a quarantine
	/// that has ended is deleted.
	fn bind_name(who: &T::AccountId, name: &Name) {
		Quarantine::<T>::remove(name);
		NameOwner::<T>::insert(name, who);
		NameOf::<T>::insert(who, name);
	}

	/// Take the name of `who` away and put it in quarantine; the name, if `who` had one.
	fn unbind_name(who: &T::AccountId) -> Option<Name> {
		let name = NameOf::<T>::take(who)?;
		NameOwner::<T>::remove(&name);
		let now = frame_system::Pallet::<T>::block_number();
		Quarantine::<T>::insert(&name, now.saturating_add(T::NameQuarantine::get()));
		Some(name)
	}
}
